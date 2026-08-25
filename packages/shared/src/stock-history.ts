import { normalizeMachineSerial } from "./machine-serial";
import { tashkentInstant } from "./tashkent-time";
import { normalizeProductName } from "./vending-calc";

/**
 * Маппинг истории склада донора `mydon-stock` в записи mydon (П8a).
 *
 * Чистые функции без инфраструктуры: скрипт импорта (`packages/db`) читает
 * донора и пишет в базу, а РЕШЕНИЯ о том, что чем становится, живут здесь и
 * покрыты тестами на донорских фикстурах. `@mydon/shared` о `@mydon/db` не
 * знает — зависимость односторонняя, поэтому формы вставки объявлены здесь
 * руками, а не выведены из drizzle-схемы.
 *
 * ТРИ РЕШЕНИЯ, КОТОРЫЕ НЕЛЬЗЯ «УПРОСТИТЬ» (инвентаризация донора 25.08):
 *
 * 1. СОПОСТАВЛЕНИЕ ИМЁН — ТОЛЬКО ТОЧНОЕ. Каталог донора ≠ канон mydon: 62
 *    карточки, из них 13 помечены `[слит→N]`, два имени лежат HTML-мусором
 *    (`M&amp;Ms`, `O&#39;zbegim`), 14 имён истории вообще не имеют пары в
 *    каталоге OurVend. Соблазн добить их нечётким сравнением здесь не
 *    реализован намеренно: в списке несопоставленных стоят `Moxito Mango CAN
 *    0.45` и `Laimon Mango CAN 0.33` — любое сравнение «по похожести» склеит
 *    330 мл с 450 мл и навсегда испортит историю (`inventory-donor.md` §4.3).
 *    Не разрешилось — едет сырым именем, `product_id` остаётся NULL, строка
 *    попадает в отчёт (R-P8a-7). Ошибка, которую видно, лучше догадки.
 *
 * 2. ДЕДУПЫ ПО ЕСТЕСТВЕННОМУ КЛЮЧУ НЕТ. У донора 7 групп заливов и 5 групп
 *    инвентаризаций совпадают по (дата, товар, аппарат, qty). Это не грязь
 *    ввода: `archive/seed_refills_1415.py` вносил заправку и инвентаризацию
 *    «после» двумя записями одного физического события, а закуп 14.07 внесён
 *    датой 13.07, чтобы инвентаризация 14.07 не двоила остаток
 *    (`inventory-donor.md` §4.4). Механическая склейка съела бы намеренные
 *    пары. Идемпотентность держится на донорском `id` (`client_key` /
 *    `ext_id`), а не на содержимом строки: разные id — разные ключи.
 *
 * 3. ПОЛДЕНЬ, А НЕ ПОЛНОЧЬ. У донора `dt` — это `DATE` без времени, а наши
 *    колонки моментов `NOT NULL`. Полночь ташкентских суток при чтении как
 *    UTC уезжает на предыдущий день — ровно та ловушка, на которой погорел
 *    VendCash (сдвиг −5 ч чинили миграцией). Полдень переживает любой такой
 *    сдвиг, оставаясь в тех же сутках, поэтому момент собирается явно:
 *    `dt 12:00 +05` через `tashkentInstant`, без второй копии смещения.
 */

// ── Донор: как строки отдаёт SQL ────────────────────────────────────────────

/** Строки донора как их отдаёт SQL: числа приходят строками postgres.js. */
export interface DonorRefillRow { id: number | string; dt: string; machine_serial: string | null; product: string; qty: string | number }
export interface DonorStockCountRow { id: number | string; dt: string; product: string; qty: string | number; counted_at: string | Date | null }
/**
 * `unit`/`note`/`total` — ровно те же колонки, что тянет синк снабжения
 * (`supply.service.ts`). Они не участвуют в сверке, но едут в дописываемую
 * строку: иначе она отличалась бы от 342 соседей зеркала пустой единицей и
 * посчитанной в JS суммой. `total` у донора — GENERATED-колонка, считать её
 * второй раз у себя незачем.
 */
export interface DonorPurchaseRow {
  id: number | string; dt: string; product: string; qty: string | number; unit_price: string | number | null;
  unit?: string | null; note?: string | null; total?: string | number | null;
}

