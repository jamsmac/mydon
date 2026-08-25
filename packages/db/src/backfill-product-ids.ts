/**
 * Разовый бэкфилл `product_id` в `vending_stock` и `machine_slot` (П4).
 *
 * ЗАЧЕМ. Обе таблицы ключуются ИМЕНЕМ товара, а `product_id` заполняется только
 * на записи: слоты — при следующем сборе (≤ 3 ч), склад — при ручной
 * инвентаризации владельца. Замер прода 25.08: `machine_slot` — 210 строк,
 * `product_id` NULL у ВСЕХ; `vending_stock` — 20 строк, NULL у всех двадцати.
 * Слоты починятся сами первым же сбором, а двадцать строк склада могли
 * провисеть с NULL сколько угодно — «гигиена П4» оказалась бы невыполненной
 * ровно там, где её заявили.
 *
 * ПОЧЕМУ ОТДЕЛЬНЫЙ СКРИПТ, А НЕ МИГРАЦИЯ. Резолв имени — это КОД (нормализация
 * плюс таблица алиасов), а не SQL-выражение: повторять его в миграции значит
 * завести вторую реализацию правила, которая разойдётся с Core на первом же
 * новом алиасе. Здесь используется та же `normalizeProductName` из
 * `@mydon/shared`, что и в `VendingService.productIdResolver`.
 *
 * ИДЕМПОТЕНТЕН: трогает только строки с `product_id IS NULL`, повторный прогон
 * обновляет ноль строк. Имена, которым карточки не нашлось, печатаются — это
 * не ошибка выкатки, а список на разбор владельцу.
 *
 * Запуск (один раз при выкатке): `node packages/db/dist/backfill-product-ids.js`
 */
import path from "node:path";
import { config as loadEnv } from "dotenv";
import { eq, isNull } from "drizzle-orm";
import { normalizeProductName } from "@mydon/shared";
import { createDb, type Database } from "./index";
import { machineSlot, vendingAlias, vendingProduct, vendingStock } from "./schema";

/**
 * Сырое имя → id карточки товара. Правило дословно повторяет Core: сначала
 * алиас (по нормализованному ключу) приводит имя к канону, затем канон ищется
 * в прайсе — тоже по нормализованному ключу. Имя, которому карточки нет, в
 * карту НЕ попадает: NULL и строка в отчёте честнее выдуманной привязки.
 */
export function resolveProductIds(
  names: (string | null | undefined)[],
  products: { id: string; name: string }[],
  aliases: { productId: string; alias: string }[],
): Map<string, string> {
  const nameById = new Map(products.map((p) => [p.id, p.name]));
  const aliasByKey = new Map<string, string>();
  for (const a of aliases) {
    const canonical = nameById.get(a.productId);
    // Алиас на удалённый товар — не повод привязать строку к чему попало.
    if (canonical) aliasByKey.set(normalizeProductName(a.alias), canonical);
  }
  const idByKey = new Map(products.map((p) => [normalizeProductName(p.name), p.id]));

  const out = new Map<string, string>();
  for (const raw of names) {
    if (raw === null || raw === undefined || raw.trim() === "") continue;
    if (out.has(raw)) continue;
    const canonical = aliasByKey.get(normalizeProductName(raw)) ?? raw;
    const id = idByKey.get(normalizeProductName(canonical));
    if (id) out.set(raw, id);
  }
  return out;
}

export interface BackfillResult {
  /** Сколько строк получили привязку. */
  updated: number;
  /** Осталось без привязки — по именам, отсортировано. */
  unresolved: string[];
}

/** Бэкфилл одной таблицы. Обе устроены одинаково: имя товара + пустой `product_id`. */
async function backfillTable(
  db: Database,
  table: typeof vendingStock | typeof machineSlot,
  nameColumn: typeof vendingStock.productName | typeof machineSlot.productName,
  idColumn: typeof vendingStock.productId | typeof machineSlot.productId,
  products: { id: string; name: string }[],
  aliases: { productId: string; alias: string }[],
): Promise<BackfillResult> {
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
  // Одно UPDATE на ИМЯ, а не на строку: имён десятки, строк сотни.
  for (const [raw, id] of резолв) {
    const res = (await db
      .update(table as never)
      .set({ productId: id } as never)
      .where(eq(nameColumn, raw) as never)
      .returning({ id: idColumn })) as unknown[];
    updated += res.length;
  }

  const unresolved = [
    ...new Set(rows.map((r) => r.name).filter((n): n is string => n !== null && n.trim() !== "" && !резолв.has(n))),
  ].sort((a, b) => a.localeCompare(b, "ru"));
  return { updated, unresolved };
}

export async function backfillProductIds(db: Database): Promise<{ stock: BackfillResult; slots: BackfillResult }> {
  const [products, aliases] = await Promise.all([
    db.select({ id: vendingProduct.id, name: vendingProduct.name }).from(vendingProduct),
    db.select({ productId: vendingAlias.productId, alias: vendingAlias.alias }).from(vendingAlias),
  ]);
  const stock = await backfillTable(db, vendingStock, vendingStock.productName, vendingStock.productId, products, aliases);
  const slots = await backfillTable(db, machineSlot, machineSlot.productName, machineSlot.productId, products, aliases);
  return { stock, slots };
}

function отчёт(что: string, r: BackfillResult): void {
  const хвост =
    r.unresolved.length === 0
      ? ""
      : ` (${r.unresolved.slice(0, 20).join(", ")}${r.unresolved.length > 20 ? ` и ещё ${r.unresolved.length - 20}` : ""})`;
  console.log(`${что}: обновлено ${r.updated} / осталось NULL ${r.unresolved.length}${хвост}`);
}

async function main(): Promise<void> {
  loadEnv({ path: path.resolve(__dirname, "../../../.env"), quiet: true });
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL не задан — бэкфилл product_id выполнять негде.");
    process.exit(1);
  }
  const { stock, slots } = await backfillProductIds(createDb(url));
  отчёт("Склад вендинга (vending_stock)", stock);
  отчёт("Планограмма (machine_slot)", slots);
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
