/**
 * Разовый перенос истории склада из донора `mydon-stock` (П8a, R-P8a-8).
 *
 * ЧТО ПЕРЕНОСИТ. Три вещи, которых в mydon нет вовсе:
 *   · заливы по РЕАЛЬНЫМ автоматам (107 из 455) → `vending_refill`;
 *   · складские инвентаризации (460 из 603) → `vending_stock_count`;
 *   · закупки — НЕ переносит, а СВЕРЯЕТ (R-P8a-1): зеркало `purchase`
 *     (`source='stock'`) уже полное, дописываются только отсутствующие строки.
 *
 * Остальное не переносится намеренно и это решение, а не недоделка: 348
 * «общих» заливов висят на двух виртуальных аппаратах без серийника (агрегат,
 * а не факт по машине), 143 машинные инвентаризации конфликтуют по ключу с
 * уже залитым снимком OurVend, единственная ручная продажа — тестовый ввод на
 * 0 сум. Всё это живёт в архивном дампе донора (R-P8a-5), а не здесь.
 *
 * ПОЧЕМУ СКРИПТ, А НЕ МИГРАЦИЯ. Резолв имени товара — это КОД (`vending_alias`
 * + `normalizeProductName`), а не SQL-выражение; повторить его в миграции
 * значило бы завести вторую реализацию правила, которая разойдётся с Core на
 * первом же новом алиасе. Ровно та же причина, что у `backfill-product-ids.ts`,
 * и тот же общий индекс каталога (`productIndex` из `@mydon/shared`).
 *
 * ДОНОР ЧИТАЕТСЯ ТОЛЬКО НА ЧТЕНИЕ. Подключение к `STOCK_DATABASE_URL`
 * открывается с `max: 1` и исполняет исключительно SELECT: чужая база — это
 * источник, у которого свой владелец и свой бот, и правка в ней отсюда была бы
 * невидимой для них обоих.
 *
 * ИДЕМПОТЕНТЕН ПО КЛЮЧУ, А НЕ ПО СОДЕРЖИМОМУ. `vending_refill` защищён
 * `client_key = 'stock:refill:<id>'`, `vending_stock_count` — частичным
 * UNIQUE `(source, ext_id)`, `purchase` — `(source, ext_id)`. Дедупа по
 * (дата, товар, qty) НЕТ и быть не должно: у донора 7 групп заливов и 5 групп
 * инвентаризаций совпадают по содержимому НАМЕРЕННО (`archive/seed_*.py`
 * вносил заправку и пересчёт «после» двумя записями одного события). Повторный
 * `--apply` записывает ноль строк — и говорит именно «ноль», потому что
 * `written` считается по длине `returning()`, а не по длине входа.
 *
 * ПРИМЕРКА ПОКАЗЫВАЕТ, ЧТО НАПИШЕТ ЗАПИСЬ. В отчёте есть колонка «к записи»:
 * в `--dry-run` она и есть ответ на вопрос «что будет», а в `--apply` рядом с
 * ней стоит «записано», и расхождение между ними читается сразу — именно так
 * повторный прогон честно говорит «к записи 107, записано 0, всё уже лежит».
 *
 * Запуск (шаг выкатки, ДВА прогона — сначала пробный):
 *   node packages/db/dist/import-stock-history.js --dry-run </dev/null
 *   node packages/db/dist/import-stock-history.js --apply   </dev/null
 */
import path from "node:path";
import { config as loadEnv } from "dotenv";
import { eq, sql } from "drizzle-orm";
import postgres from "postgres";
import {
  machineSerialKeys,
  mapRefill,
  mapStockCount,
  productIndex,
  reconcilePurchases,
  strictNumber,
  type DonorPurchaseRow,
  type DonorRefillRow,
  type DonorStockCountRow,
  type PurchaseDiff,
  type PurchaseFacts,
  type Unresolved,
} from "@mydon/shared";
import { createDb, type Database } from "./index";
import { entity, event, purchase, vendingAlias, vendingProduct, vendingRefill, vendingStockCount } from "./schema";

