/**
 * Разовый бэкфилл `product_id` в `vending_stock`, `machine_slot`,
 * `vending_refill` и `vending_stock_count` (П4 → «Хвосты снек-контура», R-H-4).
 *
 * ЗАЧЕМ. Все четыре таблицы ключуются ИМЕНЕМ товара, а `product_id`
 * заполняется только на записи: слоты — при следующем сборе (≤ 3 ч), склад —
 * при ручной инвентаризации владельца, заливки и история склада — вообще не
 * заполняются автоматически задним числом.
 *
 * ЗАМЕР ПРОДА 26.08 (адверсариал прод-данных, P10) — числа за сутки съехали,
 * и ждать от прогона надо СОВСЕМ НЕ ТОГО, что обещал замер 25.08:
 *
 * | цель | `product_id IS NULL` | всего |
 * |---|---|---|
 * | `vending_stock` | 0 | 20 |
 * | `machine_slot` | 81 | 210 |
 * | `vending_refill` | 0 | 107 |
 * | `vending_stock_count` | 15 | 460 |
 *
 * То есть склад и заливки уже привязаны целиком (пересчёты владельца 25.08 и
 * импорт П8a сделали это сами), а 81 «дыра» планограммы — это НЕРАСПРЕДЕЛЁННЫЕ
 * пружины: у всех 81 `product_name IS NULL`, привязывать там нечего, и они
 * останутся NULL законно и навсегда (`resolveProductIds` пустые имена
 * отбрасывает). Живая цель ровно одна — 15 строк истории склада на 11 имён.
 * НОЛЬ ПРИВЯЗОК ПО ТРЁМ ЦЕЛЯМ ИЗ ЧЕТЫРЁХ — ОЖИДАЕМЫЙ ИСХОД, а не признак
 * поломки.
 *
 * ПОЧЕМУ ДОБАВЛЕНЫ `vending_refill` И `vending_stock_count`. Импорт истории
 * (П8a) честно назвал владельцу до 11 неопознанных имён
 * (`import-stock-history.ts:624-628`), но привязать их после того, как
 * владелец завёл недостающие карточки прайса, было нечем — петля «скрипт
 * назвал проблему → владелец починил → система подхватила» была разомкнута
 * в последнем звене. Этот скрипт её замыкает. Четыре из этих одиннадцати имён
 * закрываются САМИ, без единого действия владельца: они отличались от уже
 * заведённой карточки/алиаса только десятичным разделителем, а его теперь
 * сводит `normalizeProductName` (R-FW-P1). Остальные семь ждут карточек или
 * алиасов — и это по-прежнему список на разбор, а не отказ выкатки.
 *
 * ПОЧЕМУ ОТДЕЛЬНЫЙ СКРИПТ, А НЕ МИГРАЦИЯ. Резолв имени — это КОД (нормализация
 * плюс таблица алиасов), а не SQL-выражение: повторять его в миграции значит
 * завести вторую реализацию правила, которая разойдётся с Core на первом же
 * новом алиасе. Здесь используется тот же индекс каталога `productIndex` из
 * `@mydon/shared`, что и у импорта истории склада, и та же дверь
 * `resolveCatalogName`, что у `VendingService.resolveProduct` и
 * `productIdResolver`.
 *
 * ОДНО ПРАВИЛО НА ВСЕХ (R-G-1, срез «Гигиена»). Резолв имени живёт в
 * `resolveCatalogName` (`@mydon/shared`): точное имя карточки главнее алиаса,
 * нормализация — `normalizeProductName`, спор возвращается явно. Тем же
 * правилом отвечают живой резолвер Core (`VendingService.resolveProduct`) и
 * импорт истории склада. Раньше их было три с РАЗНЫМ приоритетом, и
 * расхождение было записано здесь как долг — этот срез его закрыл.
 *
 * Строже здесь по-прежнему ОДНО: на споре скрипт ОТКАЗЫВАЕТСЯ привязывать
 * (живой резолвер берёт карточку по имени и пишет warn). Причина в
 * необратимости: `бэкфиллWhere` держит `isNull`, и ошибочную ссылку повторный
 * прогон уже не тронет.
 *
 * ИДЕМПОТЕНТЕН: трогает только строки с `product_id IS NULL`, повторный прогон
 * обновляет ноль строк. Имена, которым карточки не нашлось, печатаются — это
 * не ошибка выкатки, а список на разбор владельцу.
 *
 * Флаги: `--dry-run` резолвит и печатает отчёт «обновилось бы N» ВМЕСТЕ С
 * КАРТОЙ решения, но НЕ пишет; `--apply` — явный синоним записи. БЕЗ ФЛАГОВ —
 * тоже запись (см. `main()`): так вызывает `.github/workflows/ci.yml`, и весь
 * смысл этого шага CI — исполнить настоящий UPDATE против настоящего Postgres
 * (сценарий N2). Ничего, кроме этих двух строк, не принимается: опечатка в
 * флаге отбивается кодом 1 ДО первого запроса (`разобратьАргументы`, R-FW-S1).
 *
 * Запуск (при выкатке): `node packages/db/dist/backfill-product-ids.js [--dry-run|--apply]`
 */
