/**
 * didox — коннектор к Didox.uz (оператор ЭДО РУз) для домена GLOBERENT.
 *
 * ЗАЧЕМ. Сегодня договоры и счета приезжают выгрузками из личного кабинета:
 * человек качает реестр, реестр разбирается парсером, парсер угадывает номер
 * договора и покупателя из текстовых колонок. Именно это угадывание дало
 * потерянные связи и слипшихся покупателей. В API те же данные лежат
 * ОТДЕЛЬНЫМИ ПОЛЯМИ — `contract_number`, `contract_date`, `partnerTin` —
 * поэтому угадывать больше нечего.
 *
 * ДОСТУП (два токена, это не опечатка):
 *   1. ПАРТНЁРСКИЙ токен — заголовок `Partner-Authorization`. Выдаётся не в
 *      кабинете, а аккаунт-менеджером Didox (t.me/Didox_account, +998 50 122 05 18).
 *   2. ТОКЕН ПОЛЬЗОВАТЕЛЯ — заголовок `user-key`. Берётся по паролю (или ЭЦП)
 *      и живёт 360 минут, поэтому клиент держит его в памяти и переполучает.
 * Оба — из окружения, ни один не попадает в код и в репозиторий.
 *
 * Базовые адреса: прод `https://api-partners.didox.uz`, тест `https://testapi3.didox.uz`.
 *
 * ЧТО ЗДЕСЬ ЕСТЬ. Клиент (вход, постраничное чтение документов) и ЧИСТЫЕ
 * функции сборки договоров из документов — они тестируются на фикстурах и не
 * ходят в сеть.
 *
 * ЧЕГО ЗДЕСЬ ПОКА НЕТ: привязки к денежным записям книги (`flowDocNos`).
 * Номер «СФ 2024-30» — внутренняя нумерация владельца, в Didox её нет; мост
 * между ними строится на реальных данных, а не по документации.
 */

/** Прод-адрес партнёрского API. */
export const DIDOX_PROD = "https://api-partners.didox.uz";
/** Тестовый контур Didox. */
export const DIDOX_TEST = "https://testapi3.didox.uz";

/** Токен пользователя живёт 360 минут; берём с запасом, чтобы не ловить 401 на границе. */
export const DIDOX_TOKEN_TTL_MS = 300 * 60 * 1000;

/** Коды типов документов Didox — как в таблице «Поддерживаемые типы документов». */
export const DIDOX_DOCTYPES: Readonly<Record<string, string>> = {
  "001": "Счёт-фактура",
  "002": "Счёт-фактура без акта",
  "005": "Акт выполненных работ",
  "006": "Доверенность",
  "007": "Договор (ГНК)",
  "008": "Счёт-фактура (ФАРМ)",
  "010": "Многосторонний произвольный документ",
  "023": "Гибридная счёт-фактура",
  "041": "ТТН",
  "052": "Акт сверки",
  "062": "Доверенность (новая)",
  "000": "Произвольный документ",
};

/**
 * Типы счетов-фактур (ЭСФ). Нужны, чтобы отличить «выставлено» от «просто
 * документ по договору»: акт (005) и сам договор (007) в сумму отгрузки не идут.
 */
export const DIDOX_INVOICE_DOCTYPES = ["001", "002", "008", "023"] as const;

/**
 * Статусы, при которых документ считается живым. Черновик (0), удалённый
 * (5, 55), отказ (4), недействительный (40) и аннулированный НК (50) в суммы
 * не входят — иначе договор «оплачен» бумагой, которой нет.
 */
export const DIDOX_LIVE_STATUSES = [1, 2, 3, 6, 8, 60] as const;

// ── Сырые типы ответов Didox ────────────────────────────────────────────────