/**
 * Чтение донора отделено от записи: тесту нужны массивы, а не Postgres.
 *
 * Без этого шва единственным способом проверить правила переноса был бы живой
 * донор — то есть проверка, которую нельзя выполнить ни в CI, ни на ноутбуке.
 */
export interface DonorReader {
  refills(): Promise<DonorRefillRow[]>;
  stockCounts(): Promise<DonorStockCountRow[]>;
  purchases(): Promise<DonorPurchaseRow[]>;
}

/**
 * Причина, по которой строка донора НЕ поехала.
 *
 * Четыре приходят из маппинга (`@mydon/shared`), пятая — наша: колонка
 * `vending_refill.qty` целочисленная, а у донора `NUMERIC`.
 */
export type SkipReason = Unresolved["reason"] | "fractional_qty";

/** Причина → id донорских строк. Счёт — это длина списка, отдельно его не держим. */
export type SkipLog = Partial<Record<SkipReason, string[]>>;

export interface ImportSection {
  /** Сколько строк отдал донор. */
  found: number;
  /** Сколько строк ГОДНЫ к записи — ответ примерки на «что будет». */
  toWrite: number;
  /** Сколько РЕАЛЬНО легло (длина `returning()`), а не сколько отправили. */
  written: number;
  skipped: number;
  /** Все причины отказа поимённо: «пропущено 348» без причины — не отчёт. */
  reasons: SkipLog;
}

export interface StockHistoryReport {
  apply: boolean;
  refills: ImportSection & { noSerial: number; fractionalQty: string[] };
  stockCounts: ImportSection & { serviceRows: number };
  purchases: { mine: number; donor: number; toWrite: number; added: number; differing: PurchaseDiff[]; onlyMine: number };
  /** Имена без карточки прайса — уезжают в отчёт и в событие (R-P8a-7). */
  unresolved: string[];
}

/**
 * Запись оборвалась на середине — но отчёт по уже сделанному есть.
 *
 * Частичная запись здесь допустима (каждая пачка идемпотентна, повтор дожмёт),
 * а вот молчание о ней — нет: оператор разового шага выкатки обязан узнать,
 * сколько строк успело лечь, до того как увидит текст ошибки.
 */
export class ImportWriteFailure extends Error {
  constructor(
    readonly report: StockHistoryReport,
    readonly reason: unknown,
  ) {
    super(reason instanceof Error ? reason.message : String(reason));
    this.name = "ImportWriteFailure";
  }
}

/** Пачка вставки — как у синка снабжения: 500 строк за запрос. */
const BATCH = 500;

/** Отметка импорта в журнале и `source` его строк — одно слово на весь срез. */
const IMPORT_SOURCE = "stock-import";
const IMPORT_EVENT = "stock.history.imported";

// ── Учёт отказов ────────────────────────────────────────────────────────────

function отложить(log: SkipLog, reason: SkipReason, extId: string): void {
  const список = log[reason];
  if (список) список.push(extId);
  else log[reason] = [extId];
}

function сколько(log: SkipLog, reason: SkipReason): number {
  return log[reason]?.length ?? 0;
}

/** Карта «серийник → карточка автомата» по ОБЕИМ формам написания (`machineSerialKeys`). */
function machineIdBySerial(rows: readonly { id: string; externalRef: string | null }[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const r of rows) {
    for (const key of machineSerialKeys(r.externalRef)) {
      // Первая карточка выигрывает — как в Core: дубли по серийнику это
      // вопрос к реестру, а не повод молча перезаписать привязку.
      if (!out.has(key)) out.set(key, r.id);
    }
  }
  return out;
}

// ── Перенос ─────────────────────────────────────────────────────────────────

/** Вставка пачками. `written` — по длине `returning()`: сколько РЕАЛЬНО легло. */
async function insertBatched<T>(rows: readonly T[], run: (batch: T[]) => Promise<unknown[]>): Promise<number> {
  let written = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const res = await run(rows.slice(i, i + BATCH));
    written += res.length;
  }
  return written;
}