import path from "node:path";
import { config as loadEnv } from "dotenv";
import { and, eq, isNull } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { AnyPgColumn, PgTable } from "drizzle-orm/pg-core";
import { productIndex, resolveCatalogName, type CanonSource } from "@mydon/shared";
import { createDb, type Database } from "./index";
import { machineSlot, vendingAlias, vendingProduct, vendingRefill, vendingStock, vendingStockCount } from "./schema";

/**
 * Сырое имя → карточка товара. Сначала ТОЧНОЕ имя карточки (по
 * нормализованному ключу), и только потом алиас — приоритет живёт в
 * `productIndex` и здесь не дублируется. Имя, которому карточки нет, в карту НЕ
 * попадает: NULL и строка в отчёте честнее выдуманной привязки. Имя, которое
 * резолвится ДВУМЯ путями на разные карточки, тоже не попадает — оно уезжает
 * списком `conflicts` (R-FW-S3): привязка необратима.
 *
 * ПРАВИЛО ЗДЕСЬ ТО ЖЕ, ЧТО У ЖИВОГО РЕЗОЛВЕРА CORE: оба зовут
 * `resolveCatalogName` (`@mydon/shared`). Отличается только ОТВЕТ НА СПОР —
 * скрипт отказывается привязывать, Core берёт карточку по имени и пишет warn;
 * причина в необратимости, см. шапку файла.
 *
 * Сам индекс живёт в `@mydon/shared` (`productIndex`): тот же каталог с тем же
 * решением про алиасы читает импорт истории склада (П8a), только спрашивает у
 * него не id, а каноническое имя. Две копии сборки разошлись бы на первом же
 * новом алиасе.
 */
export interface ResolvedName {
  /** Карточка прайса. */
  id: string;
  /** Каноническое имя карточки — то, что владелец видит в прайсе. */
  canon: string;
  /** Чем нашлось: точным именем карточки или алиасом. */
  source: CanonSource;
}

/** Имя, которое резолвится ДВУМЯ путями на РАЗНЫЕ карточки. Привязывать нечем. */
export interface NameConflict {
  /** Сырое имя строки, как оно лежит в таблице. */
  raw: string;
  /** Карточка, чьё ИМЯ совпало. */
  byName: string;
  /** Карточка, на которую указывает алиас с тем же ключом. */
  byAlias: string;
}

export interface ResolveResult {
  /** Сырое имя → карточка. Спорные имена сюда НЕ попадают. */
  resolved: Map<string, ResolvedName>;
  /** Споры — в порядке первой встречи, для отчёта владельцу. */
  conflicts: NameConflict[];
}

