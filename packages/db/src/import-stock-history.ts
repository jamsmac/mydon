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
 * первом же новом алиасе. Ровно та же причина, что у `backfill-product-ids.ts`.
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
  normalizeProductName,
  reconcilePurchases,
  strictNumber,
  type CanonIndex,
  type DonorPurchaseRow,
  type DonorRefillRow,
  type DonorStockCountRow,
  type PurchaseDiff,
  type PurchaseFacts,
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

export interface ImportSection {
  found: number;
  written: number;
  skipped: number;
}

export interface StockHistoryReport {
  apply: boolean;
  /** `fractionalQty` — id заливов с дробным qty: INTEGER у нас, NUMERIC у донора. */
  refills: ImportSection & { noSerial: number; fractionalQty: string[] };
  stockCounts: ImportSection & { serviceRows: number };
  purchases: { mine: number; donor: number; added: number; differing: PurchaseDiff[]; onlyMine: number };
  /** Имена без карточки прайса — уезжают в отчёт и в событие (R-P8a-7). */
  unresolved: string[];
}

/** Пачка вставки — как у синка снабжения: 500 строк за запрос. */
const BATCH = 500;

// ── Канон имени товара ──────────────────────────────────────────────────────

/**
 * Карта канона имени товара — то же правило, что у Core, но с другим ответом.
 *
 * `resolveProductIds` (backfill) отдаёт `id`, а маппингу истории нужно ИМЯ:
 * `vending_refill.product_name` и `vending_stock_count.product_name` хранят
 * канон словами, чтобы отчёт за прошлый месяц не менял содержание, когда
 * товар переименуют. Поэтому здесь строится вторая проекция того же индекса —
 * алиас → канон и канон → id, — а не копия чужого правила: нормализация одна
 * и та же (`normalizeProductName`), и алиас на удалённый товар в карту не
 * попадает так же, как там.
 */