/** `count(*)` одной колонкой: заглушка теста отдаёт то же, что настоящий Postgres. */
async function число(rows: Promise<{ n: unknown }[]>): Promise<number> {
  return Number((await rows)[0]?.n ?? 0);
}

export async function importStockHistory(
  db: Database,
  donor: DonorReader,
  opts: { apply: boolean },
): Promise<StockHistoryReport> {
  const [products, aliases, machines] = await Promise.all([
    db.select({ id: vendingProduct.id, name: vendingProduct.name }).from(vendingProduct),
    db.select({ productId: vendingAlias.productId, alias: vendingAlias.alias }).from(vendingAlias),
    db.select({ id: entity.id, externalRef: entity.externalRef }).from(entity).where(eq(entity.type, "machine")),
  ]);
  const каталог = productIndex(products, aliases);
  const idBySerial = machineIdBySerial(machines);

  /** Имена без карточки прайса — общий список на все источники (R-P8a-7). */
  const unresolved = new Set<string>();

  // ── Заливы (R-P8a-2) ──
  const donorRefills = await donor.refills();
  const refillValues: (typeof vendingRefill.$inferInsert)[] = [];
  const refillSkips: SkipLog = {};
  for (const row of donorRefills) {
    const m = mapRefill(row, каталог.canon);
    if (!m.ok) {
      отложить(refillSkips, m.reason, m.extId);
      continue;
    }
    // `refills.qty` донора — NUMERIC, наша колонка — INTEGER. Дробь, дошедшая
    // до Postgres, уронила бы ПАЧКУ целиком ('6.5'::int4), и разовый шаг
    // выкатки выглядел бы сломанным вместо «одна строка не влезла».
    if (!Number.isInteger(m.row.qty)) {
      отложить(refillSkips, "fractional_qty", String(row.id));
      continue;
    }
    if (m.rawName !== null) unresolved.add(m.rawName);
    refillValues.push({
      machineId: idBySerial.get(m.row.machineSerial) ?? null,
      machineSerial: m.row.machineSerial,
      coilId: m.row.coilId,
      productId: каталог.id(m.row.productName),
      productName: m.row.productName,
      qty: m.row.qty,
      personId: m.row.personId,
      performedAt: new Date(m.row.performedAt),
      clientKey: m.row.clientKey,
      source: m.row.source,
      note: m.row.note,
    });
  }

  // ── Инвентаризации склада (R-P8a-3) ──
  const donorCounts = await donor.stockCounts();
  const countValues: (typeof vendingStockCount.$inferInsert)[] = [];
  const countSkips: SkipLog = {};
  for (const row of donorCounts) {
    const m = mapStockCount(row, каталог.canon);
    if (!m.ok) {
      отложить(countSkips, m.reason, m.extId);
      continue;
    }
    if (m.rawName !== null) unresolved.add(m.rawName);
    countValues.push({
      dt: m.row.dt,
      productName: m.row.productName,
      productId: каталог.id(m.row.productName),
      qty: String(m.row.qty),
      source: m.row.source,
      extId: m.row.extId,
      countedAt: new Date(m.row.countedAt),
      personId: m.row.personId,
      note: m.row.note,
    });
  }

  // ── Сверка закупок (R-P8a-1) ──
  const donorPurchases = await donor.purchases();
  const mineRows = await db
    .select({
      extId: purchase.extId,
      dt: purchase.dt,
      product: purchase.product,
      qty: purchase.qty,
      unitPrice: purchase.unitPrice,
    })
    .from(purchase)
    .where(eq(purchase.source, "stock"));
  const mine: PurchaseFacts[] = mineRows.map((r) => ({
    extId: String(r.extId),
    dt: String(r.dt),
    product: String(r.product),
    qty: strictNumber(r.qty) ?? 0,
    // Пусто — законно «цены нет» (158 строк прихода напитков 2025), а не ноль.
    unitPrice: r.unitPrice === null ? null : strictNumber(r.unitPrice),
  }));
  const { missing, differing, onlyMine } = reconcilePurchases(mine, donorPurchases);
  // Дописанная строка обязана быть НЕОТЛИЧИМА от 342 соседей зеркала: те же
  // `unit`, `note` и `total` из донора, что тянет синк снабжения. `total` у
  // донора — GENERATED-колонка (qty*unit_price); считать её второй раз в
  // плавающей точке значит завести собственную версию суммы.
  const donorById = new Map(donorPurchases.map((d) => [String(d.id), d] as const));
  const purchaseValues: (typeof purchase.$inferInsert)[] = missing.map((p) => {
    const d = donorById.get(p.extId);
    const total = strictNumber(d?.total ?? null);
    return {
      extId: p.extId,
      dt: p.dt,
      product: p.product,
      unit: d?.unit ? String(d.unit) : null,
      qty: String(p.qty),
      unitPrice: p.unitPrice === null ? null : String(p.unitPrice),
      total: total === null ? null : String(total),
      note: d?.note ? String(d.note).slice(0, 1000) : null,
      source: "stock",
    };
  });

  const report: StockHistoryReport = {
    apply: opts.apply,
    refills: {
      found: donorRefills.length,
      toWrite: refillValues.length,
      written: 0,
      skipped: donorRefills.length - refillValues.length,
      reasons: refillSkips,
      noSerial: сколько(refillSkips, "no_serial"),
      fractionalQty: refillSkips.fractional_qty ?? [],
    },
    stockCounts: {
      found: donorCounts.length,
      toWrite: countValues.length,
      written: 0,
      skipped: donorCounts.length - countValues.length,
      reasons: countSkips,
      serviceRows: сколько(countSkips, "service_row"),
    },
    purchases: {
      mine: mine.length,
      donor: donorPurchases.length,
      toWrite: purchaseValues.length,
      added: 0,
      differing,
      onlyMine: onlyMine.length,
    },
    unresolved: [...unresolved].sort((a, b) => a.localeCompare(b, "ru")),
  };

  if (!opts.apply) return report;

  try {
    // Транзакции на весь перенос нет намеренно: каждая пачка идемпотентна по
    // уникальному ключу, поэтому оборванный прогон не оставляет состояния,
    // которое нельзя починить — повтор просто дописывает недостающее. Одна
    // транзакция на 460 строк добавила бы только длинную блокировку.
    report.refills.written = await insertBatched(refillValues, (batch) =>
      db
        .insert(vendingRefill)
        .values(batch)
        .onConflictDoNothing({ target: vendingRefill.clientKey })
        .returning({ id: vendingRefill.id }),
    );
    report.stockCounts.written = await insertBatched(countValues, (batch) =>
      db
        .insert(vendingStockCount)
        .values(batch)
        // `where` у `onConflictDoNothing` — это ПРЕДИКАТ ЧАСТИЧНОГО ИНДЕКСА
        // (drizzle подставляет его сразу после списка колонок), без него
        // Postgres не выведет `vending_stock_count_src_key` и ответит
        // «no unique or exclusion constraint matching the ON CONFLICT».
        .onConflictDoNothing({
          target: [vendingStockCount.source, vendingStockCount.extId],
          where: sql`${vendingStockCount.extId} is not null`,
        })
        .returning({ id: vendingStockCount.id }),
    );
    report.purchases.added = await insertBatched(purchaseValues, (batch) =>
      db
        .insert(purchase)
        .values(batch)
        .onConflictDoNothing({ target: [purchase.source, purchase.extId] })
        .returning({ id: purchase.id }),
    );

    if (await нуженСлед(db, report.refills.written + report.stockCounts.written + report.purchases.added)) {
      await db.insert(event).values([
        {
          source: IMPORT_SOURCE,
          type: IMPORT_EVENT,
          payload: {
            refills: report.refills.written,
            stockCounts: report.stockCounts.written,
            purchasesAdded: report.purchases.added,
            unresolved: report.unresolved,
            skippedNoSerial: report.refills.noSerial,
            skippedService: report.stockCounts.serviceRows,
          },
        },
      ]);
    }
  } catch (err) {
    throw new ImportWriteFailure(report, err);
  }

  return report;
}