export function resolveProductIds(
  names: (string | null | undefined)[],
  products: { id: string; name: string }[],
  aliases: { productId: string; alias: string }[],
): ResolveResult {
  const индекс = productIndex(products, aliases);
  const resolved = new Map<string, ResolvedName>();
  const conflicts: NameConflict[] = [];
  const спорные = new Set<string>();
  for (const raw of names) {
    if (raw === null || raw === undefined || raw.trim() === "") continue;
    if (resolved.has(raw) || спорные.has(raw)) continue;
    // ТА ЖЕ ДВЕРЬ, ЧТО У CORE (R-G-1): не `индекс.explain`, а общий резолвер —
    // он же приносит исходное имя, из которого собирается список на разбор.
    const ответ = resolveCatalogName(индекс, raw);
    if (ответ.kind === "hit") {
      resolved.set(raw, { id: ответ.id, canon: ответ.canon, source: ответ.source });
    } else if (ответ.kind === "conflict") {
      // СПОРНОЕ ИМЯ НЕ ПРИВЯЗЫВАЕТСЯ (R-FW-S3). `бэкфиллWhere` держит
      // `isNull(idColumn)`, поэтому ошибочно проставленная ссылка повторным
      // прогоном уже не чинится: молчаливая привязка к неверной карточке хуже
      // оставленного NULL. Имя уезжает владельцу отдельным списком.
      спорные.add(raw);
      conflicts.push({ raw: ответ.raw, byName: ответ.byName, byAlias: ответ.byAlias });
    }
  }
  return { resolved, conflicts };
}

export interface BackfillResult {
  /** Сколько строк получили (либо при `--dry-run` — получили бы) привязку. */
  updated: number;
  /** Осталось без привязки — по именам, отсортировано. */
  unresolved: string[];
  /**
   * Карта решения: `raw → канон (источник)`, в порядке встречи имён.
   *
   * Печатается в примерке (R-FW-S3): проба, у которой на выходе одно число,
   * не даёт сверить НИЧЕГО, а привязка необратима.
   */
  resolved: { raw: string; canon: string; source: CanonSource }[];
  /** Имена, где алиас спорит с именем чужой карточки: привязка не сделана намеренно. */
  conflicts: NameConflict[];
}

/**
 * Одна таблица бэкфилла: имя товара + пустая ссылка на карточку.
 *
 * `key` — тем же словом, что в результате `backfillProductIds` и в отчёте
 * `main()`; `name` — человеческая подпись отчёта, её читает владелец на
 * выкатке.
 */
export interface BackfillTarget {
  key: "stock" | "slots" | "refills" | "stockCounts";
  name: string;
  table: PgTable;
  nameColumn: AnyPgColumn;
  idColumn: AnyPgColumn;
}

/**
 * Цели перечислены ДАННЫМИ, а не четырьмя вызовами `backfillTable` подряд:
 * отчёт (`main`), тест (`backfill-product-ids.test.ts`) и выкаточная команда
 * (`docs/DEPLOY.md`) обязаны говорить об одном и том же списке. Четвёртая
 * цель, забытая в одном из трёх мест, — это ровно тот дефект, который здесь
 * и чинится: `vending_refill`/`vending_stock_count` были заведены в схеме
 * (П8a), но сюда не попали.
 */
export const BACKFILL_TARGETS: BackfillTarget[] = [
  { key: "stock", name: "Склад вендинга (vending_stock)", table: vendingStock, nameColumn: vendingStock.productName, idColumn: vendingStock.productId },
  { key: "slots", name: "Планограмма (machine_slot)", table: machineSlot, nameColumn: machineSlot.productName, idColumn: machineSlot.productId },
  { key: "refills", name: "Заливки (vending_refill)", table: vendingRefill, nameColumn: vendingRefill.productName, idColumn: vendingRefill.productId },
  { key: "stockCounts", name: "История склада (vending_stock_count)", table: vendingStockCount, nameColumn: vendingStockCount.productName, idColumn: vendingStockCount.productId },
];

