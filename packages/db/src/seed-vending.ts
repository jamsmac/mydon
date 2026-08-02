/**
 * Прайс и кратности вендинга — Приложение А ТЗ «Вендинг-операции».
 *
 * Перенос из боевого скрипта в базу (`vending_product`): дальше цена и кратность
 * правятся в интерфейсе, а не в коде. Кратность приведена к единому правилу от
 * 02.08.2026: напитки 12, снеки 10. Идемпотентно: повторный запуск не дублирует
 * (узнаём по имени), существующим ценам владельца не мешает.
 */
import path from "node:path";
import { config as loadEnv } from "dotenv";
import { eq } from "drizzle-orm";
import { normalizeProductName } from "@mydon/shared";
import { createDb } from "./index";
import { vendingAlias, vendingProduct, vendingStock } from "./schema";

export type VendingCat = "drink" | "snack";

export interface PriceItem {
  /** Имя ровно как в Ourvend. */
  name: string;
  category: VendingCat;
  /** Цена закупки за единицу, сум. */
  price: number;
}

/** Кратность по категории: напитки 12, снеки 10. */
export const packOf = (c: VendingCat): number => (c === "drink" ? 12 : 10);

/** Прайс из Приложения А (34 позиции). */
export const VENDING_PRICELIST: PriceItem[] = [
  { name: "Barni Шоколадный 30gr", category: "snack", price: 3875 },
  { name: "Borjomi Mineral 330ml", category: "drink", price: 10500 },
  { name: "Bounty Coconut 55gr", category: "snack", price: 7800 },
  { name: "Cheers Сметана и зелень 70gr", category: "snack", price: 9500 },
  { name: "ChocoPie Orion 30gr", category: "snack", price: 2000 },
  { name: "CocaCola Classic CAN 250ml", category: "drink", price: 5167 },
  { name: "CocaCola ZERO CAN 250ml", category: "drink", price: 5250 },
  { name: "Ermak Asl Qurt 7шт 30gr", category: "snack", price: 6800 },
  { name: "Ermak Арахис с солью 50gr", category: "snack", price: 4800 },
  { name: "Fanta Classic CAN 250ml", category: "drink", price: 5167 },
  { name: "FlashUp Energy 330ml", category: "drink", price: 8500 },
  { name: "Flint Kabob 100gr", category: "snack", price: 5800 },
  { name: "FuseTea Tea Mango Cham 450ml", category: "drink", price: 8500 },
  { name: "Kinder Bueno Chocolate 43gr", category: "snack", price: 11000 },
  { name: "Kitkat 40gr", category: "snack", price: 8800 },
  { name: "LaimonFresh Lime 330ml", category: "drink", price: 8000 },
  { name: "Lays Рифлёные Сметана и лук 70gr", category: "snack", price: 13000 },
  { name: "M and Ms Шоколадный 40gr", category: "snack", price: 9000 },
  { name: "Montella Вода минеральная 330ml", category: "drink", price: 2090 },
  { name: "Moxito Fresh Klubnika CAN 450ml", category: "drink", price: 9800 },
  { name: "Moxito Fresh Lime CAN 450ml", category: "drink", price: 9800 },
  { name: "Nesquick Choco 200ml", category: "drink", price: 6900 },
  { name: "Oreo x4 38gr", category: "snack", price: 5500 },
  { name: "Ozbegim Tea Mango Moychechak 450ml", category: "drink", price: 9000 },
  { name: "Pepsi CAN 250ml", category: "drink", price: 5417 },
  { name: "Plus 18 Energy 330ml", category: "drink", price: 8500 },
  { name: "RedBull Classic 250 ml", category: "drink", price: 16000 },
  { name: "Snickers 50gr", category: "snack", price: 7000 },
  { name: "Sprite 250ml", category: "drink", price: 5167 },
  { name: "Strobar 40gr", category: "snack", price: 4800 },
  { name: "TUC Crackers Sour cream and Onion", category: "snack", price: 10500 },
  { name: "Twix 50gr", category: "snack", price: 7000 },
  { name: "Velona Венские вафли с шоколадным вкусом", category: "snack", price: 2500 },
  { name: "СуперКонтик Шоколадный вкус 100gr", category: "snack", price: 5000 },
];

/**
 * Алиасы имён: как товар называют на рукописных листах остатков и в заметках
 * закупа владельца → каноническое имя из прайса. Только точные соответствия
 * (по нормализованному ключу): нечёткое сопоставление дало бы неверную цену на
 * похожем имени. Взято с реальных листов остатков (31.07 / 02.08.2026).
 */