/**
 * Ставить ли отметку `stock.history.imported` (R-P8a-5).
 *
 * ДА, если этот прогон что-то записал, — обычный случай.
 *
 * И ТАКЖЕ ДА, если отметки в журнале нет, а строки импорта в базе есть. Это
 * дыра, которую иначе не закрыть ничем, кроме ручного INSERT: процесс умер
 * между последней пачкой и записью события (или упало само событие) — строки
 * лежат, следа нет, и КАЖДЫЙ следующий `--apply` запишет ноль, то есть
 * «записал → ставим отметку» не сработает уже никогда. Проверка §6 выкатки
 * (`count(*) … = 1`) стала бы невыполнимой на ровном месте.
 *
 * Отметка при этом не задвоится: как только она есть, первое условие ложно,
 * а второе гасится её же наличием.
 */
async function нуженСлед(db: Database, всего: number): Promise<boolean> {
  if (всего > 0) return true;
  const [отметок, заливов, пересчётов] = await Promise.all([
    число(db.select({ n: sql<number>`count(*)` }).from(event).where(eq(event.type, IMPORT_EVENT))),
    число(db.select({ n: sql<number>`count(*)` }).from(vendingRefill).where(eq(vendingRefill.source, IMPORT_SOURCE))),
    число(db.select({ n: sql<number>`count(*)` }).from(vendingStockCount).where(eq(vendingStockCount.source, IMPORT_SOURCE))),
  ]);
  return отметок === 0 && заливов + пересчётов > 0;
}