/**
 * WHERE для UPDATE: то же имя, но ссылка ВСЁ ЕЩЁ пустая.
 *
 * Строки выбираются через `isNull(idColumn)`, но без этого же условия в самом
 * UPDATE под `eq(nameColumn, raw)` попали бы ВСЕ строки с этим именем —
 * включая уже привязанные (другой автомат, другой `product_id` после смены
 * алиаса). Вынесена отдельной чистой функцией, чтобы предикат можно было
 * проверить юнит-тестом без стаба drizzle-цепочки целиком. Типы колонок —
 * `AnyPgColumn`: предикат один и тот же на все четыре цели, меняются только
 * сами колонки.
 */
export function бэкфиллWhere(nameColumn: AnyPgColumn, idColumn: AnyPgColumn, raw: string): SQL | undefined {
  return and(eq(nameColumn, raw), isNull(idColumn));
}

/**
 * JS-ключ, под которым `idColumn` объявлен в СВОЕЙ ЖЕ таблице — тем же ключом
 * `UPDATE` пишет новое значение через `set()`. Раньше `set({ productId: id })`
 * был литералом рядом с `idColumn`, и связь между ними держалась только на
 * `as never`: пятая цель, у которой это же поле называлось бы иначе, не то
 * что не поймалась бы TS — молча обновила бы не ту колонку (или ни одной).
 * Здесь ключ ИЩЕТСЯ в самой таблице; если `idColumn` вдруг не её колонка —
 * исключение бросается сразу, до единого `UPDATE`, а не посреди записи.
 */
function idKeyOf(table: PgTable, idColumn: AnyPgColumn): string {
  const запись = Object.entries(table as unknown as Record<string, unknown>).find(([, col]) => col === idColumn);
  if (!запись) {
    throw new Error("idColumn не найден среди колонок своей таблицы — сверьте BACKFILL_TARGETS");
  }
  return запись[0];
}

/** Бэкфилл одной цели. Все четыре устроены одинаково: имя товара + пустой `product_id`. */
async function backfillTable(
  db: Database,
  target: BackfillTarget,
  products: { id: string; name: string }[],
  aliases: { productId: string; alias: string }[],
  dryRun: boolean,
): Promise<BackfillResult> {
  const { table, nameColumn, idColumn } = target;
  const rows = (await db
    .select({ name: nameColumn })
    .from(table as never)
    .where(isNull(idColumn))) as { name: string | null }[];

  const { resolved: резолв, conflicts } = resolveProductIds(
    rows.map((r) => r.name),
    products,
    aliases,
  );

  let updated = 0;
  if (dryRun) {
    // Примерка: те же кандидаты, что и запись бы взяла (строки уже
    // отфильтрованы `isNull(idColumn)` выше), но без единого UPDATE. Число
    // обязано совпасть с тем, что дала бы запись — иначе примерка врёт.
    for (const r of rows) {
      if (r.name !== null && резолв.has(r.name)) updated += 1;
    }
  } else {
    const idKey = idKeyOf(table, idColumn);
    // Одно UPDATE на ИМЯ, а не на строку: имён десятки, строк сотни.
    for (const [raw, { id }] of резолв) {
      const res = (await db
        .update(table as never)
        .set({ [idKey]: id } as never)
        .where(бэкфиллWhere(nameColumn, idColumn, raw) as never)
        .returning({ id: idColumn })) as unknown[];
      updated += res.length;
    }
  }

  // Спорное имя — НЕ «неразобранное»: причина другая, и владельцу нужно
  // сделать другое (развести алиас и карточку, а не завести карточку).
  const спорные = new Set(conflicts.map((c) => c.raw));
  const unresolved = [
    ...new Set(
      rows
        .map((r) => r.name)
        .filter((n): n is string => n !== null && n.trim() !== "" && !резолв.has(n) && !спорные.has(n)),
    ),
  ].sort((a, b) => a.localeCompare(b, "ru"));
  const resolved = [...резолв].map(([raw, r]) => ({ raw, canon: r.canon, source: r.source }));
  return { updated, unresolved, resolved, conflicts };
}

