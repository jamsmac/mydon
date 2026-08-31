/**
 * web — чтение страниц сайтов, откуда MYDON берёт данные.
 *
 * Зачем: владелец решил НЕ грузить старую базу — данные будут только новые,
 * и брать их система должна сама с сайтов, куда владелец даст доступ.
 *
 * Здесь только доставка и очистка текста. Понимание (что на странице —
 * контрагенты, техника, цены) делает LLM-слой на стороне вызывающего:
 * коннектор не должен зависеть от модели.
 *
 * Доступ к закрытым страницам — заголовками (cookie, авторизация), которые
 * передаёт владелец. Сами значения нигде не сохраняются и не печатаются, а на
 * чужой origin (редирект с источника) не передаются вовсе.
 *
 * Адреса — только публичные: агент читает страницы по данным из своей карточки,
 * и без проверки такой источник увёл бы его в служебную сеть (метаданные
 * облака 169.254.169.254, localhost, хосты Tailscale) — с выдержкой ответа в
 * отчёте владельцу. Поэтому схема, IP после разрешения имени и каждый редирект
 * проверяются здесь, а соединение идёт ровно на проверенные адреса (пиновка):
 * повторного резолва имени, которым DNS-rebinding подменил бы адрес уже после
 * проверки, не происходит.
 */

import { promises as dns } from "node:dns";
import type { LookupAddress } from "node:dns";
import { request as httpRequest } from "node:http";
import type { IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { Readable } from "node:stream";

export interface FetchPageOptions {
  /** Дополнительные заголовки: Cookie, Authorization — для закрытых страниц. */
  headers?: Record<string, string>;
  timeoutMs?: number;
  /** Предохранитель: страница больше лимита обрезается, а не съедает память. */
  maxBytes?: number;
  /** Тестовый шов: замена сетевого транспорта. По умолчанию — node:http(s) с пиновкой адреса. */
  transport?: Transport;
}

export interface FetchedPage {
  /** Адрес, с которого фактически прочитано, — после проверенных редиректов. */
  url: string;
  status: number;
  /** Очищенный текст страницы — без скриптов, стилей и разметки. */
  text: string;
  /** Страница была больше лимита и обрезана. */
  truncated: boolean;
}

/**
 * HTML → читаемый текст.
 *
 * Без внешних библиотек: скрипты и стили выбрасываются целиком, теги — в
 * пробелы, сущности — в символы. Для извлечения данных моделью этого
 * достаточно, а зависимость на целый парсер не нужна.
 */
export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    // Закрытие блочных тегов — перенос строки: структура таблиц и списков
    // важна для извлечения (строка = запись).
    .replace(/<\/(tr|p|div|li|h[1-6]|table|section)>/gi, "\n")
    .replace(/<(td|th)[^>]*>/gi, " | ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
}

/**
 * Отказ по адресу: чужая схема или внутренняя сеть.
 *
 * Отдельный класс, а не строка: вызывающий (readWebSources) кладёт текст
 * ошибки в отчёт по источнику, а владелец по нему сразу видит, что источник
 * отклонён правилом, а не сайт лежит.
 */
export class BlockedAddressError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BlockedAddressError";
  }
}

/** Сколько переходов по редиректам проходим, прежде чем считать это петлёй. */
const MAX_REDIRECTS = 5;

/** Похоже на литеральный IPv4 (`169.254.169.254`) — имя разрешать не нужно. */
function isIpv4Literal(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
}

function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  // Неразобранный адрес — не пускаем: лучше отказ, чем запрос «на всякий случай».
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return true; // this-network, private, loopback
  if (a === 169 && b === 254) return true; // link-local: метаданные облака
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 192 && b === 0) return true; // 192.0.0.0/24 — служебные назначения IETF
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT — диапазон Tailscale
  if (a >= 224) return true; // multicast и зарезервированное, включая broadcast
  return false;
}

function isPrivateIpv6(ip: string): boolean {
  // IPv4 в обёртке IPv6 — тот же адрес: и десятичной записью (::ffff:127.0.0.1),
  // и шестнадцатеричной (::ffff:7f00:1).
  const dotted = /^(?:0*:)*0*ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(ip);
  if (dotted) return isPrivateIpv4(dotted[1]);
  const hex = /^(?:0*:)*0*ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(ip);
  if (hex) {
    const hi = parseInt(hex[1], 16);
    const lo = parseInt(hex[2], 16);
    return isPrivateIpv4([hi >> 8, hi & 0xff, lo >> 8, lo & 0xff].join("."));
  }
  if (ip === "::" || ip === "::1") return true; // unspecified, loopback
  // IPv4-compatible (::/96, устарело по RFC 4291): ::127.0.0.1 и ::7f00:1 —
  // тот же IPv4 внутри. Извлекаем и проверяем как IPv4, по образцу ::ffff:.
  const compatDotted = /^(?:0*:)+(\d{1,3}(?:\.\d{1,3}){3})$/.exec(ip);
  if (compatDotted) return isPrivateIpv4(compatDotted[1]);
  const compatHex = /^(?:0*:)+(?:([0-9a-f]{1,4}):)?([0-9a-f]{1,4})$/.exec(ip);
  if (compatHex) {
    const hi = parseInt(compatHex[1] ?? "0", 16);
    const lo = parseInt(compatHex[2], 16);
    return isPrivateIpv4([hi >> 8, hi & 0xff, lo >> 8, lo & 0xff].join("."));
  }
  // 6to4 (2002::/16) — тоже обёртка IPv4, но выведена из оборота (RFC 7526):
  // публичного применения нет, блокируем диапазон целиком.
  if (/^2002:/.test(ip)) return true;
  if (/^fe[89ab]/.test(ip)) return true; // fe80::/10 link-local
  if (/^f[cd]/.test(ip)) return true; // fc00::/7 ULA
  if (/^ff/.test(ip)) return true; // multicast
  if (/^64:ff9b:/.test(ip)) return true; // NAT64 — обёртка над IPv4
  return false;
}