// ── Донор через postgres.js ─────────────────────────────────────────────────

/**
 * Донор `mydon-stock` — ТОЛЬКО SELECT.
 *
 * `schema` нужна РОВНО дымовому прогону, где фикстурный донор лежит в той же
 * базе отдельной схемой; на проде донор — своя БД, и `STOCK_SCHEMA` не
 * задаётся. Параметр URL `?options=-c search_path=…` не используем осознанно:
 * его разбор postgres.js мы не проверяли, а угадывать в разовом скрипте,
 * который запускают по живой базе, нечего.
 */
export function sqlDonor(url: string, schema = "public"): { reader: DonorReader; close(): Promise<void> } {
  // Те же параметры, что у синка снабжения (`supply.service.ts`): один
  // коннект, без prepared statements, с внятным таймаутом соединения.
  const client = postgres(url, { prepare: false, max: 1, connect_timeout: 10 });
  const reader: DonorReader = {
    // Только заливы по РЕАЛЬНЫМ аппаратам получают серийник; у виртуальных он
    // NULL, и маппинг отложит их сам (`no_serial`) — фильтровать в SQL нельзя,
    // иначе отчёт «найдено» соврал бы, скрыв 348 строк из виду.
    refills: async () =>
      (await client`
        select r.id, r.dt::text as dt, m.serial as machine_serial, p.name as product, r.qty
          from ${client(schema)}.refills r
          join ${client(schema)}.machines m on m.id = r.machine_id
          join ${client(schema)}.products p on p.id = r.product_id
         order by r.id`) as unknown as DonorRefillRow[],
    // `machine_id is null` — это СКЛАД (донорский CHECK держит ровно одно из
    // machine_id/location_id). 143 машинные инвентаризации сюда не попадают.
    stockCounts: async () =>
      (await client`
        select s.id, s.dt::text as dt, p.name as product, s.qty, s.counted_at
          from ${client(schema)}.stock_counts s
          join ${client(schema)}.products p on p.id = s.product_id
         where s.machine_id is null
         order by s.id`) as unknown as DonorStockCountRow[],
    // `unit`/`note`/`total` — те же колонки, что у синка снабжения: строка,
    // дописанная сверкой, не должна отличаться от соседей зеркала.
    purchases: async () =>
      (await client`
        select pu.id, pu.dt::text as dt, p.name as product, p.unit, pu.qty, pu.unit_price, pu.total, pu.note
          from ${client(schema)}.purchases pu
          join ${client(schema)}.products p on p.id = pu.product_id
         order by pu.id`) as unknown as DonorPurchaseRow[],
  };
  return { reader, close: async () => client.end({ timeout: 5 }) };
}