export interface AliasItem {
  alias: string;
  /** Каноническое имя — обязано существовать в VENDING_PRICELIST. */
  product: string;
}

export const VENDING_ALIASES: AliasItem[] = [
  // Напитки
  { alias: "Fuse Tea", product: "FuseTea Tea Mango Cham 450ml" },
  { alias: "Fuse Tea can 0.45", product: "FuseTea Tea Mango Cham 450ml" },
  { alias: "Coca Cola cl", product: "CocaCola Classic CAN 250ml" },
  { alias: "Coca cola classic can 0.25", product: "CocaCola Classic CAN 250ml" },
  { alias: "Sprite can 0.25", product: "Sprite 250ml" },
  { alias: "Fanta", product: "Fanta Classic CAN 250ml" },
  { alias: "Fanta can 0.25", product: "Fanta Classic CAN 250ml" },
  { alias: "Montella", product: "Montella Вода минеральная 330ml" },
  { alias: "Montella pet 0.33", product: "Montella Вода минеральная 330ml" },
  { alias: "18+", product: "Plus 18 Energy 330ml" },
  { alias: "Plus 18 can 0.33", product: "Plus 18 Energy 330ml" },
  { alias: "Flash", product: "FlashUp Energy 330ml" },
  { alias: "Flash can 0.33", product: "FlashUp Energy 330ml" },
  { alias: "lemon Fr", product: "LaimonFresh Lime 330ml" },
  { alias: "LimonFresh", product: "LaimonFresh Lime 330ml" },
  { alias: "LimonFresh can 0.33", product: "LaimonFresh Lime 330ml" },
  { alias: "Moxito", product: "Moxito Fresh Lime CAN 450ml" },
  { alias: "Moxito lime can 0.45", product: "Moxito Fresh Lime CAN 450ml" },
  { alias: "Moxito клуб", product: "Moxito Fresh Klubnika CAN 450ml" },
  { alias: "Moxito klibn", product: "Moxito Fresh Klubnika CAN 450ml" },
  { alias: "Moxito klubn can 0.45", product: "Moxito Fresh Klubnika CAN 450ml" },
  { alias: "Red bull can 0.25", product: "RedBull Classic 250 ml" },
  // Снеки
  { alias: "Flint", product: "Flint Kabob 100gr" },
  { alias: "Lays", product: "Lays Рифлёные Сметана и лук 70gr" },
  { alias: "Арахис", product: "Ermak Арахис с солью 50gr" },
  { alias: "Ermak Araxis", product: "Ermak Арахис с солью 50gr" },
  { alias: "Choco p", product: "ChocoPie Orion 30gr" },
  { alias: "ChocoPie", product: "ChocoPie Orion 30gr" },
  { alias: "Twix", product: "Twix 50gr" },
  { alias: "Strobar", product: "Strobar 40gr" },
  { alias: "Snickers", product: "Snickers 50gr" },
  { alias: "Velona", product: "Velona Венские вафли с шоколадным вкусом" },
  { alias: "Bounty", product: "Bounty Coconut 55gr" },
  { alias: "Oreo", product: "Oreo x4 38gr" },
  { alias: "Barni", product: "Barni Шоколадный 30gr" },
  { alias: "Cheers 70", product: "Cheers Сметана и зелень 70gr" },
  { alias: "TUC chees", product: "TUC Crackers Sour cream and Onion" },
];

/**
 * Занести прайс в `vending_product`. Идемпотентно: существующих по имени не
 * трогает (цена владельца важнее прайса из скрипта). Возвращает счётчики.
 */
export async function seedVendingPrices(
  db: ReturnType<typeof createDb>,
): Promise<{ seeded: number; skipped: number }> {
  const existing = await db.select({ name: vendingProduct.name }).from(vendingProduct);
  const have = new Set(existing.map((e) => e.name));
  const fresh = VENDING_PRICELIST.filter((p) => !have.has(p.name));
  if (fresh.length > 0) {
    await db.insert(vendingProduct).values(
      fresh.map((p) => ({
        name: p.name,
        category: p.category,
        purchasePrice: p.price.toString(),
        packSize: packOf(p.category),
      })),
    );
  }
  return { seeded: fresh.length, skipped: VENDING_PRICELIST.length - fresh.length };
}