/** Строка списка `GET /v2/documents` — только поля, которые нам нужны. */
export interface DidoxDoc {
  /** ID документа (32 символа). */
  doc_id: string;
  /** Номер документа. У договоров сюда попадает предмет («купля-продажа»). */
  name: string;
  /** Дата документа, ГГГГ-ММ-ДД. */
  doc_date: string | null;
  /** Код статуса, см. DIDOX_LIVE_STATUSES. */
  doc_status: number;
  /** Код типа документа: «002» — ЭСФ, «041» — ТТН и т. д. */
  doctype: string;
  /** Номер договора — отдельным полем, угадывать не нужно. */
  contract_number: string | null;
  /** Дата договора, ГГГГ-ММ-ДД. */
  contract_date: string | null;
  /** ИНН контрагента. */
  partnerTin: string | null;
  /** Название контрагента. */
  partnerCompany: string | null;
  /** 1 — исходящий, 0 — входящий. */
  owner: number;
  /** Сумма с НДС. */
  total_delivery_sum_with_vat: number | string | null;
  /** Сумма НДС. */
  total_vat_sum: number | string | null;
}

/** Ответ списка документов. */
export interface DidoxPage {
  data: DidoxDoc[];
  total: number;
  next_page_url: string | null;
}

/**
 * Договор в том виде, в каком его принимает Core (`ImportContract`).
 * Форма повторена намеренно: сид и API кладут в импорт одно и то же.
 */
export interface DidoxContract {
  contractNo: string;
  contractDate: string;
  buyerName: string;
  buyerInn?: string;
  totalWithVat: number;
  totalVat?: number;
  status?: "active" | "closed";
  subject?: string | null;
  didoxRows?: { doc: string; date: string | null; totalWithVat: number }[];
  didoxDuplicatesDropped?: number;
  extraDates?: string[];
  invoicedTotal?: number;
}

/** Контрагент для реестра — из полей документа, без разбора названий. */
export interface DidoxContractor {
  name: string;
  inn: string;
}

// ── Типизированные ошибки ───────────────────────────────────────────────────