// ── Отчёт ───────────────────────────────────────────────────────────────────

/** Причина отказа словами: «пропущено 348» без объяснения — не отчёт, а загадка. */
const ПРИЧИНЫ: Record<SkipReason, string> = {
  no_serial: "без серийника (агрегат, в архив)",
  service_row: "служебная строка",
  bad_qty: "негодный qty",
  no_date: "негодная дата",
  fractional_qty: "дробный qty (колонка целочисленная)",
};

/** Список в одну строку: не больше 20, остальные — числом. */
function перечислить(items: readonly string[], предел = 20): string {
  return items.length <= предел ? items.join(", ") : `${items.slice(0, предел).join(", ")} и ещё ${items.length - предел}`;
}

/** Все НЕНУЛЕВЫЕ причины подряд, каждая с id: строка без причины ничего не объясняет. */
function причины(log: SkipLog): string {
  const части = (Object.keys(ПРИЧИНЫ) as SkipReason[])
    .filter((r) => сколько(log, r) > 0)
    .map((r) => `${ПРИЧИНЫ[r]} ${сколько(log, r)}`);
  return части.length === 0 ? "—" : части.join(", ");
}

function строкаТаблицы(источник: string, s: ImportSection): string {
  return (
    `${источник.padEnd(38)}${String(s.found).padStart(8)}${String(s.toWrite).padStart(10)}` +
    `${String(s.written).padStart(10)}${String(s.skipped).padStart(11)}  ${причины(s.reasons)}`
  );
}

/** Отложенные строки поимённо — чтобы расхождение не пришлось ловить арифметикой. */
function отложенные(что: string, log: SkipLog): string[] {
  return (Object.keys(ПРИЧИНЫ) as SkipReason[])
    .filter((r) => сколько(log, r) > 0 && r !== "no_serial")
    .map((r) => `  ${что}, ${ПРИЧИНЫ[r]} (${сколько(log, r)}): id ${перечислить(log[r] ?? [])}`);
}

