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

/**
 * Прайс вендинга.
 *
 * Напитки — из фискального каталога Multikassa (лист «Данные»/«Вывод цен»
 * реестра владельца, ИКПУ/GoodsID уже зарегистрированы): 30 SKU, закупочная
 * цена взята за период «с 26/08/2025» (для 4 позиций без цены в этом
 * периоде — Love Is, Borjomi, Pulpy, Pepsi 0,449 — взята цена предыдущего
 * периода, других данных о них нет). Закупочная цена почти не менялась между
 * периодами (менялась только розничная, которую MYDON не хранит) — кроме
 * Laimon Fresh Berries (4500→8000), взята новая. Прежние приблизительные
 * записи напитков (из Приложения А) заменены точными фискальными именами;
 * старые имена перенесены в VENDING_ALIASES, чтобы существующий ввод и склад
 * не осиротели (seedVendingAliases переносит строку склада на канон).
 *
 * Снеки — из Приложения А, без изменений в этом сиде.
 */
export const VENDING_PRICELIST: PriceItem[] = [
  // ── Напитки (фискальный каталог, 30 SKU) ──
  { name: "Coca-Cola Classic 0,5", category: "drink", price: 5859 },
  { name: "Fanta C 0,5", category: "drink", price: 5859 },
  { name: "Flash Up Energy CAN 0,45", category: "drink", price: 9167 },
  { name: "Plus 18 CAN 0,45", category: "drink", price: 9990 },
  { name: "Laimon Fresh CAN 0,33", category: "drink", price: 8000 },
  { name: "Laimon Fresh Mango CAN 0,33", category: "drink", price: 8000 },
  { name: "Pepsi 0,5", category: "drink", price: 5859 },
  { name: "Moxito Fresh Klubnika CAN 0,5", category: "drink", price: 9750 },
  { name: "Moxito Fresh CAN 0,5", category: "drink", price: 9800 },
  { name: "Red Bull CAN 0,25", category: "drink", price: 16500 },
  { name: "Lit Energy Blueberry CAN 0,45", category: "drink", price: 13500 },
  { name: "Lit Energy Mango Coco CAN 0,45", category: "drink", price: 13500 },
  { name: "Coca-Cola Classic CAN 0,25", category: "drink", price: 4999.16 },
  { name: "Fanta C CAN 0,25", category: "drink", price: 5000 },
  { name: "Flash Up Mojito Straw CAN 0,45", category: "drink", price: 8333 },
  { name: "Fresh Tag Lemonade CAN 0,45", category: "drink", price: 8333 },
  { name: "Love Is Pineapple-Coc CAN 0,33", category: "drink", price: 11690 },
  { name: "Borjomi Mineral Water CAN 0,33", category: "drink", price: 9000 },
  { name: "Flash up Peach Pineap CAN 0,45", category: "drink", price: 8333 },
  { name: "Moxito Fresh Mango CAN 0,5", category: "drink", price: 9750 },
  { name: "Flash Up Bubble Gum CAN 0,45", category: "drink", price: 8333 },
  { name: "FuseTea Tea Fuse Mango-Cham", category: "drink", price: 6084 },
  { name: "Pulpy", category: "drink", price: 13990 },
  { name: "Red Bull CAN 0,355", category: "drink", price: 28990 },
  { name: "Pepsi CAN 0,449", category: "drink", price: 7000 },
  { name: "Laimon Fresh Berries CAN 0,33", category: "drink", price: 8000 },
  { name: "Royal Pomegranate CAN 0,3", category: "drink", price: 5000 },
  { name: "Pepsi CAN 0,25", category: "drink", price: 5000 },
  { name: "Coca-Cola ZeroS CAN 0.25", category: "drink", price: 4999.16 },
  { name: "Lipton Lemon Tea 0.5", category: "drink", price: 5833.25 },
  // ── Напитки вне фискального каталога напиткового автомата (снек-машина) ──
  { name: "Montella Вода минеральная 330ml", category: "drink", price: 2090 },
  { name: "Nesquick Choco 200ml", category: "drink", price: 6900 },
  { name: "Ozbegim Tea Mango Moychechak 450ml", category: "drink", price: 9000 },
  { name: "Sprite 250ml", category: "drink", price: 5167 },
  // ── Снеки (Приложение А) ──
  { name: "Barni Шоколадный 30gr", category: "snack", price: 3875 },
  { name: "Bounty Coconut 55gr", category: "snack", price: 7800 },
  { name: "Cheers Сметана и зелень 70gr", category: "snack", price: 9500 },
  { name: "ChocoPie Orion 30gr", category: "snack", price: 2000 },
  { name: "Ermak Asl Qurt 7шт 30gr", category: "snack", price: 6800 },
  { name: "Ermak Арахис с солью 50gr", category: "snack", price: 4800 },
  { name: "Flint Kabob 100gr", category: "snack", price: 5800 },
  { name: "Kinder Bueno Chocolate 43gr", category: "snack", price: 11000 },
  { name: "Kitkat 40gr", category: "snack", price: 8800 },
  { name: "Lays Рифлёные Сметана и лук 70gr", category: "snack", price: 13000 },
  { name: "M and Ms Шоколадный 40gr", category: "snack", price: 9000 },
  { name: "Oreo x4 38gr", category: "snack", price: 5500 },
  { name: "Snickers 50gr", category: "snack", price: 7000 },
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
  // ── Миграция старых приблизительных имён (Приложение А) на фискальный канон.
  // Существующие ввод/склад под старым именем не осиротеют — seedVendingAliases
  // переносит строку склада на канон при появлении алиаса.
  { alias: "Borjomi Mineral 330ml", product: "Borjomi Mineral Water CAN 0,33" },
  { alias: "CocaCola Classic CAN 250ml", product: "Coca-Cola Classic CAN 0,25" },
  { alias: "CocaCola ZERO CAN 250ml", product: "Coca-Cola ZeroS CAN 0.25" },
  { alias: "Fanta Classic CAN 250ml", product: "Fanta C CAN 0,25" },
  { alias: "FlashUp Energy 330ml", product: "Flash Up Energy CAN 0,45" },
  { alias: "FuseTea Tea Mango Cham 450ml", product: "FuseTea Tea Fuse Mango-Cham" },
  { alias: "LaimonFresh Lime 330ml", product: "Laimon Fresh CAN 0,33" },
  { alias: "Moxito Fresh Klubnika CAN 450ml", product: "Moxito Fresh Klubnika CAN 0,5" },
  { alias: "Moxito Fresh Lime CAN 450ml", product: "Moxito Fresh CAN 0,5" },
  { alias: "Pepsi CAN 250ml", product: "Pepsi CAN 0,25" },
  { alias: "Plus 18 Energy 330ml", product: "Plus 18 CAN 0,45" },
  { alias: "RedBull Classic 250 ml", product: "Red Bull CAN 0,25" },

  // ── Напитки: рукописные листы и заметки закупа (31.07–02.08.2026) ──
  { alias: "Fuse Tea", product: "FuseTea Tea Fuse Mango-Cham" },
  { alias: "Fuse Tea can 0.45", product: "FuseTea Tea Fuse Mango-Cham" },
  { alias: "Coca Cola cl", product: "Coca-Cola Classic CAN 0,25" },
  { alias: "Coca cola classic can 0.25", product: "Coca-Cola Classic CAN 0,25" },
  { alias: "Sprite can 0.25", product: "Sprite 250ml" },
  { alias: "Fanta", product: "Fanta C CAN 0,25" },
  { alias: "Fanta can 0.25", product: "Fanta C CAN 0,25" },
  { alias: "Montella", product: "Montella Вода минеральная 330ml" },
  { alias: "Montella pet 0.33", product: "Montella Вода минеральная 330ml" },
  { alias: "18+", product: "Plus 18 CAN 0,45" },
  { alias: "Plus 18 can 0.33", product: "Plus 18 CAN 0,45" },
  { alias: "Flash", product: "Flash Up Energy CAN 0,45" },
  { alias: "Flash can 0.33", product: "Flash Up Energy CAN 0,45" },
  { alias: "lemon Fr", product: "Laimon Fresh CAN 0,33" },
  { alias: "LimonFresh", product: "Laimon Fresh CAN 0,33" },
  { alias: "LimonFresh can 0.33", product: "Laimon Fresh CAN 0,33" },
  { alias: "Moxito", product: "Moxito Fresh CAN 0,5" },
  { alias: "Moxito lime can 0.45", product: "Moxito Fresh CAN 0,5" },
  { alias: "Moxito клуб", product: "Moxito Fresh Klubnika CAN 0,5" },
  { alias: "Moxito klibn", product: "Moxito Fresh Klubnika CAN 0,5" },
  { alias: "Moxito klubn can 0.45", product: "Moxito Fresh Klubnika CAN 0,5" },
  { alias: "Red bull can 0.25", product: "Red Bull CAN 0,25" },

  // ── Напитки: планограммы и складские листы (реестр владельца) ──
  // «RedBull CAN 0,33» из планограммы намеренно не алиасим: такого SKU нет
  // (только 0,25 и 0,355 с разными ценами) — похоже на опечатку владельца,
  // а угадывать между двумя ценами на реальные деньги рискованно.
  { alias: "Coca-cola classic 0,5", product: "Coca-Cola Classic 0,5" },
  { alias: "Coca-cola CAN 0,25", product: "Coca-Cola Classic CAN 0,25" },
  { alias: "Cola 0,25", product: "Coca-Cola Classic CAN 0,25" },
  { alias: "Cola zero 0,25", product: "Coca-Cola ZeroS CAN 0.25" },
  { alias: "Cola Zero", product: "Coca-Cola ZeroS CAN 0.25" },
  { alias: "Fanta  0,25", product: "Fanta C CAN 0,25" },
  { alias: "Fanta CAN 0,25", product: "Fanta C CAN 0,25" },
  { alias: "Pepsi 0,25", product: "Pepsi CAN 0,25" },
  { alias: "Мохито лайм", product: "Moxito Fresh CAN 0,5" },
  { alias: "Мохито Лайм", product: "Moxito Fresh CAN 0,5" },
  { alias: "Мохито Lime 0,45", product: "Moxito Fresh CAN 0,5" },
  { alias: "Мохито Клубничный 0,45", product: "Moxito Fresh Klubnika CAN 0,5" },
  { alias: "Мохито клубника", product: "Moxito Fresh Klubnika CAN 0,5" },
  { alias: "Мохито Клубн", product: "Moxito Fresh Klubnika CAN 0,5" },
  { alias: "18+ 0.33 ж/б", product: "Plus 18 CAN 0,45" },
  { alias: "Plus18 0,33", product: "Plus 18 CAN 0,45" },
  { alias: "Plus18 0,45", product: "Plus 18 CAN 0,45" },
  { alias: "Flash 0,33", product: "Flash Up Energy CAN 0,45" },
  { alias: "Flash 0.33 ж/б", product: "Flash Up Energy CAN 0,45" },
  { alias: "FlashUp CAN 0,45", product: "Flash Up Energy CAN 0,45" },
  { alias: "Flash Peach CAN 0,45", product: "Flash up Peach Pineap CAN 0,45" },
  { alias: "Flash Molito Straw 0,45", product: "Flash Up Mojito Straw CAN 0,45" },
  { alias: "Flash Up Bubblegum", product: "Flash Up Bubble Gum CAN 0,45" },
  { alias: "Fuse Tea 0,45", product: "FuseTea Tea Fuse Mango-Cham" },
  { alias: "Fusetea", product: "FuseTea Tea Fuse Mango-Cham" },
  { alias: "FuseTea Mango-Cham", product: "FuseTea Tea Fuse Mango-Cham" },
  { alias: "LaimonF lime", product: "Laimon Fresh CAN 0,33" },
  { alias: "LaimonFresh lime", product: "Laimon Fresh CAN 0,33" },
  { alias: "LaimonFresh Lime 0,33", product: "Laimon Fresh CAN 0,33" },
  { alias: "LaimonFresh Berries 0,33", product: "Laimon Fresh Berries CAN 0,33" },
  { alias: "Lit Mango CAN 0,5", product: "Lit Energy Mango Coco CAN 0,45" },
  { alias: "Lit Blueberry CAN 0,45", product: "Lit Energy Blueberry CAN 0,45" },
  { alias: "Redbull 0,25", product: "Red Bull CAN 0,25" },
  { alias: "RedBull", product: "Red Bull CAN 0,25" },
  { alias: "Royal Pomegranate", product: "Royal Pomegranate CAN 0,3" },
  { alias: "Borjomi 0,33", product: "Borjomi Mineral Water CAN 0,33" },
  { alias: "Montella Вода 0,33", product: "Montella Вода минеральная 330ml" },
  { alias: "O'zbegim 0,45", product: "Ozbegim Tea Mango Moychechak 450ml" },
  { alias: "O'zbegim", product: "Ozbegim Tea Mango Moychechak 450ml" },
  { alias: "Nesquick 0,2", product: "Nesquick Choco 200ml" },
  { alias: "Nesquick 0,25", product: "Nesquick Choco 200ml" },
  { alias: "Sprite 0.25", product: "Sprite 250ml" },
  { alias: "Lipton 0,25", product: "Lipton Lemon Tea 0.5" },

  // ── Снеки: рукописные листы закупа ──
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

  // ── Снеки: планограммы и складские листы (реестр владельца) ──
  { alias: "TUC печенье", product: "TUC Crackers Sour cream and Onion" },
  { alias: "Lays 70g", product: "Lays Рифлёные Сметана и лук 70gr" },
  { alias: "Lays (70)", product: "Lays Рифлёные Сметана и лук 70gr" },
  { alias: "Flint 100g", product: "Flint Kabob 100gr" },
  { alias: "Ermak арахис", product: "Ermak Арахис с солью 50gr" },
  { alias: "Ermak Арахис", product: "Ermak Арахис с солью 50gr" },
  { alias: "Курт ermak", product: "Ermak Asl Qurt 7шт 30gr" },
  { alias: "Ermak Qurt 30gr", product: "Ermak Asl Qurt 7шт 30gr" },
  { alias: "Kit Kat", product: "Kitkat 40gr" },
  { alias: "M&Ms", product: "M and Ms Шоколадный 40gr" },
  { alias: "Cheers", product: "Cheers Сметана и зелень 70gr" },
  { alias: "Oreo 4шт", product: "Oreo x4 38gr" },
  { alias: "Суперконтик", product: "СуперКонтик Шоколадный вкус 100gr" },
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
