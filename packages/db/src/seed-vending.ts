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
import { createDb } from "./index";
import { vendingProduct } from "./schema";

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

async function main(): Promise<void> {
  loadEnv({ path: path.resolve(__dirname, "../../../.env"), quiet: true });
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL не задан — прайс вендинга не занести.");
  const db = createDb(url);
  const { seeded, skipped } = await seedVendingPrices(db);
  console.log(`Прайс вендинга: занесено ${seeded}, уже было ${skipped} (всего ${VENDING_PRICELIST.length}).`);
}

if (require.main === module) {
  main().catch((err: unknown) => {
    console.error("Сид прайса вендинга упал:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