/**
 * Занести алиасы в `vending_alias`. Идемпотентно: по имеющемуся алиасу не
 * дублирует. Товар алиаса обязан быть в `vending_product` (иначе алиас
 * пропускается со счётчиком — сид прайса должен идти первым). Возвращает счётчики.
 */
/**
 * Занести алиасы в `vending_alias`. Идемпотентно: по имеющемуся алиасу не
 * дублирует. Товар алиаса обязан быть в `vending_product` (иначе алиас
 * пропускается со счётчиком — сид прайса должен идти первым).
 *
 * Заодно переносит остаток склада: до появления алиаса «Montella» владелец
 * мог вводить остаток сырым именем — строка `vending_stock` легла под ним, а
 * не под каноном. Если алиас добавляется ПОСЛЕ такого ввода, канон и старая
 * строка расходятся: `ingestStock` ищет остаток «до» под новым каноном, не
 * находит и молча теряет реальную недостачу/излишек, а старая строка навсегда
 * осиротевает (найдено адверсариал-ревью). Поэтому здесь строка склада,
 * совпавшая с алиасом (по нормализованному имени), переименовывается на
 * канон — если канонической строки ещё нет (иначе не ясно, какая настоящая).
 */
export async function seedVendingAliases(
  db: ReturnType<typeof createDb>,
): Promise<{ seeded: number; skipped: number; noProduct: number; stockRenamed: number }> {
  const [products, existing, stockRows] = await Promise.all([
    db.select({ id: vendingProduct.id, name: vendingProduct.name }).from(vendingProduct),
    db.select({ alias: vendingAlias.alias }).from(vendingAlias),
    db.select({ productName: vendingStock.productName, updatedAt: vendingStock.updatedAt }).from(vendingStock),
  ]);
  const idByName = new Map(products.map((p) => [p.name, p.id]));
  const have = new Set(existing.map((e) => e.alias));

  // Строки склада по нормализованному имени; если ввод дублировался под
  // разным регистром до появления алиаса — берём самую свежую (не пытаемся
  // склеивать остатки нескольких строк, это отдельная ручная сверка).
  const stockByKey = new Map<string, { productName: string; updatedAt: Date }>();
  for (const r of stockRows) {
    const key = normalizeProductName(r.productName);
    const prev = stockByKey.get(key);
    if (!prev || r.updatedAt > prev.updatedAt) stockByKey.set(key, r);
  }
  const stockNames = new Set(stockRows.map((r) => r.productName));

  const rows: { productId: string; alias: string; source: "warehouse" }[] = [];
  let noProduct = 0;
  let stockRenamed = 0;
  for (const a of VENDING_ALIASES) {
    if (have.has(a.alias)) continue;
    const productId = idByName.get(a.product);
    if (!productId) {
      noProduct += 1;
      continue;
    }
    rows.push({ productId, alias: a.alias, source: "warehouse" });

    const stale = stockByKey.get(normalizeProductName(a.alias));
    if (stale && stale.productName !== a.product && !stockNames.has(a.product)) {
      await db.update(vendingStock).set({ productName: a.product }).where(eq(vendingStock.productName, stale.productName));
      stockNames.delete(stale.productName);
      stockNames.add(a.product);
      stockRenamed += 1;
    }
  }
  if (rows.length > 0) await db.insert(vendingAlias).values(rows);
  return { seeded: rows.length, skipped: VENDING_ALIASES.length - rows.length - noProduct, noProduct, stockRenamed };
}

async function main(): Promise<void> {
  loadEnv({ path: path.resolve(__dirname, "../../../.env"), quiet: true });
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL не задан — прайс вендинга не занести.");
  const db = createDb(url);
  const { seeded, skipped } = await seedVendingPrices(db);
  console.log(`Прайс вендинга: занесено ${seeded}, уже было ${skipped} (всего ${VENDING_PRICELIST.length}).`);
  const al = await seedVendingAliases(db);
  console.log(
    `Алиасы вендинга: занесено ${al.seeded}, уже было ${al.skipped}` +
      (al.noProduct > 0 ? `, без товара ${al.noProduct}` : "") +
      (al.stockRenamed > 0 ? `, склад перенесён на канон ${al.stockRenamed}` : "") +
      ` (всего ${VENDING_ALIASES.length}).`,
  );
}

if (require.main === module) {
  main().catch((err: unknown) => {
    console.error("Сид прайса вендинга упал:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