export function buildCanonIndex(
  products: readonly { id: string; name: string }[],
  aliases: readonly { productId: string; alias: string }[],
): { canon: CanonIndex; idByName: (name: string) => string | null } {
  const nameById = new Map(products.map((p) => [p.id, p.name]));
  const aliasByKey = new Map<string, string>();
  for (const a of aliases) {
    const canonical = nameById.get(a.productId);
    // Алиас на удалённый товар — не повод привязать строку к чему попало.
    if (canonical) aliasByKey.set(normalizeProductName(a.alias), canonical);
  }
  const canonByKey = new Map(products.map((p) => [normalizeProductName(p.name), p.name]));
  const idByKey = new Map(products.map((p) => [normalizeProductName(p.name), p.id]));

  return {
    canon: (raw) => {
      const key = normalizeProductName(raw);
      return aliasByKey.get(key) ?? canonByKey.get(key) ?? null;
    },
    idByName: (name) => idByKey.get(normalizeProductName(name)) ?? null,
  };
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
  const { canon, idByName } = buildCanonIndex(products, aliases);
  const idBySerial = machineIdBySerial(machines);

  /** Имена без карточки прайса — общий список на все источники (R-P8a-7). */
  const unresolved = new Set<string>();

  // ── Заливы (R-P8a-2) ──
  const donorRefills = await donor.refills();
  const refillValues: (typeof vendingRefill.$inferInsert)[] = [];
  const fractionalQty: string[] = [];
  let noSerial = 0;
  for (const row of donorRefills) {
    const m = mapRefill(row, canon);
    if (!m.ok) {
      if (m.reason === "no_serial") noSerial += 1;
      continue;
    }
    // `refills.qty` донора — NUMERIC, наша колонка — INTEGER. Дробь, дошедшая
    // до Postgres, уронила бы ПАЧКУ целиком ('6.5'::int4), и разовый шаг
    // выкатки выглядел бы сломанным вместо «одна строка не влезла».
    if (!Number.isInteger(m.row.qty)) {
      fractionalQty.push(String(row.id));
      continue;
    }
    if (m.rawName !== null) unresolved.add(m.rawName);
    refillValues.push({
      machineId: idBySerial.get(m.row.machineSerial) ?? null,
      machineSerial: m.row.machineSerial,
      coilId: m.row.coilId,
      productId: idByName(m.row.productName),
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
  let serviceRows = 0;
  for (const row of donorCounts) {
    const m = mapStockCount(row, canon);
    if (!m.ok) {
      if (m.reason === "service_row") serviceRows += 1;
      continue;
    }
    if (m.rawName !== null) unresolved.add(m.rawName);
    countValues.push({
      dt: m.row.dt,
      productName: m.row.productName,
      productId: idByName(m.row.productName),
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
  const purchaseValues: (typeof purchase.$inferInsert)[] = missing.map((p) => ({
    extId: p.extId,
    dt: p.dt,
    product: p.product,
    qty: String(p.qty),
    unitPrice: p.unitPrice === null ? null : String(p.unitPrice),
    total: p.unitPrice === null ? null : String(p.qty * p.unitPrice),
    note: "сверка П8a: дописано из mydon-stock",
    source: "stock",
  }));

  const report: StockHistoryReport = {
    apply: opts.apply,
    refills: {
      found: donorRefills.length,
      written: 0,
      skipped: donorRefills.length - refillValues.length,
      noSerial,
      fractionalQty,
    },
    stockCounts: {
      found: donorCounts.length,
      written: 0,
      skipped: donorCounts.length - countValues.length,
      serviceRows,
    },
    purchases: { mine: mine.length, donor: donorPurchases.length, added: 0, differing, onlyMine: onlyMine.length },
    unresolved: [...unresolved].sort((a, b) => a.localeCompare(b, "ru")),
  };

  if (!opts.apply) return report;

  // Транзакции на весь перенос нет намеренно: каждая пачка идемпотентна по
  // уникальному ключу, поэтому оборванный прогон не оставляет состояния,
  // которое нельзя починить — повтор просто дописывает недостающее. Одна
  // транзакция на 460 строк добавила бы только длинную блокировку.
  report.refills.written = await insertBatched(refillValues, (batch) =>
    db.insert(vendingRefill).values(batch).onConflictDoNothing({ target: vendingRefill.clientKey }).returning({ id: vendingRefill.id }),
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
    db.insert(purchase).values(batch).onConflictDoNothing({ target: [purchase.source, purchase.extId] }).returning({ id: purchase.id }),
  );

  const всего = report.refills.written + report.stockCounts.written + report.purchases.added;
  // Отметка ставится на ФАКТ переноса, а не на факт запуска: R-P8a-5 знает
  // ровно одно событие `stock.history.imported`. Повторный `--apply`, который
  // ничего не записал, второй отметки не оставляет — иначе журнал наполнялся
  // бы нулевыми «импортами», и найти настоящий было бы нечем.
  if (всего > 0) {
    await db.insert(event).values([
      {
        source: "stock-import",
        type: "stock.history.imported",
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

  return report;
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
    purchases: async () =>
      (await client`
        select pu.id, pu.dt::text as dt, p.name as product, pu.qty, pu.unit_price
          from ${client(schema)}.purchases pu
          join ${client(schema)}.products p on p.id = pu.product_id
         order by pu.id`) as unknown as DonorPurchaseRow[],
  };
  return { reader, close: async () => client.end({ timeout: 5 }) };
}

// ── Отчёт ───────────────────────────────────────────────────────────────────

/** Список имён в одну строку: не больше 20, остальные — числом. */
function перечислить(items: readonly string[], предел = 20): string {
  return items.length <= предел ? items.join(", ") : `${items.slice(0, предел).join(", ")} и ещё ${items.length - предел}`;
}

function строкаТаблицы(источник: string, s: ImportSection, хвост: string): string {
  return `${источник.padEnd(38)}${String(s.found).padStart(8)}${String(s.written).padStart(10)}${String(s.skipped).padStart(11)}  ${хвост}`;
}

export function formatReport(r: StockHistoryReport): string {
  const строки: string[] = [];
  // Режим — ПЕРВОЙ строкой, до всяких чисел: читающий отчёт должен узнать, что
  // это была примерка, раньше, чем поверит цифре «записано».
  строки.push(
    r.apply
      ? "Импорт истории склада mydon-stock — РЕЖИМ --apply: строки ЗАПИСАНЫ."
      : "Импорт истории склада mydon-stock — РЕЖИМ --dry-run: НИЧЕГО не записано, это примерка.",
  );
  строки.push("");
  строки.push(`${"источник".padEnd(38)}${"найдено".padStart(8)}${"записано".padStart(10)}${"пропущено".padStart(11)}  почему пропущено`);
  строки.push(
    строкаТаблицы(
      "заливы → vending_refill",
      r.refills,
      `без серийника ${r.refills.noSerial} (агрегат, в архив)` +
        (r.refills.fractionalQty.length > 0 ? `, дробный qty ${r.refills.fractionalQty.length}` : ""),
    ),
  );
  строки.push(строкаТаблицы("инвентаризации → vending_stock_count", r.stockCounts, `служебных ${r.stockCounts.serviceRows}`));
  строки.push(
    `${"закупки → purchase (сверка)".padEnd(38)}${String(r.purchases.donor).padStart(8)}${String(r.purchases.added).padStart(10)}${"—".padStart(11)}  ` +
      `у нас ${r.purchases.mine}, только у нас ${r.purchases.onlyMine}, расхождений ${r.purchases.differing.length}`,
  );
  строки.push("");

  строки.push(
    r.unresolved.length === 0
      ? "Имена без карточки прайса: нет — весь перенос лёг с product_id."
      : `Имена без карточки прайса (${r.unresolved.length}) — строки импортированы с product_id = NULL, это список владельцу:`,
  );
  if (r.unresolved.length > 0) строки.push(`  ${перечислить(r.unresolved)}`);

  if (r.refills.fractionalQty.length > 0) {
    строки.push(
      `Заливы с дробным qty (${r.refills.fractionalQty.length}) НЕ импортированы — колонка целочисленная, id: ${перечислить(r.refills.fractionalQty)}`,
    );
  }

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
  строки.push(
    `ИТОГИ(json): ${JSON.stringify({
      apply: r.apply,
      refills: r.refills.written,
      stockCounts: r.stockCounts.written,
      purchasesAdded: r.purchases.added,
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

  const { reader, close } = sqlDonor(donorUrl, process.env.STOCK_SCHEMA ?? "public");
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
    console.error("Импорт истории склада упал:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