export class DidoxError extends Error {
  constructor(
    message: string,
    readonly detail?: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}
/** Не пустил: нет партнёрского токена, неверный пароль, блокировка за перебор. */
export class DidoxAuthError extends DidoxError {}
/** Ответ неожиданной структуры — сменилось API или пришёл не JSON. */
export class DidoxShapeError extends DidoxError {}
/** Сеть или таймаут. */
export class DidoxNetworkError extends DidoxError {}

// ── Чистые помощники разбора ────────────────────────────────────────────────

/** Число из поля, которое приходит то числом, то строкой. Мусор → 0. */
export function num(v: unknown): number {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  if (typeof v === "string") {
    const n = Number(v.trim().replace(/\s+/g, ""));
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

/**
 * Заглушки вместо номера договора. Список закрытый и короткий намеренно:
 * лучше пропустить сомнительную карточку в импорт (там она проверится и
 * увидится глазами), чем молча выкинуть настоящий договор.
 */
const NO_CONTRACT = new Set([
  "",
  "-",
  "--",
  "0",
  "б/н",
  "бн",
  "без номера",
  "no contract",
  "nocontract",
  "нет",
  "yo'q",
  "yoq",
  "test",
  "тест",
]);

/** Номер договора, пригодный как ключ. null — заглушка, не номер. */
export function contractNo(raw: string | null | undefined): string | null {
  const s = (raw ?? "").trim();
  if (NO_CONTRACT.has(s.toLowerCase())) return null;
  if (s.length < 2) return null;
  return s;
}

/**
 * Ключ договора — номер И ИНН покупателя. Разные покупатели с одинаковым
 * номером («1») обязаны остаться разными карточками: именно их слипание
 * прошлый разбор и давал.
 */
export function contractKey(no: string, inn: string | null | undefined): string {
  return `${no} ${(inn ?? "").trim()}`;
}

/** Живой документ: не черновик, не удалён, не отказ, не аннулирован. */
export function isLive(doc: DidoxDoc): boolean {
  return (DIDOX_LIVE_STATUSES as readonly number[]).includes(doc.doc_status);
}

/** Счёт-фактура (в отличие от акта, договора, ТТН). */
export function isInvoice(doc: DidoxDoc): boolean {
  return (DIDOX_INVOICE_DOCTYPES as readonly string[]).includes(doc.doctype);
}

/**
 * Собрать договоры из документов Didox.
 *
 * Правила (те же, что дал ручной разбор, только на полях вместо текста):
 * — ключ: номер договора + ИНН покупателя;
 * — `totalWithVat` — сумма ВСЕХ живых документов договора, `invoicedTotal` —
 *   только счетов-фактур; отсюда `closed`: выставлено не меньше суммы договора;
 * — дата договора — самая ранняя из встреченных, остальные в `extraDates`,
 *   чтобы расхождение было видно, а не потеряно;
 * — дубли (тот же документ, дата и сумма) считаются в `didoxDuplicatesDropped`.
 *
 * Документы без номера договора или без ИНН покупателя не выбрасываются молча —
 * они возвращаются в `skipped` с причиной.
 */
export function contractsFromDocuments(docs: DidoxDoc[]): {
  contracts: DidoxContract[];
  skipped: { doc: string; reason: string }[];
} {
  const skipped: { doc: string; reason: string }[] = [];
  type Acc = {
    no: string;
    inn: string | null;
    name: string;
    dates: Set<string>;
    rows: { doc: string; date: string | null; totalWithVat: number }[];
    seen: Set<string>;
    duplicates: number;
    total: number;
    vat: number;
    invoiced: number;
  };
  const byKey = new Map<string, Acc>();

  for (const d of docs) {
    if (!isLive(d)) continue;
    const no = contractNo(d.contract_number);
    if (no === null) {
      skipped.push({
        doc: d.doc_id,
        reason: `номер договора не разобрать: «${d.contract_number}»`,
      });
      continue;
    }
    const inn = (d.partnerTin ?? "").trim() || null;
    if (inn === null) {
      skipped.push({ doc: d.doc_id, reason: `«${no}»: документ без ИНН контрагента` });
      continue;
    }
    const key = contractKey(no, inn);
    let acc = byKey.get(key);
    if (acc === undefined) {
      acc = {
        no,
        inn,
        name: (d.partnerCompany ?? "").trim(),
        dates: new Set(),
        rows: [],
        seen: new Set(),
        duplicates: 0,
        total: 0,
        vat: 0,
        invoiced: 0,
      };
      byKey.set(key, acc);
    }
    if (acc.name.length === 0) acc.name = (d.partnerCompany ?? "").trim();
    if (d.contract_date !== null && d.contract_date.length > 0) acc.dates.add(d.contract_date);

    const sum = num(d.total_delivery_sum_with_vat);
    const rowKey = `${d.name} ${d.doc_date ?? ""} ${sum}`;
    if (acc.seen.has(rowKey)) {
      acc.duplicates += 1;
      continue;
    }
    acc.seen.add(rowKey);
    acc.rows.push({ doc: d.name, date: d.doc_date, totalWithVat: sum });
    acc.total += sum;
    acc.vat += num(d.total_vat_sum);
    if (isInvoice(d)) acc.invoiced += sum;
  }

  const contracts: DidoxContract[] = [];
  for (const acc of byKey.values()) {
    const dates = [...acc.dates].sort();
    if (dates.length === 0) {
      skipped.push({ doc: acc.no, reason: `«${acc.no}»: ни в одном документе нет даты договора` });
      continue;
    }
    if (acc.name.length === 0) {
      skipped.push({
        doc: acc.no,
        reason: `«${acc.no}»: ни в одном документе нет названия покупателя`,
      });
      continue;
    }
    const contract: DidoxContract = {
      contractNo: acc.no,
      contractDate: dates[0],
      buyerName: acc.name,
      totalWithVat: acc.total,
      totalVat: acc.vat,
      status: acc.invoiced > 0 && acc.invoiced >= acc.total ? "closed" : "active",
      subject: acc.rows[0]?.doc ?? null,
      didoxRows: acc.rows,
      invoicedTotal: acc.invoiced,
    };
    if (acc.inn !== null) contract.buyerInn = acc.inn;
    if (dates.length > 1) contract.extraDates = dates.slice(1);
    if (acc.duplicates > 0) contract.didoxDuplicatesDropped = acc.duplicates;
    contracts.push(contract);
  }
  contracts.sort(
    (a, b) =>
      a.contractDate.localeCompare(b.contractDate) || a.contractNo.localeCompare(b.contractNo),
  );
  return { contracts, skipped };
}

/** Контрагенты из тех же документов — ИНН и название берутся полями. */
export function contractorsFromDocuments(docs: DidoxDoc[]): DidoxContractor[] {
  const byInn = new Map<string, string>();
  for (const d of docs) {
    const inn = (d.partnerTin ?? "").trim();
    const name = (d.partnerCompany ?? "").trim();
    if (inn.length === 0 || name.length === 0) continue;
    if (!byInn.has(inn)) byInn.set(inn, name);
  }
  return [...byInn]
    .map(([inn, name]) => ({ inn, name }))
    .sort((a, b) => a.inn.localeCompare(b.inn));
}

/** Разбор страницы списка документов. Не массив в `data` → структура сменилась. */
export function parsePage(json: unknown): DidoxPage {
  const o = (json ?? {}) as Record<string, unknown>;
  if (!Array.isArray(o.data)) {
    throw new DidoxShapeError("Список документов: в ответе нет массива data");
  }
  return {
    data: o.data as DidoxDoc[],
    total: num(o.total),
    next_page_url: typeof o.next_page_url === "string" ? o.next_page_url : null,
  };
}

// ── Клиент ──────────────────────────────────────────────────────────────────

export interface DidoxConfig {
  /** Базовый адрес: прод или тест. */
  baseUrl?: string;
  /** Партнёрский токен (заголовок Partner-Authorization). */
  partnerToken: string;
  /** ИНН/ПИНФЛ компании владельца. */
  taxId: string;
  /** Пароль пользователя Didox. */
  password: string;
  /** Готовый токен пользователя — если вход уже сделан снаружи. */
  userToken?: string;
  /** Часы (для тестов). */
  now?: () => number;
  /** fetch (для тестов). */
  fetchImpl?: typeof fetch;
}

/** Фильтры списка документов — имена как в API, без переименований. */
export interface DidoxQuery {
  /** 1 — исходящие, 0 — входящие. По умолчанию API отдаёт исходящие. */
  owner?: 0 | 1;
  /** Коды статусов через запятую. */
  status?: string;
  /** Коды типов документов через запятую. */
  doctype?: string;
  /** Дата документа, с (ГГГГ-ММ-ДД). */
  docDateFromCreated?: string;
  /** Дата документа, по (ГГГГ-ММ-ДД). */
  docDateToCreated?: string;
  /** ИНН контрагента. */
  partner?: string;
  /** Размер страницы, 1..100. */
  limit?: number;
}

/**
 * Клиент Didox. Держит токен пользователя в памяти и переполучает его по
 * истечении — вызывающему про 360 минут знать не нужно.
 */
export class DidoxClient {
  private readonly baseUrl: string;
  private readonly now: () => number;
  private readonly fetchImpl: typeof fetch;
  private token: string | null;
  private tokenAt = 0;

  constructor(private readonly cfg: DidoxConfig) {
    if (cfg.partnerToken.trim().length === 0) {
      throw new DidoxAuthError("Нет партнёрского токена: заполните DIDOX_PARTNER_TOKEN");
    }
    this.baseUrl = (cfg.baseUrl ?? DIDOX_PROD).replace(/\/+$/, "");
    this.now = cfg.now ?? Date.now;
    this.fetchImpl = cfg.fetchImpl ?? fetch;
    this.token = cfg.userToken ?? null;
    if (this.token !== null) this.tokenAt = this.now();
  }

  /** Токен пользователя: из кеша, пока свежий, иначе вход по паролю. */
  async userToken(): Promise<string> {
    if (this.token !== null && this.now() - this.tokenAt < DIDOX_TOKEN_TTL_MS) return this.token;
    const url = `${this.baseUrl}/v1/auth/${encodeURIComponent(this.cfg.taxId)}/password/ru`;
    const res = await this.call(url, {
      method: "POST",
      headers: {
        "Partner-Authorization": this.cfg.partnerToken,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ password: this.cfg.password }),
    });
    if (res.status === 401 || res.status === 422) {
      // Didox блокирует за перебор: 3 попытки в минуту → 10 минут, 10 → сутки.
      throw new DidoxAuthError(
        "Didox не пустил по паролю — проверьте DIDOX_TAX_ID/DIDOX_PASSWORD",
        `HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`,
      );
    }
    if (!res.ok) {
      throw new DidoxError("Didox: вход не удался", `HTTP ${res.status}`);
    }
    const json = (await res.json()) as { token?: unknown };
    if (typeof json.token !== "string" || json.token.length === 0) {
      throw new DidoxShapeError("Ответ входа без поля token");
    }
    this.token = json.token;
    this.tokenAt = this.now();
    return this.token;
  }

  /** Одна страница документов. */
  async listDocuments(query: DidoxQuery = {}, page = 1): Promise<DidoxPage> {
    const limit = Math.min(Math.max(query.limit ?? 100, 1), 100);
    const params = new URLSearchParams({ page: String(page), limit: String(limit) });
    for (const [k, v] of Object.entries(query)) {
      if (k === "limit" || v === undefined) continue;
      params.set(k, String(v));
    }
    const res = await this.call(`${this.baseUrl}/v2/documents?${params}`, {
      headers: {
        "Partner-Authorization": this.cfg.partnerToken,
        "user-key": await this.userToken(),
      },
    });
    if (res.status === 401) {
      throw new DidoxAuthError("Didox: токен пользователя отвергнут", `HTTP ${res.status}`);
    }
    if (!res.ok) throw new DidoxError("Didox: список документов", `HTTP ${res.status}`);
    return parsePage(await res.json());
  }

  /**
   * Все документы по фильтру: идём по страницам, пока Didox их отдаёт.
   * `maxPages` — не оптимизация, а предохранитель от бесконечного цикла,
   * если сервер вдруг перестанет менять выдачу.
   */
  async allDocuments(query: DidoxQuery = {}, maxPages = 200): Promise<DidoxDoc[]> {
    const out: DidoxDoc[] = [];
    const seen = new Set<string>();
    for (let page = 1; page <= maxPages; page += 1) {
      const p = await this.listDocuments(query, page);
      for (const d of p.data) {
        if (typeof d.doc_id === "string" && seen.has(d.doc_id)) continue;
        if (typeof d.doc_id === "string") seen.add(d.doc_id);
        out.push(d);
      }
      if (p.data.length === 0 || p.next_page_url === null) break;
    }
    return out;
  }

  private async call(url: string, init: RequestInit): Promise<Response> {
    try {
      return await this.fetchImpl(url, init);
    } catch (e) {
      throw new DidoxNetworkError("Didox недоступен", e instanceof Error ? e.message : String(e));
    }
  }
}

/** Клиент из окружения. Ключи — только в `.env`, в коде их нет. */
export function didoxFromEnv(env: NodeJS.ProcessEnv = process.env): DidoxClient {
  return new DidoxClient({
    baseUrl: env.DIDOX_BASE_URL ?? DIDOX_PROD,
    partnerToken: env.DIDOX_PARTNER_TOKEN ?? "",
    taxId: env.DIDOX_TAX_ID ?? "",
    password: env.DIDOX_PASSWORD ?? "",
    ...(env.DIDOX_USER_TOKEN ? { userToken: env.DIDOX_USER_TOKEN } : {}),
  });
}

/** Метаданные коннектора для реестра Ф5. */
export const didox = {
  name: "Didox",
  status: "planned" as const,
  note: "ЭДО РУз. Нужны DIDOX_PARTNER_TOKEN (у аккаунт-менеджера Didox) и DIDOX_TAX_ID/DIDOX_PASSWORD.",
};
