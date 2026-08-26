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
 * ЧЕТЫРЕ РЕШЕНИЯ, КОТОРЫЕ НЕЛЬЗЯ «УПРОСТИТЬ» (инвентаризация донора 25.08):
 *
 * 1. СОПОСТАВЛЕНИЕ ИМЁН — ТОЛЬКО ТОЧНОЕ, НО ПО ДВУМ КЛЮЧАМ (R-FW-P1). Каталог
 *    донора ≠ канон mydon: 62 карточки, из них 13 помечены `[слит→N]`, два
 *    имени лежат HTML-мусором (`M&amp;Ms`, `O&#39;zbegim`). Одного
 *    `products.name` мало: по нему не разрешались 24 имени — 243 строки из 567,
 *    43 % переноса, — хотя мост в каталог у донора есть и он точный:
 *    `products.ourvend_name` (`inventory-donor.md` §1). Поэтому имя ищется
 *    дважды: сначала донорское, потом `ourvend_name`. Так 13 имён (228 строк)
 *    находят карточку алиасом владельца (`Coca Cola CAN 0.25` → `CocaCola
 *    Classic CAN 250ml` → `Coca-Cola Classic CAN 0,25`), и без карточки
 *    остаются 11 имён / 15 строк.
 *
 *    Нечёткого сравнения нет ни на одном шаге: в остатке стоят `Moxito Mango
 *    CAN 0.45` и `Laimon Mango CAN 0.33` — сравнение «по похожести» склеило бы
 *    330 мл с 450 мл и навсегда испортило историю (`inventory-donor.md` §4.3).
 *    То, что владелец сам свёл `Flash can 0.33` к `Flash Up Energy CAN 0,45`
 *    (и `Plus 18 can 0.33` так же), — ЕГО решение, записанное алиасом в
 *    каталоге и действующее в продажах OurVend, а не наша догадка по буквам.
 *    Не разрешилось — едет сырое ДОНОРСКОЕ имя (владелец видит в панели его, а
 *    не вендорское написание), `product_id` остаётся NULL, строка попадает в
 *    отчёт (R-P8a-7). Ошибка, которую видно, лучше догадки.
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
 *
 * 4. НЕГОДНАЯ СТРОКА ОТКАЗЫВАЕТСЯ ПОИМЁННО, А НЕ РОНЯЕТ ПАЧКУ (R-FW-S2). Донор
 *    — чужая база с чужими заставами: сегодня там CHECK, завтра его правит её
 *    владелец, и одна строка уронила бы вставку на 500 соседей — на каждом
 *    повторе. Поэтому здесь проверяется всё, что Postgres встретил бы уже
 *    внутри пачки: управляющие символы в имени (`&#0;` после `decodeHtml` — это
 *    настоящий U+0000, а на него ответ `invalid byte sequence for encoding
 *    "UTF8": 0x00`), qty вне диапазона КОЛОНКИ (`integer` у заливов,
 *    `numeric(12,2)` у пересчётов) и бесконечность. Причина уезжает в отчёт
 *    (`control_chars`, `out_of_range`), годные строки ложатся.
 */

// ── Донор: как строки отдаёт SQL ────────────────────────────────────────────

/**
 * Строки донора как их отдаёт SQL: числа приходят строками postgres.js.
 *
 * `ourvend_name` — мост донорской карточки в каталог OurVend, из которого вырос
 * прайс mydon (R-FW-P1); пусто у 28 карточек из 62. `location_name` — имя места
 * складской инвентаризации (R-FW-P2): `machine_id is null` у донора значит не
 * «склад», а одно из трёх мест.
 *
 * `product` объявлен допускающим `null` НЕ на всякий случай: карточку тянет
 * LEFT JOIN, чтобы строка без товара попала в «найдено» и в отчёт, а не
 * исчезла из счёта молча (`no_product`).
 */