/** Канон имени: точное сопоставление через алиасы и прайс. `null` — канона НЕТ. */
export type CanonIndex = (raw: string) => string | null;

// ── Формы вставки ───────────────────────────────────────────────────────────

/** Формы вставки для скрипта. Объявлены здесь, а не выведены из drizzle: `@mydon/shared` о `@mydon/db` не знает (зависимость односторонняя). */
export interface VendingRefillInsert {
  machineSerial: string; coilId: null; productName: string; qty: number;
  performedAt: string; clientKey: string; source: "stock-import"; personId: null; note: string | null;
}
export interface VendingStockCountInsert {
  dt: string; productName: string; qty: number; source: "stock-import";
  extId: string; countedAt: string; personId: null; note: string | null;
}

/** Строка НЕ легла в таблицу — и почему именно, словом. */
export interface Unresolved { ok: false; reason: "no_serial" | "service_row" | "bad_qty" | "no_date"; extId: string; product: string }
/** Строка легла. `rawName` — имя, которому канона нет: едет сырым, `productId` останется NULL (R-P8a-7). */
export interface Mapped<T> { ok: true; row: T; rawName: string | null }

/** Пометка импорта: по ней видно происхождение строки без похода в `source`. */
const IMPORT_NOTE = "импорт истории mydon-stock";

// ── Имена товаров ───────────────────────────────────────────────────────────

/** Именованные энтити панели склада. `&amp;` стоит последним осознанно (см. `decodeHtml`). */
const NAMED_ENTITIES: Record<string, string> = {
  quot: '"', apos: "'", lt: "<", gt: ">", nbsp: " ", amp: "&",
};