export async function backfillProductIds(
  db: Database,
  opts: { dryRun?: boolean } = {},
): Promise<Record<BackfillTarget["key"], BackfillResult>> {
  // `orderBy(id)`: индекс каталога (`productIndex`) собирается «последний
  // побеждает» по НОРМАЛИЗОВАННОМУ ключу, а Postgres без ORDER BY не обязан
  // отдавать строки в одном и том же порядке двум запросам подряд. Пара
  // алиасов-«близнецов» на РАЗНЫЕ товары («Coca Cola» / «coca  cola» —
  // уникальность в БД побайтовая, а не нормализованная) иначе могла бы дать
  // разного победителя в `--dry-run` и в записи. Порядок сам по себе не
  // «правильный» — важно, что он ОДИН И ТОТ ЖЕ на каждый прогон.
  const [products, aliases] = await Promise.all([
    db.select({ id: vendingProduct.id, name: vendingProduct.name }).from(vendingProduct).orderBy(vendingProduct.id),
    db.select({ productId: vendingAlias.productId, alias: vendingAlias.alias }).from(vendingAlias).orderBy(vendingAlias.id),
  ]);

  const dryRun = opts.dryRun ?? false;
  const результат = {} as Record<BackfillTarget["key"], BackfillResult>;
  for (const target of BACKFILL_TARGETS) {
    результат[target.key] = await backfillTable(db, target, products, aliases, dryRun);
  }
  return результат;
}

function отчёт(что: string, r: BackfillResult, dryRun: boolean): void {
  const хвост =
    r.unresolved.length === 0
      ? ""
      : ` (${r.unresolved.slice(0, 20).join(", ")}${r.unresolved.length > 20 ? ` и ещё ${r.unresolved.length - 20}` : ""})`;
  const глагол = dryRun ? "обновилось БЫ" : "обновлено";
  console.log(`${что}: ${глагол} ${r.updated} / осталось NULL ${r.unresolved.length}${хвост}`);
  // СПОР — ОТДЕЛЬНОЙ СТРОКОЙ, а не в списке «осталось NULL»: чинится он
  // по-другому (развести алиас и карточку), и утонув среди неразобранных
  // имён он читался бы как «карточки нет».
  for (const c of r.conflicts) {
    console.log(
      `  конфликт: «${c.raw}» — это и имя карточки «${c.byName}», и алиас карточки «${c.byAlias}». ` +
        `Строка НЕ привязана: уберите лишний алиас и прогоните ещё раз.`,
    );
  }
}

/** Сколько пар карты печатать в примерке: отчёт обязан оставаться читаемым. */
const КАРТА_МАКС = 50;

/** Карта решения — только в примерке: сверять её надо ДО того, как привязка стала необратимой. */
function картаРешения(что: string, r: BackfillResult): void {
  if (r.resolved.length === 0) return;
  console.log(`  ${что} — как разобрано (${r.resolved.length}):`);
  for (const п of r.resolved.slice(0, КАРТА_МАКС)) {
    console.log(`    ${п.raw} → ${п.canon} (источник: ${п.source === "name" ? "имя карточки" : "алиас"})`);
  }
  if (r.resolved.length > КАРТА_МАКС) console.log(`    … и ещё ${r.resolved.length - КАРТА_МАКС}`);
}

/** Ровно два флага, и ничего кроме них. */
const ЗНАЕМ_ФЛАГИ = ["--dry-run", "--apply"];

