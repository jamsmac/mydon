import { constants, publicEncrypt } from "node:crypto";

/**
 * ourvend — коннектор к кабинету Ourvend (os.ourvend.com) для модуля вендинга.
 *
 * Переносит логику боевого bash-скрипта: RSA-логин (§3.1 ТЗ), сбор автоматов,
 * состояния слотов (планограмма + остатки), продаж (§3.2). Изолирован за
 * интерфейсом `VendingConnector` — остальной код не знает о вендоре. Ошибки
 * типизированы (`AuthError`/`ShapeError`/`NetworkError`), чтобы различать их в
 * алертах. Разбор ответов — чистые функции, тестируемые на сохранённых ответах.
 *
 * ВАЖНО: все числовые поля `Si*` вендор отдаёт СТРОКАМИ («"6"», «"48000.00"»);
 * здесь приводим к числам. Пароль и группа — из окружения, не из кода.
 */

export const OURVEND_BASE = "https://os.ourvend.com";

// ── Сырые типы ответов вендора ──────────────────────────────────────────────

export interface RawMachine {
  /** MuMachineID — серийный номер автомата. */
  serial: string;
  /** MiAlias — человеческое имя (или = serial, если не задано). */
  alias: string;
}

export interface RawSlot {
  /** SiCoilId — номер слота (пружины). */
  coilId: string;
  /** PrName — имя товара; пусто → слот не назначен. */
  product: string;
  /** SiCapacity — вместимость (приходит строкой). */
  capacity: number;
  /** SiExtantQuantity — остаток (приходит строкой). */
  quantity: number;
}

export interface RawProductSale {
  /** PrName. Одно имя встречается в нескольких строках — суммировать downstream! */
  product: string;
  /** SaleNum — число (не строка). */
  saleNum: number;
}

export interface RawMachineSale {
  serial: string;
  /** TotalAmount — приходит строкой «48000.00». */
  totalAmount: number;
  totalCount: number;
}

// ── Типизированные ошибки ───────────────────────────────────────────────────