/**
 * Адрес во внутренней сети? Проверяем сам IP, а не имя: DNS чужого домена
 * спокойно указывает на 127.0.0.1 или на 169.254.169.254.
 */
export function isPrivateAddress(ip: string): boolean {
  const v = ip.trim().toLowerCase().replace(/^\[/, "").replace(/\]$/, "").split("%")[0];
  if (v.length === 0) return true;
  if (isIpv4Literal(v)) return isPrivateIpv4(v);
  if (v.includes(":")) return isPrivateIpv6(v);
  // Не IP: имя обязано быть разрешено до проверки, иначе проверять нечего.
  return true;
}

/** Проверенный адрес: URL плюс адреса, на которые пойдёт соединение. */
interface VettedUrl {
  url: URL;
  addresses: LookupAddress[];
}

/**
 * Гонка промиса с abort-сигналом: dns.lookup не умеет AbortSignal, а ждать
 * его дольше общего дедлайна операции нельзя. Проигравший промис глушится,
 * чтобы не оставить необработанный reject.
 */
function raceWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return promise;
  return new Promise<T>((resolve, reject) => {
    const abortError = (): Error =>
      signal.reason instanceof Error ? signal.reason : new Error("Операция прервана");
    if (signal.aborted) {
      promise.catch(() => {});
      reject(abortError());
      return;
    }
    const onAbort = (): void => {
      promise.catch(() => {});
      reject(abortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

/**
 * Проверяет адрес и отдаёт его вместе с проверенными IP: схема, затем ВСЕ
 * адреса, на которые разрешается имя (DNS отдаёт несколько — публичный первым,
 * внутренний вторым тоже прошёл бы). Соединяться дальше можно ТОЛЬКО по этим
 * адресам: повторный резолв имени открыл бы окно для DNS-rebinding.
 * Отказ — исключением, как и любая неудача fetchPage.
 */
async function resolvePublicUrl(raw: string, signal?: AbortSignal): Promise<VettedUrl> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new BlockedAddressError(`Адрес не разобрать: ${raw}`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new BlockedAddressError(`Схема ${u.protocol} не разрешена — только http и https: ${raw}`);
  }
  const host = u.hostname.replace(/^\[/, "").replace(/\]$/, "");
  if (isIpv4Literal(host) || host.includes(":")) {
    if (isPrivateAddress(host)) {
      throw new BlockedAddressError(`Адрес внутренней сети заблокирован: ${host}`);
    }
    return { url: u, addresses: [{ address: host, family: host.includes(":") ? 6 : 4 }] };
  }
  let addresses: LookupAddress[];
  try {
    // Резолв — под общим дедлайном операции: висящий DNS не должен
    // растягивать fetchPage за пределы timeoutMs.
    addresses = await raceWithAbort(dns.lookup(host, { all: true }), signal);
  } catch (err) {
    // Истёкший дедлайн — не «имя не разрешается»: отдаём причину как есть.
    if (signal?.aborted === true) throw err;
    throw new BlockedAddressError(`Имя ${host} не разрешается`);
  }
  if (addresses.length === 0) throw new BlockedAddressError(`Имя ${host} не разрешается`);
  for (const a of addresses) {
    if (isPrivateAddress(a.address)) {
      throw new BlockedAddressError(`Адрес внутренней сети заблокирован: ${host} → ${a.address}`);
    }
  }
  return { url: u, addresses };
}

/** Проверка адреса без запроса — публичная обёртка над resolvePublicUrl. */
export async function assertPublicUrl(raw: string): Promise<URL> {
  return (await resolvePublicUrl(raw)).url;
}

/** Ответ транспорта. Структурно совместим с Response — тестовые фейки отдают его. */
export interface TransportResponse {
  status: number;
  headers: { get(name: string): string | null };
  body: ReadableStream<Uint8Array> | null;
}

/** Сетевой транспорт: реальный — node:http(s) с пиновкой адреса, в тестах — фейк. */
export type Transport = (
  target: URL,
  init: { headers: Record<string, string>; signal: AbortSignal },
  addresses: LookupAddress[],
) => Promise<TransportResponse>;

/**
 * Реальный транспорт: node:http(s) с пиновкой проверенного адреса.
 *
 * Глобальный fetch тут не годится: undici резолвит имя ЗАНОВО уже после
 * проверки — DNS-rebinding с TTL≈0 подменил бы адрес на внутренний между
 * проверкой и соединением (TOCTOU). Здесь lookup вообще не ходит в DNS, а
 * отдаёт ровно те адреса, что прошли проверку; Host и TLS (SNI, сертификат)
 * при этом строятся по имени из URL, как обычно.
 */
export const nodeTransport: Transport = (target, init, addresses) =>
  new Promise<TransportResponse>((resolve, reject) => {
    const request = target.protocol === "https:" ? httpsRequest : httpRequest;
    const req = request(
      target,
      {
        headers: init.headers,
        signal: init.signal,
        lookup: (_hostname, options, callback) => {
          if (options.all === true) {
            callback(null, addresses);
          } else {
            callback(null, addresses[0].address, addresses[0].family);
          }
        },
      },
      (res: IncomingMessage) => {
        resolve({
          status: res.statusCode ?? 0,
          headers: {
            get: (name: string) => {
              const value = res.headers[name.toLowerCase()];
              return Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
            },
          },
          body: Readable.toWeb(res) as ReadableStream<Uint8Array>,
        });
      },
    );
    req.on("error", reject);
    req.end();
  });

/**
 * Читает тело ответа кусками и останавливается на лимите: страница на гигабайт
 * не должна сначала целиком лечь в память, чтобы потом быть обрезанной.
 * Остаток потока отменяется, соединение не дочитывается впустую.
 */
async function readBodyCapped(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<{ html: string; truncated: boolean }> {
  if (body === null) return { html: "", truncated: false };
  const decoder = new TextDecoder("utf-8");
  const reader = body.getReader();
  let html = "";
  let received = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined || value.byteLength === 0) continue;
      const room = maxBytes - received;
      if (value.byteLength <= room) {
        // stream: true — многобайтовый символ UTF-8 на границе кусков не рвётся.
        html += decoder.decode(value, { stream: true });
        received += value.byteLength;
      } else {
        if (room > 0) html += decoder.decode(value.subarray(0, room), { stream: true });
        truncated = true;
        break;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  html += decoder.decode();
  return { html, truncated };
}

/**
 * Загрузка страницы с таймаутом и потолком размера.
 *
 * Редиректы — вручную, своим циклом: каждый новый адрес проходит ровно ту же
 * проверку, что и первый, и соединение идёт по проверенным адресам (пиновка,
 * см. nodeTransport). Заголовки владельца живут только на исходном origin,
 * дедлайн timeoutMs — один на всю операцию: резолвы, переходы, чтение тела.
 */
export async function fetchPage(url: string, opts: FetchPageOptions = {}): Promise<FetchedPage> {
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const maxBytes = opts.maxBytes ?? 2_000_000;
  const transport = opts.transport ?? nodeTransport;

  // Один дедлайн на всё: сигнал на каждый переход дал бы медленному сайту
  // (MAX_REDIRECTS+1)×timeoutMs вместо обещанного timeoutMs.
  const signal = AbortSignal.timeout(timeoutMs);

  let vetted = await resolvePublicUrl(url, signal);
  // Заголовки владельца (Cookie, Authorization) принадлежат исходному origin:
  // редирект на чужой хост или даунгрейд https→http уходит без них — иначе
  // open-redirect на источнике слил бы учётные данные третьей стороне.
  const ownOrigin = vetted.url.origin;
  let res: TransportResponse;
  for (let hop = 0; ; hop++) {
    res = await transport(
      vetted.url,
      {
        headers: {
          // Только латиница: HTTP-заголовки не принимают других символов.
          "User-Agent": "MYDON/1.0 (owner-authorized data collection)",
          ...(vetted.url.origin === ownOrigin ? (opts.headers ?? {}) : {}),
        },
        signal,
      },
      vetted.addresses,
    );
    const location = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
    if (location === null) break;
    // Тело редиректа не нужно — отменяем, чтобы не держать соединение.
    await res.body?.cancel().catch(() => {});
    if (hop >= MAX_REDIRECTS) {
      throw new BlockedAddressError(`Слишком много переходов (больше ${MAX_REDIRECTS}): ${url}`);
    }
    vetted = await resolvePublicUrl(new URL(location, vetted.url).toString(), signal);
  }

  const { html, truncated } = await readBodyCapped(res.body, maxBytes);

  return {
    url: vetted.url.toString(),
    status: res.status,
    text: htmlToText(html),
    truncated,
  };
}

export const web = {
  name: "web",
  status: "live" as const,
  note: "Чтение страниц сайтов: доставка и очистка текста. Понимание — за LLM-слоем.",
  fetchPage,
  htmlToText,
  assertPublicUrl,
  isPrivateAddress,
};