/** Одна альтернатива на все энтити: `&#39;`, `&#x27;` и именованные. */
const ENTITY = /&(#x[0-9a-fA-F]+|#\d+|quot|apos|lt|gt|nbsp|amp);/g;

/**
 * HTML-энтити панели склада → символы. `M&amp;Ms` → `M&Ms`.
 *
 * РОВНО ОДИН ПРОХОД. Замены идут одним регэкспом слева направо, и текст,
 * получившийся из замены, повторно не сканируется. Это не мелочь: `&amp;amp;`
 * — это закодированное `&amp;`, а не `&`, и второй проход соврал бы. По той же
 * причине `&amp;` не заменяется отдельным шагом раньше остальных: из
 * `&amp;#39;` тогда получился бы апостроф там, где его в имени не было.
 *
 * Неизвестное или невалидное численное значение остаётся текстом как есть:
 * молча превратить его в `�` значит испортить имя товара.
 */
export function decodeHtml(raw: string): string {
  return raw.replace(ENTITY, (match, body: string) => {
    if (body.startsWith("#")) {
      const hex = body[1] === "x" || body[1] === "X";
      const code = Number.parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return match;
      try {
        return String.fromCodePoint(code);
      } catch {
        return match;
      }
    }
    return NAMED_ENTITIES[body] ?? match;
  });
}

/** Донорская пометка слияния карточек: `Pepsi 0,5 [слит→23]` → `Pepsi 0,5`. */
const MERGED_MARKER = /\s*\[\s*слит\s*→\s*\d+\s*\]\s*$/u;

/**
 * Снятие пометки `[слит→N]` — НЕ нечёткое сопоставление.
 *
 * Приписка принадлежит не товару, а панели склада: так помечены 13 карточек-
 * дублей донора. Имя товара — то, что слева от неё; сама пометка в канон
 * mydon не переносится.
 */
export function stripMergedMarker(raw: string): string {
  return raw.replace(MERGED_MARKER, "").trim();
}

/**
 * `decodeHtml` → `stripMergedMarker` → канон. Возвращает [имя, найденЛиКанон].
 *
 * Канона нет → возвращается очищенное сырое имя и `false`: строка всё равно
 * импортируется, но с `product_id = NULL` и упоминанием в отчёте (R-P8a-7).
 */
export function canonicalProductName(raw: string, canon: CanonIndex): [string, boolean] {
  const cleaned = stripMergedMarker(decodeHtml(raw));
  const hit = canon(cleaned);
  return hit === null ? [cleaned, false] : [hit, true];
}

/** Карточка прайса и алиас — ровно то, из чего строится индекс каталога. */
export interface ProductRow { id: string; name: string }
export interface AliasRow { productId: string; alias: string }

/** Индекс каталога: одна сборка — два ответа. */
export interface ProductIndex {
  /** Сырое имя → каноническое ИМЯ прайса. `null` — карточки нет. */
  canon: CanonIndex;
  /** Сырое имя → id карточки. `null` — карточки нет. */
  id: (raw: string) => string | null;
}

/**
 * Индекс каталога товаров — ОДНА сборка на оба вопроса, которые к нему задают.
 *
 * Вопроса ровно два, и они разные: бэкфиллу привязок нужен `id` карточки, а
 * импорту истории — каноническое ИМЯ (его кладут в `product_name`, чтобы
 * отчёт за прошлый месяц не менял содержание, когда товар переименуют).
 * Раньше это было двумя дословными копиями одной и той же сборки в
 * `backfill-product-ids.ts` и в скрипте импорта — а сборка тут не тривиальная:
 * в ней живёт решение «алиас на удалённый товар в карту НЕ попадает» и выбор
 * нормализации. Копии таких решений расходятся на первом же новом алиасе.
 *
 * Сопоставление — только точное, по `normalizeProductName`; нечёткого здесь
 * нет и быть не должно (см. решение 1 в шапке файла).
 */
export function productIndex(products: readonly ProductRow[], aliases: readonly AliasRow[]): ProductIndex {
  const nameById = new Map(products.map((p) => [p.id, p.name]));
  const aliasByKey = new Map<string, string>();
  for (const a of aliases) {
    const canonical = nameById.get(a.productId);
    // Алиас на удалённый товар — не повод привязать строку к чему попало.
    if (canonical) aliasByKey.set(normalizeProductName(a.alias), canonical);
  }
  const canonByKey = new Map(products.map((p) => [normalizeProductName(p.name), p.name]));
  const idByKey = new Map(products.map((p) => [normalizeProductName(p.name), p.id]));

  const canon: CanonIndex = (raw) => {
    const key = normalizeProductName(raw);
    return aliasByKey.get(key) ?? canonByKey.get(key) ?? null;
  };
  return {
    canon,
    id: (raw) => {
      const c = canon(raw);
      return c === null ? null : (idByKey.get(normalizeProductName(c)) ?? null);
    },
  };
}

/**
 * Служебные строки донора: не товар, а разница в сумме. Список, а не догадка по подстроке.
 *
 * ПОЧЕМУ СПИСОК. Догадка «дорого/дёшево» или «в имени есть слово недостача»
 * рано или поздно выбросит настоящий товар. Здесь имя названо буквально: в
 * доноре ровно одна карточка категории `Служебное` — `Недостача (Рустам)`
 * (две строки закупа, Σ 87 000 сум, разница между заявленной суммой и
 * позициями). Появится вторая такая заглушка — её добавляют СЮДА, строкой.
 *
 * Заглушка закупок `Закуп (позиции уточняются)` в списке НЕ значится
 * намеренно: она живёт только в `purchases`, а служебность проверяется на
 * инвентаризациях склада. Сверка закупок (R-P8a-1) служебные строки не
 * фильтрует — иначе они вечно висели бы в «отсутствует у нас».
 */
export const SERVICE_PRODUCT_NAMES: readonly string[] = ["Недостача (Рустам)"];

const SERVICE_KEYS = new Set(SERVICE_PRODUCT_NAMES.map(normalizeProductName));

/** Служебное имя: сравнение по той же нормализации, что и весь вендинг. */
function isServiceProduct(name: string): boolean {
  return SERVICE_KEYS.has(normalizeProductName(name));
}

// ── Числа и даты донора ─────────────────────────────────────────────────────

/** `numeric` приходит строкой (`"24.00"`), а иногда числом. `null` — не число. */
function toNumber(v: string | number | null | undefined): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (s.length === 0) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

const BARE_DAY = /^\d{4}-\d{2}-\d{2}/;

/** Донорский `dt` (`DATE`) → `YYYY-MM-DD`. Мусор → `null`, строка уйдёт в `no_date`. */
function toDay(dt: string | Date | null | undefined): string | null {
  if (dt instanceof Date) return Number.isNaN(dt.getTime()) ? null : dt.toISOString().slice(0, 10);
  if (typeof dt !== "string") return null;
  const m = BARE_DAY.exec(dt.trim());
  return m ? m[0]! : null;
}

/** Полдень ташкентских суток — момент, переживающий любое чтение как UTC. */
function noonAt(day: string): string | null {
  return tashkentInstant(`${day}T12:00:00`)?.toISOString() ?? null;
}

// ── Заливы (R-P8a-2) ────────────────────────────────────────────────────────

/**
 * Залив донора → строка `vending_refill`.
 *
 * Серийник приводится к канону (`C2508160376` → `2508160376`): донор пишет
 * своё написание, OurVend отдаёт вендорское, и раздвоение по ключу здесь
 * стоило бы двойного учёта продаж (`inventory-donor.md` §4.1).
 *
 * Пустой серийник — это 348 из 455 заливов на два ВИРТУАЛЬНЫХ аппарата
 * («Снек-аппараты (общие)»). Они не факт по машине, а агрегат истории, и в
 * `machine_serial NOT NULL` класть их нечем: строка возвращается как
 * `no_serial` и уходит в архив донора, а не в таблицу.
 */
export function mapRefill(row: DonorRefillRow, canon: CanonIndex): Mapped<VendingRefillInsert> | Unresolved {
  const extId = String(row.id);
  const [productName, resolved] = canonicalProductName(row.product, canon);
  const fail = (reason: Unresolved["reason"]): Unresolved => ({ ok: false, reason, extId, product: productName });

  const machineSerial = normalizeMachineSerial(row.machine_serial);
  if (machineSerial.length === 0) return fail("no_serial");

  const day = toDay(row.dt);
  if (day === null) return fail("no_date");
  const performedAt = noonAt(day);
  if (performedAt === null) return fail("no_date");

  // У донора на `refills.qty` стоит CHECK `qty > 0`, а отрицательные заливы
  // импортом истории пропускались. Ноль здесь — тоже не событие заправки.
  const qty = toNumber(row.qty);
  if (qty === null || qty <= 0) return fail("bad_qty");

  return {
    ok: true,
    rawName: resolved ? null : productName,
    row: {
      machineSerial, coilId: null, productName, qty, performedAt,
      clientKey: `stock:refill:${extId}`, source: "stock-import", personId: null, note: IMPORT_NOTE,
    },
  };
}

// ── Инвентаризации склада (R-P8a-3) ─────────────────────────────────────────

/** Момент пересчёта донора (`timestamptz`) → ISO. Строка без зоны читается по Ташкенту. */
function countedInstant(v: string | Date | null): string | null {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
  if (typeof v !== "string" || v.trim().length === 0) return null;
  return tashkentInstant(v)?.toISOString() ?? null;
}

/**
 * Складская инвентаризация донора → строка `vending_stock_count`.
 *
 * `counted_at` донор писал не всегда (колонку добавили позже), а у нас момент
 * `NOT NULL`. Подстановка — полдень ТЕХ ЖЕ ташкентских суток `dt`: полночь
 * при чтении как UTC увела бы пересчёт на предыдущий день.
 *
 * `qty = 0` — законный результат пересчёта («на складе пусто»), у донора на
 * колонке CHECK `qty >= 0`. Поэтому нулю здесь, в отличие от залива, дорога
 * открыта.
 */
export function mapStockCount(row: DonorStockCountRow, canon: CanonIndex): Mapped<VendingStockCountInsert> | Unresolved {
  const extId = String(row.id);
  const [productName, resolved] = canonicalProductName(row.product, canon);
  const fail = (reason: Unresolved["reason"]): Unresolved => ({ ok: false, reason, extId, product: productName });

  if (isServiceProduct(productName)) return fail("service_row");

  const dt = toDay(row.dt);
  if (dt === null) return fail("no_date");

  const qty = toNumber(row.qty);
  if (qty === null || qty < 0) return fail("bad_qty");

  const countedAt = countedInstant(row.counted_at) ?? noonAt(dt);
  if (countedAt === null) return fail("no_date");

  return {
    ok: true,
    rawName: resolved ? null : productName,
    row: { dt, productName, qty, source: "stock-import", extId, countedAt, personId: null, note: IMPORT_NOTE },
  };
}

// ── Сверка закупок (R-P8a-1) ────────────────────────────────────────────────

export interface PurchaseFacts { extId: string; dt: string; product: string; qty: number; unitPrice: number | null }
export interface PurchaseDiff { extId: string; field: "dt" | "product" | "qty" | "unitPrice"; mine: string | number | null; donor: string | number | null }
export interface PurchaseReconcile {
  /** Есть у донора, нет у нас — ДОПИСАТЬ (R-P8a-1). */
  missing: PurchaseFacts[];
  /** Есть у обоих, числа разошлись — только отчёт, править нельзя. */
  differing: PurchaseDiff[];
  /** Есть у нас, нет у донора: 39 удалённых id. Не удалять. */
  onlyMine: string[];
}

/**
 * Допуск сравнения чисел: `numeric(15,2)` у нас против `float` донора.
 * Полкопейки — это округление представления, а не расхождение учёта.
 */
const MONEY_EPS = 0.005;

const sameNumber = (a: number | null, b: number | null): boolean =>
  a === null || b === null ? a === b : Math.abs(a - b) <= MONEY_EPS;

/**
 * Разовая сверка зеркала закупок с донором по `ext_id` (R-P8a-1).
 *
 * ЗАЧЕМ ОНА ВООБЩЕ НУЖНА. Синк закупок берёт только `created_at > now()-3d`, а
 * у ВСЕХ 342 донорских строк `created_at = 2026-07-15` — окно давно пустое, и
 * «синк же работает» ничего не доказывает. Перед заморозкой моста нужен
 * снимок фактов, а не вера в конвейер.
 *
 * ЧТО ЭТА ФУНКЦИЯ НЕ ДЕЛАЕТ. Она не удаляет и не правит. `differing` — отчёт:
 * зеркало заполнял другой код, и молча переписать наши числа донорскими
 * значит потерять единственное свидетельство расхождения. `onlyMine` — это в
 * основном 39 id, удалённых у донора до появления `deletions_log`; удалять их
 * у себя нельзя, донор о них уже ничего не помнит.
 *
 * Имена сравниваются очищенными (энтити + `[слит→N]`), потому что зеркало
 * писало сырое донорское написание: иначе весь HTML-мусор панели попал бы в
 * `differing` ложным расхождением. В `missing` уезжает ЧИСТОЕ имя — новые
 * строки тащить мусор панели не должны.
 */
export function reconcilePurchases(mine: readonly PurchaseFacts[], donor: readonly DonorPurchaseRow[]): PurchaseReconcile {
  const byExtId = new Map(mine.map((m) => [m.extId, m] as const));
  const donorIds = new Set(donor.map((d) => String(d.id)));

  const missing: PurchaseFacts[] = [];
  const differing: PurchaseDiff[] = [];

  for (const d of donor) {
    const extId = String(d.id);
    const facts: PurchaseFacts = {
      extId,
      dt: toDay(d.dt) ?? String(d.dt),
      product: stripMergedMarker(decodeHtml(d.product)),
      qty: toNumber(d.qty) ?? 0,
      unitPrice: toNumber(d.unit_price),
    };

    const ours = byExtId.get(extId);
    if (ours === undefined) {
      missing.push(facts);
      continue;
    }

    const ourDay = toDay(ours.dt) ?? ours.dt;
    if (ourDay !== facts.dt) differing.push({ extId, field: "dt", mine: ourDay, donor: facts.dt });

    const ourProduct = stripMergedMarker(decodeHtml(ours.product));
    if (normalizeProductName(ourProduct) !== normalizeProductName(facts.product)) {
      differing.push({ extId, field: "product", mine: ourProduct, donor: facts.product });
    }

    if (!sameNumber(ours.qty, facts.qty)) differing.push({ extId, field: "qty", mine: ours.qty, donor: facts.qty });
    if (!sameNumber(ours.unitPrice, facts.unitPrice)) {
      differing.push({ extId, field: "unitPrice", mine: ours.unitPrice, donor: facts.unitPrice });
    }
  }

  const onlyMine = mine.filter((m) => !donorIds.has(m.extId)).map((m) => m.extId);
  return { missing, differing, onlyMine };
}