export class OurvendError extends Error {
  constructor(
    message: string,
    readonly detail?: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}
/** Не удался вход (неверный пароль, блокировка, смена ключа). */
export class AuthError extends OurvendError {}
/** Ответ вендора неожиданной структуры (сменился API, не-JSON, редирект). */
export class ShapeError extends OurvendError {}
/** Сетевой сбой/таймаут. */
export class NetworkError extends OurvendError {}

// ── Чистые помощники разбора (тестируемы на фикстурах §В) ────────────────────

/** Число из строкового/числового поля вендора. Мусор → 0. */
export function coerceNum(v: unknown): number {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  if (typeof v === "string") {
    const n = Number(v.trim());
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

/** Собрать валидный PEM из «голого» base64-ключа (§3.1): строки по 64 символа. */
export function buildPem(rawKey: string): string {
  const body = rawKey.trim().replace(/\s+/g, "");
  const lines = body.match(/.{1,64}/g)?.join("\n") ?? body;
  return `-----BEGIN PUBLIC KEY-----\n${lines}\n-----END PUBLIC KEY-----`;
}

/** Зашифровать пароль RSA/PKCS#1 v1.5 → base64 (для тела логина). */
export function encryptPassword(rawKey: string, password: string): string {
  const pem = buildPem(rawKey);
  return publicEncrypt({ key: pem, padding: constants.RSA_PKCS1_PADDING }, Buffer.from(password)).toString("base64");
}

/** §3.2.1: список автоматов. Нет ни одного MuMachineID → ShapeError. */
export function parseMachines(json: unknown): RawMachine[] {
  if (!Array.isArray(json)) throw new ShapeError("Список автоматов: ожидался массив");
  const out: RawMachine[] = [];
  for (const m of json) {
    const o = (m ?? {}) as Record<string, unknown>;
    const serial = typeof o.MuMachineID === "string" ? o.MuMachineID : "";
    if (!serial) continue;
    const alias = typeof o.MiAlias === "string" && o.MiAlias.length > 0 ? o.MiAlias : serial;
    out.push({ serial, alias });
  }
  if (out.length === 0) throw new ShapeError("В ответе нет ни одного MuMachineID — сбор не удался");
  return out;
}

/**
 * §3.2.2: состояние слотов. Полезные данные во ВТОРОМ элементе (`response[1]`).
 * Первый — список кабинетов (обычно пустой). Иная структура → нет данных, не
 * падаем (возвращаем []): автомат без планограммы это нормальная ситуация.
 */
export function parseSlots(json: unknown): RawSlot[] {
  if (!Array.isArray(json) || json.length < 2 || !Array.isArray(json[1])) return [];
  const out: RawSlot[] = [];
  for (const s of json[1] as unknown[]) {
    const o = (s ?? {}) as Record<string, unknown>;
    const coilId = o.SiCoilId != null ? String(o.SiCoilId) : "";
    if (!coilId) continue;
    out.push({
      coilId,
      product: typeof o.PrName === "string" ? o.PrName : "",
      capacity: coerceNum(o.SiCapacity),
      quantity: coerceNum(o.SiExtantQuantity),
    });
  }
  return out;
}

/**
 * §3.2.3: продажи по товарам. Возвращаем СЫРЫЕ строки (одно имя бывает в
 * нескольких) — суммировать по имени обязан потребитель, иначе теряются продажи.
 */
export function parseProductSales(json: unknown): RawProductSale[] {
  const rows = (json as { rows?: unknown } | null)?.rows;
  if (!Array.isArray(rows)) return [];
  const out: RawProductSale[] = [];
  for (const r of rows) {
    const o = (r ?? {}) as Record<string, unknown>;
    const product = typeof o.PrName === "string" ? o.PrName : "";
    if (!product) continue;
    out.push({ product, saleNum: coerceNum(o.SaleNum) });
  }
  return out;
}

/** §3.2.4: продажи по автоматам (деньги/чеки). */
export function parseMachineSales(json: unknown): RawMachineSale[] {
  const rows = (json as { rows?: unknown } | null)?.rows;
  if (!Array.isArray(rows)) return [];
  const out: RawMachineSale[] = [];
  for (const r of rows) {
    const o = (r ?? {}) as Record<string, unknown>;
    const serial = o.MachineID != null ? String(o.MachineID) : "";
    if (!serial) continue;
    out.push({ serial, totalAmount: coerceNum(o.TotalAmount), totalCount: coerceNum(o.TotalCount) });
  }
  return out;
}

/** Свернуть сырые продажи по товарам в сумму по имени (§3.2.3: суммировать!). */
export function sumProductSales(rows: RawProductSale[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of rows) m.set(r.product, (m.get(r.product) ?? 0) + r.saleNum);
  return m;
}

// ── Интерфейс коннектора ────────────────────────────────────────────────────

export interface VendingConnector {
  login(): Promise<void>;
  listMachines(groupId: string): Promise<RawMachine[]>;
  getSlots(machineId: string): Promise<RawSlot[]>;
  getProductSales(machineId: string, from: Date, to: Date): Promise<RawProductSale[]>;
  getMachineSales(groupId: string, from: Date, to: Date): Promise<RawMachineSale[]>;
}

/** Инъектируемый fetch (для тестов) — совместим с глобальным. */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface OurvendOptions {
  account: string;
  password: string;
  base?: string;
  fetchImpl?: FetchLike;
  /** Таймауты (§3.3): логин/список — 30с, слоты/продажи — 60с. */
  authTimeoutMs?: number;
  dataTimeoutMs?: number;
  /** Ретраи с экспоненциальной паузой (по умолчанию 3). */
  retries?: number;
  /** Пауза между ретраями, мс (для тестов можно 0). */
  retryBaseMs?: number;
}

const pad = (n: number): string => String(n).padStart(2, "0");
/** Дата для вендора в ташкентском времени (UTC+5), формат YYYY-MM-DD. */
export function ourvendDate(d: Date): string {
  const t = new Date(d.getTime() + 5 * 3600_000);
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}
/** Дата-время для вендора (§3.2.4): YYYY-MM-DD HH:MM:SS, Ташкент. */
export function ourvendDateTime(d: Date): string {
  const t = new Date(d.getTime() + 5 * 3600_000);
  return `${ourvendDate(d)} ${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}:${pad(t.getUTCSeconds())}`;
}

/**
 * Коннектор Ourvend. Одна сессия на весь цикл сбора: куки логина отправляются
 * дальше. Запросы последовательные (вендор не гарантирует лимиты). При протухшей
 * сессии — один перелогин и повтор (делает вызывающий цикл сбора).
 */
export class OurvendConnector implements VendingConnector {
  private readonly base: string;
  private readonly fetchImpl: FetchLike;
  private readonly authTimeout: number;
  private readonly dataTimeout: number;
  private readonly retries: number;
  private readonly retryBaseMs: number;
  /** Куки сессии: имя → значение. */
  private cookies = new Map<string, string>();

  constructor(private readonly opts: OurvendOptions) {
    this.base = (opts.base ?? OURVEND_BASE).replace(/\/$/, "");
    this.fetchImpl = opts.fetchImpl ?? ((u, i) => fetch(u, i));
    this.authTimeout = opts.authTimeoutMs ?? 30_000;
    this.dataTimeout = opts.dataTimeoutMs ?? 60_000;
    this.retries = opts.retries ?? 3;
    this.retryBaseMs = opts.retryBaseMs ?? 500;
  }

  private cookieHeader(): string {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  private absorbCookies(res: Response): void {
    // Совместимо и с getSetCookie (Node 20+), и с одиночным заголовком.
    const raw =
      (res.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.() ??
      (res.headers.get("set-cookie") ? [res.headers.get("set-cookie") as string] : []);
    for (const line of raw) {
      const pair = line.split(";")[0];
      const eq = pair.indexOf("=");
      if (eq > 0) this.cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  }

  /** POST form-urlencoded с куками, таймаутом и ретраями. */
  private async post(path: string, body: string, timeoutMs: number): Promise<string> {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= this.retries; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await this.fetchImpl(`${this.base}${path}`, {
          method: "POST",
          signal: controller.signal,
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            "Content-Length": String(Buffer.byteLength(body)),
            ...(this.cookies.size ? { Cookie: this.cookieHeader() } : {}),
          },
          body,
        });
        this.absorbCookies(res);
        const text = await res.text();
        if (res.status >= 500) throw new NetworkError(`Ourvend ответил ${res.status} на ${path}`, text.slice(0, 500));
        return text;
      } catch (err) {
        lastErr = err;
        if (attempt < this.retries) {
          await new Promise((r) => setTimeout(r, this.retryBaseMs * 2 ** attempt));
          continue;
        }
      } finally {
        clearTimeout(timer);
      }
    }
    throw new NetworkError(`Ourvend недоступен на ${path}`, lastErr instanceof Error ? lastErr.message : String(lastErr));
  }

  private parseJson(text: string, where: string): unknown {
    try {
      return JSON.parse(text);
    } catch {
      // Не-JSON = обычно редирект на логин (сессия протухла) или страница ошибки.
      throw new ShapeError(`Ourvend вернул не-JSON на ${where} (сессия протухла?)`, text.slice(0, 300));
    }
  }

  async login(): Promise<void> {
    const keyRaw = await this.post("/Account/GetPubKey", "", this.authTimeout);
    if (!keyRaw.trim()) throw new AuthError("Пустой публичный ключ от Ourvend");
    const encrypted = encryptPassword(keyRaw, this.opts.password);
    const body =
      `userAccount=${encodeURIComponent(this.opts.account)}` +
      `&userPwd=${encodeURIComponent(encrypted)}&LoginUrl=Account`;
    const res = await this.post("/Account/Login", body, this.authTimeout);
    // Успех: тело начинается с "ok". Иначе — причина в теле, логируем целиком.
    if (!res.trim().toLowerCase().startsWith("ok")) {
      throw new AuthError("Вход в Ourvend не удался", res.slice(0, 300));
    }
  }

  async listMachines(groupId: string): Promise<RawMachine[]> {
    const text = await this.post("/SaleSummarize/GetMachineID", `MachineGroup=${encodeURIComponent(groupId)}`, this.authTimeout);
    if (!text.includes("MuMachineID")) throw new ShapeError("В ответе нет MuMachineID — список автоматов не получен", text.slice(0, 300));
    return parseMachines(this.parseJson(text, "GetMachineID"));
  }

  async getSlots(machineId: string): Promise<RawSlot[]> {
    const text = await this.post("/Selection/SoltInfo", `MachineID=${encodeURIComponent(machineId)}&boxId=`, this.dataTimeout);
    return parseSlots(this.parseJson(text, "SoltInfo"));
  }

  async getProductSales(machineId: string, from: Date, to: Date): Promise<RawProductSale[]> {
    const body =
      `MId=${encodeURIComponent(machineId)}&StartDate=${ourvendDate(from)}&EndDate=${ourvendDate(to)}` +
      `&page=1&rows=300&sidx=&sord=asc`;
    const text = await this.post("/SaleMonitor/ProductSaleInfoJson", body, this.dataTimeout);
    return parseProductSales(this.parseJson(text, "ProductSaleInfoJson"));
  }

  async getMachineSales(groupId: string, from: Date, to: Date): Promise<RawMachineSale[]> {
    const body =
      `MiGroup=${encodeURIComponent(groupId)}&MachineID=&StartDate=${ourvendDateTime(from)}` +
      `&EndDate=${ourvendDateTime(to)}&boxId=&page=1&rows=50&sidx=MachineID&sord=asc`;
    const text = await this.post("/SaleDetail/MachineListJsoin", body, this.dataTimeout);
    return parseMachineSales(this.parseJson(text, "MachineListJsoin"));
  }
}
