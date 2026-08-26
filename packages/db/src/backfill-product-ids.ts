/**
 * Разовый бэкфилл `product_id` в `vending_stock`, `machine_slot`,
 * `vending_refill` и `vending_stock_count` (П4 → «Хвосты снек-контура», R-H-4).
 *
 * ЗАЧЕМ. Все четыре таблицы ключуются ИМЕНЕМ товара, а `product_id`
 * заполняется только на записи: слоты — при следующем сборе (≤ 3 ч), склад —
 * при ручной инвентаризации владельца, заливки и история склада — вообще не
 * заполняются автоматически задним числом. Замер прода 25.08: `machine_slot`
 * — 210 строк, `product_id` NULL у ВСЕХ; `vending_stock` — 20 строк, NULL у
 * всех двадцати. Слоты починятся сами первым же сбором, а двадцать строк
 * склада могли провисеть с NULL сколько угодно — «гигиена П4» оказалась бы
 * невыполненной ровно там, где её заявили.
 *
 * ПОЧЕМУ ДОБАВЛЕНЫ `vending_refill` И `vending_stock_count`. Импорт истории
 * (П8a) честно назвал владельцу до 11 неопознанных имён
 * (`import-stock-history.ts:624-628`), но привязать их после того, как
 * владелец завёл недостающие карточки прайса, было нечем — петля «скрипт
 * назвал проблему → владелец починил → система подхватила» была разомкнута
 * в последнем звене. Этот скрипт её замыкает.
 *
 * ПОЧЕМУ ОТДЕЛЬНЫЙ СКРИПТ, А НЕ МИГРАЦИЯ. Резолв имени — это КОД (нормализация
 * плюс таблица алиасов), а не SQL-выражение: повторять его в миграции значит
 * завести вторую реализацию правила, которая разойдётся с Core на первом же
 * новом алиасе. Здесь используется тот же индекс каталога `productIndex` из
 * `@mydon/shared`, что и у импорта истории склада, с той же
 * `normalizeProductName`, что и в `VendingService.productIdResolver`.
 *
 * ИДЕМПОТЕНТЕН: трогает только строки с `product_id IS NULL`, повторный прогон
 * обновляет ноль строк. Имена, которым карточки не нашлось, печатаются — это
 * не ошибка выкатки, а список на разбор владельцу.
 *
 * Флаги: `--dry-run` резолвит и печатает отчёт «обновилось бы N», но НЕ
 * пишет; `--apply` — явный синоним записи. БЕЗ ФЛАГОВ — тоже запись (см.
 * `main()`): так вызывает `.github/workflows/ci.yml`, и весь смысл этого шага
 * CI — исполнить настоящий UPDATE против настоящего Postgres (сценарий N2).
 *
 * Запуск (при выкатке): `node packages/db/dist/backfill-product-ids.js [--dry-run|--apply]`
 */
import path from "node:path";
import { config as loadEnv } from "dotenv";
import { and, eq, isNull } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { AnyPgColumn, PgTable } from "drizzle-orm/pg-core";
import { productIndex } from "@mydon/shared";
import { createDb, type Database } from "./index";
import { machineSlot, vendingAlias, vendingProduct, vendingRefill, vendingStock, vendingStockCount } from "./schema";

/**
 * Сырое имя → id карточки товара. Правило дословно повторяет Core: сначала
 * алиас (по нормализованному ключу) приводит имя к канону, затем канон ищется
 * в прайсе — тоже по нормализованному ключу. Имя, которому карточки нет, в
 * карту НЕ попадает: NULL и строка в отчёте честнее выдуманной привязки.
 *
 * Сам индекс живёт в `@mydon/shared` (`productIndex`): тот же каталог с тем же
 * решением про алиасы читает импорт истории склада (П8a), только спрашивает у
 * него не id, а каноническое имя. Две копии сборки разошлись бы на первом же
 * новом алиасе.
 */
export function resolveProductIds(
  names: (string | null | undefined)[],
  products: { id: string; name: string }[],
  aliases: { productId: string; alias: string }[],
): Map<string, string> {
  const индекс = productIndex(products, aliases);
  const out = new Map<string, string>();
  for (const raw of names) {
    if (raw === null || raw === undefined || raw.trim() === "") continue;
    if (out.has(raw)) continue;
    const id = индекс.id(raw);
    if (id) out.set(raw, id);
  }
  return out;
}

export interface BackfillResult {
  /** Сколько строк получили (либо при `--dry-run` — получили бы) привязку. */
  updated: number;
  /** Осталось без привязки — по именам, отсортировано. */
  unresolved: string[];
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

  const резолв = resolveProductIds(
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
    // Одно UPDATE на ИМЯ, а не на строку: имён десятки, строк сотни.
    for (const [raw, id] of резолв) {
      const res = (await db
        .update(table as never)
        .set({ productId: id } as never)
        .where(бэкфиллWhere(nameColumn, idColumn, raw) as never)
        .returning({ id: idColumn })) as unknown[];
      updated += res.length;
    }
  }

  const unresolved = [
    ...new Set(rows.map((r) => r.name).filter((n): n is string => n !== null && n.trim() !== "" && !резолв.has(n))),
  ].sort((a, b) => a.localeCompare(b, "ru"));
  return { updated, unresolved };
}

export async function backfillProductIds(
  db: Database,
  opts: { dryRun?: boolean } = {},
): Promise<Record<BackfillTarget["key"], BackfillResult>> {
  const [products, aliases] = await Promise.all([
    db.select({ id: vendingProduct.id, name: vendingProduct.name }).from(vendingProduct),
    db.select({ productId: vendingAlias.productId, alias: vendingAlias.alias }).from(vendingAlias),
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
}

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
    console.error("DATABASE_URL не задан — бэкфилл product_id выполнять негде.");
    process.exit(1);
  }
  // БЕЗ ФЛАГОВ — ЗАПИСЬ, как было. `ci.yml:82` зовёт скрипт без аргументов, и
  // весь смысл того шага — исполнить настоящий UPDATE против настоящего
  // Postgres (сценарий N2). Дефолт `--dry-run` сделал бы этот шаг зелёным и
  // пустым: он проверял бы, что скрипт не падает, и ничего больше.
  const итог = await backfillProductIds(createDb(url), { dryRun });
  for (const t of BACKFILL_TARGETS) отчёт(t.name, итог[t.key], dryRun);
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