/**
 * Разбор аргументов БЕЛЫМ СПИСКОМ и строка режима одним местом (R-FW-S1).
 *
 * Раньше распознавались ровно две строки, а всё остальное — `--dryrun`,
 * `--dry_run`, `-n`, `--dry-run=1`, типографское `—dry-run` после копипасты из
 * `DEPLOY.md` — не распознавалось никак: `dryRun` оставался `false`, и скрипт
 * шёл ПИСАТЬ в прод. Хуже самого факта была строка режима: оператор, набравший
 * `--dryrun`, читал «ЗАПИСЬ (без флагов — умолчание)», то есть ОТЧЁТ
 * подтверждал ему неверную картину.
 *
 * Умолчание «без флагов = запись» сохраняется: `ci.yml` зовёт скрипт без
 * аргументов, и весь смысл того шага — настоящий UPDATE. Закрыт ровно тот
 * путь, где оператор думал, что попросил примерку.
 *
 * Чистой функцией, а не внутри `main()`: строку режима, которая обязана НЕ
 * врать, надо чем-то проверять.
 */
export function разобратьАргументы(
  argv: string[],
): { ok: true; dryRun: boolean; режим: string } | { ok: false; error: string } {
  const чужие = argv.filter((a) => !ЗНАЕМ_ФЛАГИ.includes(a));
  if (чужие.length > 0) {
    return {
      ok: false,
      error: `Неизвестные аргументы: ${чужие.join(" ")}. Допустимо только --dry-run или --apply (без флагов — ЗАПИСЬ).`,
    };
  }
  const apply = argv.includes("--apply");
  const dryRun = argv.includes("--dry-run");
  if (apply && dryRun) {
    return {
      ok: false,
      error: "--apply и --dry-run вместе не имеют смысла: первый пишет, второй обещает не писать. Выберите один.",
    };
  }
  if (dryRun) return { ok: true, dryRun: true, режим: "Режим: ПРИМЕРКА (--dry-run), записи не будет." };
  return { ok: true, dryRun: false, режим: `Режим: ЗАПИСЬ${apply ? " (--apply)" : " (без флагов — умолчание)"}.` };
}

async function main(): Promise<void> {
  loadEnv({ path: path.resolve(__dirname, "../../../.env"), quiet: true });

  // БЕЛЫЙ СПИСОК — ДО ПЕРВОГО ЗАПРОСА: опечатка в флаге не имеет права стать
  // молчаливой записью в прод.
  const флаги = разобратьАргументы(process.argv.slice(2));
  if (!флаги.ok) {
    console.error(флаги.error);
    process.exit(1);
  }
  const dryRun = флаги.dryRun;

  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL не задан — бэкфилл product_id выполнять негде.");
    process.exit(1);
  }
  // Режим и адрес — ДО первого запроса. Сосед по тому же разделу DEPLOY.md
  // (`import-stock-history.js`) без флагов НЕ пишет — противоположное
  // умолчание рядом легко перепутать, а мышечная память «без флагов =
  // безопасный отчёт» здесь даёт молчаливый UPDATE по проду. Печатаем ТОЛЬКО
  // host (`new URL(url).host`), никогда полную строку DATABASE_URL с
  // паролем — та же застава, что у смоука П8a.
  console.log(`${флаги.режим} Цель: ${new URL(url).host}`);
  // БЕЗ ФЛАГОВ — ЗАПИСЬ, как было. `ci.yml:82` зовёт скрипт без аргументов, и
  // весь смысл того шага — исполнить настоящий UPDATE против настоящего
  // Postgres (сценарий N2). Дефолт `--dry-run` сделал бы этот шаг зелёным и
  // пустым: он проверял бы, что скрипт не падает, и ничего больше.
  const итог = await backfillProductIds(createDb(url), { dryRun });
  for (const t of BACKFILL_TARGETS) отчёт(t.name, итог[t.key], dryRun);
  // Карта — ПОСЛЕ итогов и только в примерке: в записи сверять уже поздно.
  if (dryRun) for (const t of BACKFILL_TARGETS) картаРешения(t.name, итог[t.key]);
  // Как в seed.ts/seed-vending.ts: postgres.js держит соединение открытым, и
  // без явного выхода ручной шаг выкатки висит после того, как всё сделано.
  process.exit(0);
}

if (require.main === module) {
  main().catch((err: unknown) => {
    console.error("Бэкфилл product_id упал:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