export function formatReport(r: StockHistoryReport): string {
  const строки: string[] = [];
  // Режим — ПЕРВОЙ строкой, до всяких чисел: читающий отчёт должен узнать, что
  // это была примерка, раньше, чем поверит цифре «записано».
  строки.push(
    r.apply
      ? "Импорт истории склада mydon-stock — РЕЖИМ --apply: строки ЗАПИСАНЫ."
      : "Импорт истории склада mydon-stock — РЕЖИМ --dry-run: НИЧЕГО не записано, это примерка. Колонка «к записи» — что сделает --apply.",
  );
  строки.push("");
  строки.push(
    `${"источник".padEnd(38)}${"найдено".padStart(8)}${"к записи".padStart(10)}${"записано".padStart(10)}${"пропущено".padStart(11)}  почему пропущено`,
  );
  строки.push(строкаТаблицы("заливы → vending_refill", r.refills));
  строки.push(строкаТаблицы("инвентаризации → vending_stock_count", r.stockCounts));
  строки.push(
    `${"закупки → purchase (сверка)".padEnd(38)}${String(r.purchases.donor).padStart(8)}` +
      `${String(r.purchases.toWrite).padStart(10)}${String(r.purchases.added).padStart(10)}${"—".padStart(11)}  ` +
      `у нас ${r.purchases.mine}, только у нас ${r.purchases.onlyMine}, расхождений ${r.purchases.differing.length}`,
  );
  строки.push("");

  const отказы = [...отложенные("заливы", r.refills.reasons), ...отложенные("инвентаризации", r.stockCounts.reasons)];
  if (отказы.length > 0) {
    строки.push("Отложенные строки поимённо (кроме «общих» заливов — их 348 и они ожидаемы):");
    строки.push(...отказы);
  }

  строки.push(
    r.unresolved.length === 0
      ? "Имена без карточки прайса: нет — весь перенос лёг с product_id."
      : `Имена без карточки прайса (${r.unresolved.length}) — строки импортированы с product_id = NULL, это список владельцу:`,
  );
  if (r.unresolved.length > 0) строки.push(`  ${перечислить(r.unresolved)}`);

  if (r.purchases.differing.length > 0) {
    // Расхождения НЕ правятся (R-P8a-1): зеркало заполнял другой код, и молча
    // переписать наши числа донорскими значит потерять свидетельство.
    строки.push(`Расхождения закупок (${r.purchases.differing.length}) — только названы, ничего не переписано:`);
    for (const d of r.purchases.differing.slice(0, 20)) {
      строки.push(`  ext_id ${d.extId} · ${d.field}: у нас ${String(d.mine)} / у донора ${String(d.donor)}`);
    }
    if (r.purchases.differing.length > 20) строки.push(`  … и ещё ${r.purchases.differing.length - 20}`);
  }

  строки.push("");
  // Разборная строка: её парсит дымовой прогон и по ней же сверяется выкатка.
  // `toWrite` рядом с записанным намеренно: на повторе они разойдутся, и это
  // единственный способ отличить «нечего писать» от «не сумел записать».
  строки.push(
    `ИТОГИ(json): ${JSON.stringify({
      apply: r.apply,
      refills: r.refills.written,
      stockCounts: r.stockCounts.written,
      purchasesAdded: r.purchases.added,
      toWrite: { refills: r.refills.toWrite, stockCounts: r.stockCounts.toWrite, purchasesAdded: r.purchases.toWrite },
      unresolved: r.unresolved.length,
    })}`,
  );
  return строки.join("\n");
}

// ── Точка входа ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  loadEnv({ path: path.resolve(__dirname, "../../../.env"), quiet: true });

  const apply = process.argv.includes("--apply");
  const dryRun = process.argv.includes("--dry-run");
  if (apply && dryRun) {
    console.error("--apply и --dry-run вместе не имеют смысла: первый пишет, второй обещает не писать. Выберите один.");
    process.exit(1);
  }

  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL не задан — писать историю склада некуда.");
    process.exit(1);
  }
  const donorUrl = process.env.STOCK_DATABASE_URL;
  if (!donorUrl) {
    // Отдельный код возврата: «донор не подключён» — это не поломка скрипта, а
    // не выданное окружение, и на проде это разные разговоры.
    console.error("STOCK_DATABASE_URL не задан — донор mydon-stock не подключён, читать нечего.");
    process.exit(2);
  }

  // `||`, а не `??`: пустая строка в переменной — это «не задано», а не схема
  // с пустым именем, из которой вышло бы `"".refills` и невнятная ошибка.
  const { reader, close } = sqlDonor(donorUrl, process.env.STOCK_SCHEMA || "public");
  try {
    console.log(formatReport(await importStockHistory(createDb(url), reader, { apply })));
  } finally {
    await close();
  }
  // Как в seed.ts/backfill-product-ids.ts: postgres.js держит соединение
  // открытым, и без явного выхода ручной шаг выкатки висит после того, как
  // всё сделано.
  process.exit(0);
}

if (require.main === module) {
  main().catch((err: unknown) => {
    // Отчёт по уже сделанному — ПЕРЕД текстом ошибки: частичная запись
    // допустима, молчание о её размере — нет.
    if (err instanceof ImportWriteFailure) console.log(formatReport(err.report));
    console.error("Импорт истории склада упал:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