export interface DonorRefillRow {
  id: number | string; dt: string; machine_serial: string | null; product: string | null; qty: string | number;
  ourvend_name?: string | null;
}
export interface DonorStockCountRow {
  id: number | string; dt: string; product: string | null; qty: string | number; counted_at: string | Date | null;
  ourvend_name?: string | null; location_name?: string | null;
}
/**
 * `unit`/`note`/`total` — ровно те же колонки, что тянет синк снабжения
 * (`supply.service.ts`). Они не участвуют в сверке, но едут в дописываемую
 * строку: иначе она отличалась бы от 342 соседей зеркала пустой единицей и
 * посчитанной в JS суммой. `total` у донора — GENERATED-колонка, считать её
 * второй раз у себя незачем.
 */
export interface DonorPurchaseRow {
  id: number | string; dt: string; product: string | null; qty: string | number; unit_price: string | number | null;
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

/**
 * Строка НЕ легла в таблицу — и почему именно, словом.
 *
 * `out_of_range` и `control_chars` — заставы годности донорской строки
 * (решение 4 в шапке): число вне диапазона колонки и управляющий символ в
 * имени. `no_product` — строка донора без карточки товара вовсе: `product_name`
 * у нас `NOT NULL`, и такую строку нечем назвать. `product` здесь всегда
 * очищен: имя с U+0000 не должно ехать дальше ни в отчёт, ни в jsonb события.
 */
export interface Unresolved {
  ok: false;
  reason: "no_serial" | "service_row" | "bad_qty" | "no_date" | "out_of_range" | "control_chars" | "no_product";
  extId: string;
  product: string;
}
/** Строка легла. `rawName` — имя, которому канона нет: едет сырым, `productId` останется NULL (R-P8a-7). */
export interface Mapped<T> { ok: true; row: T; rawName: string | null }

/** Пометка импорта: по ней видно происхождение строки без похода в `source`. */
const IMPORT_NOTE = "импорт истории mydon-stock";

/** Потолок имени места в `note`: справочник донора его не ограничивает вовсе. */
const PLACE_MAX = 200;

/** Разделитель «пометка · место»: один на запись и на разбор, второй копии нет. */
const PLACE_SEP = " · место: ";

/**
 * Пометка импорта, а у складской инвентаризации — ещё и МЕСТО (R-FW-P2).
 *
 * `machine_id is null` у донора — это не «склад» в единственном числе, а три
 * места: `Склад (основной)` 423 строки, `Холодильник` 20, `Oq apparat (склад)`
 * 17. На 05.07.2026 четыре пары (дата, товар) лежат в ДВУХ местах с разным qty:
 * без имени места история показала бы две строки-близнеца «7» и «10», которые
 * читаются как двойной ввод. Имя едет в `note`, а не в отдельную колонку:
 * своих мест склада в mydon нет вовсе, и заводить справочник ради разового
 * импорта значило бы решить за владельца.
 *
 * Экспортируется ради обратной `placeFromImportNote`: правило записи и правило
 * разбора обязаны стоять рядом и проверяться круговым тестом.
 */
export function importNote(place: string | null | undefined): string {
  const name = typeof place === "string" ? withoutControlChars(place).trim().slice(0, PLACE_MAX) : "";
  return name.length === 0 ? IMPORT_NOTE : `${IMPORT_NOTE}${PLACE_SEP}${name}`;
}

/**
 * Обратная к `importNote`: МЕСТО из пометки импорта, или `null`.
 *
 * ЗАЧЕМ. В `note` уезжает вся строка целиком («импорт истории mydon-stock ·
 * место: Холодильник»), и это правильно: API отдаёт сырые данные, а не
 * причёсанные. Но заголовок группы на листе «История склада» — это ИМЯ МЕСТА, и
 * печатать в нём 30-символьный технический префикс, за которым идёт подпись
 * «место», значит показать владельцу служебную строку вместо ответа.
 *
 * Правило разбора живёт ЗДЕСЬ, рядом с правилом записи, а не в панели: своя
 * копия префикса в витрине разошлась бы с `IMPORT_NOTE` молча — заголовки
 * просто перестали бы сокращаться, и заметить это было бы нечем.
 *
 * `null` возвращается на всём, что местом не является: на своей пометке
 * (`own` — там человек), на пометке импорта БЕЗ места и на любой чужой строке.
 * Витрина тогда печатает `note` как есть — выдумывать «Основной склад» нельзя.
 */
export function placeFromImportNote(note: string): string | null {
  if (!note.startsWith(IMPORT_NOTE)) return null;
  const хвост = note.slice(IMPORT_NOTE.length);
  if (!хвост.startsWith(PLACE_SEP)) return null;
  const место = хвост.slice(PLACE_SEP.length);
  return место.length === 0 ? null : место;
}

// ── Имена товаров ───────────────────────────────────────────────────────────

/** Именованные энтити панели склада: обычный лукап, порядок ключей ни на что не влияет. */
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
      // Только строчное `#x`: у `ENTITY` нет флага `i`, и `&#X41;` под
      // альтернативу не попадает вовсе — остаётся текстом, как всё неизвестное.
      const hex = body[1] === "x";
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

/**
 * Управляющие символы (`\p{Cc}` — C0/C1, включая U+0000).
 *
 * `decodeHtml` честно разворачивает `TUC&#0;` в строку с настоящим U+0000, а
 * Postgres отвечает на этот байт `invalid byte sequence for encoding "UTF8":
 * 0x00` — и падает ПАЧКА, а не строка. Имя с управляющим символом отказывается
 * поимённо, а всё, что всё-таки едет дальше (отчёт, jsonb события, `note`),
 * проходит через `withoutControlChars`.
 */
const CONTROL_CHARS = /\p{Cc}/u;
const CONTROL_CHARS_ALL = /\p{Cc}/gu;

/**
 * Строка без управляющих символов — только такая попадает в отчёты, события
 * и зеркало закупок (`unit`/`note`, R-FW-N3): та же застава, что и у имён
 * товара/места, применённая к свободному донорскому тексту.
 */
export function withoutControlChars(raw: string): string {
  return raw.replace(CONTROL_CHARS_ALL, "");
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

/**
 * Имя донора → канон mydon по ДВУМ точным ключам (R-FW-P1).
 *
 * Донорская карточка знает два имени: своё (`products.name` — как владелец
 * написал его в панели склада) и `ourvend_name` — мост в каталог OurVend, из
 * которого вырос прайс mydon. Спрашивать только первое значит потерять 13 имён
 * (228 строк из 567), у которых мост есть и он ТОЧНЫЙ.
 *
 * Порядок ключей не косметика: своё имя — то, что владелец видит и правит, а
 * `ourvend_name` заполнен у 34 карточек из 62 и приходит от вендора. Поэтому
 * сначала спрашивают донорское имя, и только если карточки нет — мост.
 *
 * Оба поиска точные (решение 1 в шапке). Не нашлось ни по одному — возвращается
 * очищенное ДОНОРСКОЕ имя: вендорское написание владелец у себя не узнает.
 */
export function resolveProductName(
  raw: string,
  ourvend: string | null | undefined,
  canon: CanonIndex,
): [string, boolean] {
  const своё = canonicalProductName(raw, canon);
  if (своё[1]) return своё;
  if (typeof ourvend === "string" && ourvend.trim().length > 0) {
    const мост = canonicalProductName(ourvend, canon);
    if (мост[1]) return мост;
  }
  return своё;
}

/** Карточка прайса и алиас — ровно то, из чего строится индекс каталога. */
export interface ProductRow { id: string; name: string }
export interface AliasRow { productId: string; alias: string }

/** Чем нашлась карточка: точным ИМЕНЕМ прайса или алиасом владельца. */
export type CanonSource = "name" | "alias";

/**
 * Полный ответ индекса — с ИСТОЧНИКОМ решения и с отдельным «спором».
 *
 * `canon`/`id` отвечают одним значением и на спор ответить не могут: `null`
 * там значил бы «карточки нет», а это другое утверждение. Отчёт, который
 * ПОКАЗЫВАЕТ владельцу, почему строка привязана (или почему НЕ привязана),
 * спрашивает `explain`.
 */
export type CanonAnswer =
  | { kind: "hit"; canon: string; id: string; source: CanonSource }
  /** Ключ разрешается ДВУМЯ путями на РАЗНЫЕ карточки: имя одной = алиас другой. */
  | { kind: "conflict"; byName: string; byAlias: string }
  | { kind: "miss" };

/** Индекс каталога: одна сборка — три ответа. */
export interface ProductIndex {
  /** Сырое имя → каноническое ИМЯ прайса. `null` — карточки нет. */
  canon: CanonIndex;
  /** Сырое имя → id карточки. `null` — карточки нет. */
  id: (raw: string) => string | null;
  /**
   * Тот же резолв, но с источником и со «спором» (R-FW-S3).
   *
   * Нужен тому, кто пишет НЕОБРАТИМОЕ: бэкфилл `product_id` трогает только
   * строки с NULL, поэтому ошибочная привязка повторным прогоном уже не
   * чинится — на спорном имени он обязан ОТКАЗАТЬСЯ и назвать спор владельцу.
   * Импорт истории пишет `product_name` (запись повторяема) и обязан ответить
   * хоть что-то, поэтому ему хватает `canon` с правилом «имя карточки главнее».
   */
  explain: (raw: string) => CanonAnswer;
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

  // ТОЧНОЕ ИМЯ КАРТОЧКИ ГЛАВНЕЕ АЛИАСА (R-FW-S3). Было наоборот, и алиас,
  // чей нормализованный ключ совпал с ИМЕНЕМ другой карточки, молча уводил
  // ВСЕ строки этого имени на чужой товар. Имя карточки — то, что владелец
  // видит в прайсе; алиас — вспомогательное написание, и перекрывать им
  // прямое попадание нельзя.
  const explain = (raw: string): CanonAnswer => {
    const key = normalizeProductName(raw);
    const своё = canonByKey.get(key);
    const поАлиасу = aliasByKey.get(key);
    if (своё !== undefined) {
      // Алиас на СВОЮ же карточку — не спор: оба пути дают один и тот же товар.
      if (поАлиасу !== undefined && поАлиасу !== своё) {
        return { kind: "conflict", byName: своё, byAlias: поАлиасу };
      }
      return { kind: "hit", canon: своё, id: idByKey.get(key) ?? "", source: "name" };
    }
    if (поАлиасу !== undefined) {
      const id = idByKey.get(normalizeProductName(поАлиасу));
      if (id !== undefined) return { kind: "hit", canon: поАлиасу, id, source: "alias" };
    }
    return { kind: "miss" };
  };

  // `canon`/`id` СПОРА НЕ ЗНАЮТ: они отвечают по правилу приоритета (имя
  // карточки), потому что их зовёт импорт, а «не знаю» там значит потерянную
  // строку. Отказываться на споре — дело того, кто пишет необратимое.
  const canon: CanonIndex = (raw) => {
    const ответ = explain(raw);
    if (ответ.kind === "hit") return ответ.canon;
    return ответ.kind === "conflict" ? ответ.byName : null;
  };
  return {
    canon,
    id: (raw) => {
      const c = canon(raw);
      return c === null ? null : (idByKey.get(normalizeProductName(c)) ?? null);
    },
    explain,
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

/**
 * Число, которого в колонке не существует: `Infinity`, `"1e400"`, `-1e999`.
 *
 * Для `toNumber` это то же самое `null`, что и «не число», а для отчёта — нет:
 * «негодный qty» и «не влезает в колонку» — разные разговоры с владельцем.
 */
function isInfinite(v: string | number | null | undefined): boolean {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v.trim()) : Number.NaN;
  return !Number.isFinite(n) && !Number.isNaN(n);
}

/** `vending_refill.qty` — INTEGER: на 3e9 Postgres отвечает 22003 посреди пачки. */
const REFILL_QTY_MAX = 2_147_483_647;

/** `vending_stock_count.qty` — `numeric(12,2)`: десять цифр до точки, не больше. */
const COUNT_QTY_LIMIT = 1e10;

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
  const [productName, resolved] = resolveProductName(row.product ?? "", row.ourvend_name, canon);
  const fail = (reason: Unresolved["reason"]): Unresolved =>
    ({ ok: false, reason, extId, product: withoutControlChars(productName) });

  if (productName.length === 0) return fail("no_product");
  if (CONTROL_CHARS.test(productName)) return fail("control_chars");

  const machineSerial = normalizeMachineSerial(row.machine_serial);
  if (machineSerial.length === 0) return fail("no_serial");

  const day = toDay(row.dt);
  if (day === null) return fail("no_date");
  const performedAt = noonAt(day);
  if (performedAt === null) return fail("no_date");

  // У донора на `refills.qty` стоит CHECK `qty > 0`, а отрицательные заливы
  // импортом истории пропускались. Ноль здесь — тоже не событие заправки.
  const qty = toNumber(row.qty);
  if (qty === null) return fail(isInfinite(row.qty) ? "out_of_range" : "bad_qty");
  if (qty <= 0) return fail("bad_qty");
  // Дробь ловит скрипт импорта (`fractional_qty`), а это — переполнение
  // целочисленной колонки: 3e9 «целое», но в `integer` его нет.
  if (qty > REFILL_QTY_MAX) return fail("out_of_range");

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
 *
 * В `note` уезжает МЕСТО пересчёта (`importNote`): складских мест у донора три,
 * и без имени места две строки одного дня по одному товару неразличимы.
 */
export function mapStockCount(row: DonorStockCountRow, canon: CanonIndex): Mapped<VendingStockCountInsert> | Unresolved {
  const extId = String(row.id);
  const [productName, resolved] = resolveProductName(row.product ?? "", row.ourvend_name, canon);
  const fail = (reason: Unresolved["reason"]): Unresolved =>
    ({ ok: false, reason, extId, product: withoutControlChars(productName) });

  if (productName.length === 0) return fail("no_product");
  if (CONTROL_CHARS.test(productName)) return fail("control_chars");
  if (isServiceProduct(productName)) return fail("service_row");

  const dt = toDay(row.dt);
  if (dt === null) return fail("no_date");

  const qty = toNumber(row.qty);
  if (qty === null) return fail(isInfinite(row.qty) ? "out_of_range" : "bad_qty");
  if (qty < 0) return fail("bad_qty");
  if (qty >= COUNT_QTY_LIMIT) return fail("out_of_range");

  const countedAt = countedInstant(row.counted_at) ?? noonAt(dt);
  if (countedAt === null) return fail("no_date");

  return {
    ok: true,
    rawName: resolved ? null : productName,
    row: {
      dt, productName, qty, source: "stock-import", extId, countedAt, personId: null,
      note: importNote(row.location_name),
    },
  };
}

// ── Сверка закупок (R-P8a-1) ────────────────────────────────────────────────

export interface PurchaseFacts { extId: string; dt: string; product: string; qty: number; unitPrice: number | null }
export interface PurchaseDiff { extId: string; field: "dt" | "product" | "qty" | "unitPrice"; mine: string | number | null; donor: string | number | null }
/**
 * Донорская строка, которую дописать НЕЛЬЗЯ: её негодное значение названо (R-FW-S3).
 *
 * `value` — само донорское значение: причина «негодная дата» без самой даты не
 * даёт владельцу ничего, а гадать по id он не обязан. Управляющие символы из
 * него вычищены и длина урезана — это строка для отчёта, а не для базы.
 */
export interface PurchaseReject { extId: string; reason: "no_date" | "bad_qty" | "bad_price" | "no_product"; value: string }
export interface PurchaseReconcile {
  /** Есть у донора, нет у нас — ДОПИСАТЬ (R-P8a-1). */
  missing: PurchaseFacts[];
  /** Есть у обоих, числа разошлись — только отчёт, править нельзя. */
  differing: PurchaseDiff[];
  /**
   * Есть у нас, нет у донора. На проде это ПУСТО: 39 «пропавших» id — дыры
   * НУМЕРАЦИИ донора (max id 381 при 342 строках, удаления до появления
   * `deletions_log`), а не лишние строки зеркала; множества `ext_id` совпали
   * построчно (`adversarial-prod-data.md` §10). Появится непустой список —
   * это разговор с владельцем, а не повод удалять: донор о таких строках уже
   * ничего не помнит.
   */
  onlyMine: string[];
  /** Негодные строки донора: в зеркало не поехали, причина названа (R-FW-S3). */
  rejected: PurchaseReject[];
}

/**
 * Допуск сравнения чисел: `numeric(15,2)` у нас против `float` донора.
 * Полкопейки — это округление представления, а не расхождение учёта.
 */
const MONEY_EPS = 0.005;

const sameNumber = (a: number | null, b: number | null): boolean =>
  a === null || b === null ? a === b : Math.abs(a - b) <= MONEY_EPS;

/** Имя из панели склада: энтити развёрнуты, `[слит→N]` снят, управляющих символов нет. */
function cleanName(raw: string | null | undefined): string {
  return withoutControlChars(stripMergedMarker(decodeHtml(typeof raw === "string" ? raw : ""))).trim();
}

/** Отказ с ЧИТАЕМЫМ значением: без управляющих символов и без простыни на экран. */
function отказ(extId: string, reason: PurchaseReject["reason"], value: unknown): PurchaseReject {
  return { extId, reason, value: withoutControlChars(String(value ?? "")).slice(0, 120) };
}

/** «Цена не задана» — законно; «цена — это буквы» — нет. */
function priceMissing(v: string | number | null | undefined): boolean {
  return v === null || v === undefined || (typeof v === "string" && v.trim().length === 0);
}

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
 * значит потерять единственное свидетельство расхождения.
 *
 * ЧТО ОНА НЕ ПИШЕТ (R-FW-S3). У заливов и пересчётов заставы годности есть, а
 * у сверки не было вовсе — при том что дописывает она в ЗЕРКАЛО, которое
 * обязана только дополнять. `toNumber(qty) ?? 0` молча превращал мусор в
 * настоящий ноль, а негодная дата уезжала в `date NOT NULL` и роняла пачку.
 * Теперь негодная строка, которой у нас нет, не дописывается вовсе и
 * называется в `rejected`; та же негодность у строки, которая у нас ЕСТЬ, —
 * обычное расхождение, и в `differing` едет СЫРОЕ донорское значение, а не
 * придуманный за донора ноль. На нынешнем доноре ни то ни другое не
 * воспроизводится (CHECK `qty > 0`, `dt date`) — но это его заставы, не наши.
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
  const rejected: PurchaseReject[] = [];

  for (const d of donor) {
    const extId = String(d.id);
    const day = toDay(d.dt);
    const qty = toNumber(d.qty);
    const product = cleanName(d.product);
    const unitPrice = toNumber(d.unit_price);

    const ours = byExtId.get(extId);
    if (ours === undefined) {
      // Дописываем ТОЛЬКО годную строку: зеркало сверка дополняет, а не портит.
      if (product.length === 0) rejected.push(отказ(extId, "no_product", d.product));
      else if (day === null) rejected.push(отказ(extId, "no_date", d.dt));
      else if (qty === null || qty <= 0) rejected.push(отказ(extId, "bad_qty", d.qty));
      else if (unitPrice === null && !priceMissing(d.unit_price)) {
        rejected.push(отказ(extId, "bad_price", d.unit_price));
      } else if (day !== null && qty !== null) missing.push({ extId, dt: day, product, qty, unitPrice });
      continue;
    }

    const ourDay = toDay(ours.dt) ?? ours.dt;
    const donorDay = day ?? String(d.dt);
    if (ourDay !== donorDay) differing.push({ extId, field: "dt", mine: ourDay, donor: donorDay });

    const ourProduct = cleanName(ours.product);
    if (normalizeProductName(ourProduct) !== normalizeProductName(product)) {
      differing.push({ extId, field: "product", mine: ourProduct, donor: product });
    }

    // Негодное число донора — расхождение с СЫРЫМ значением: «у донора 0» там,
    // где у него «н/д», было бы нашей выдумкой в отчёте о его данных.
    if (qty === null) differing.push({ extId, field: "qty", mine: ours.qty, donor: String(d.qty) });
    else if (!sameNumber(ours.qty, qty)) differing.push({ extId, field: "qty", mine: ours.qty, donor: qty });

    if (unitPrice === null && !priceMissing(d.unit_price)) {
      differing.push({ extId, field: "unitPrice", mine: ours.unitPrice, donor: String(d.unit_price) });
    } else if (!sameNumber(ours.unitPrice, unitPrice)) {
      differing.push({ extId, field: "unitPrice", mine: ours.unitPrice, donor: unitPrice });
    }
  }

  const onlyMine = mine.filter((m) => !donorIds.has(m.extId)).map((m) => m.extId);
  return { missing, differing, onlyMine, rejected };
}
