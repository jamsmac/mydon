/**
 * Стартовый каталог VendHub Snack & Drinks.
 *
 * Перенос данных из донора (репозиторий VendHub-Snack-Drinks, `db/03_seed.sql`):
 * сорок реальных позиций снек-/дринк-автоматов с ценами в сумах, фасовкой,
 * группой и категорией. Не выдумано — взято из рабочего сида той линии.
 *
 * Карточки заводятся ОТ ИСТОЧНИКА (`createdFrom`), а не владельцем: цены донора
 * (OLMA) — не его слово, поэтому каждая позиция приходит в очередь утверждения
 * (approved_at = NULL). Владелец правит цену и подтверждает — вот тогда это факт
 * реестра. До того карточки видно, но фактом они не считаются.
 *
 * Цена ПОКУПКИ намеренно пуста: у полок её не знают, владелец допишет — без неё
 * не посчитать себестоимость и наценку (см. resaleGaps в @mydon/shared).
 *
 * Идемпотентен: повторный запуск не дублирует — позиция узнаётся по имени.
 */
import path from "node:path";
import { config as loadEnv } from "dotenv";
import { and, eq, inArray } from "drizzle-orm";
import { createDb } from "./index";
import { entity, org } from "./schema";

/** Направление, куда ложится каталог. */
const DOMAIN = "vendhub";
/** Откуда карточки — читается владельцем словами в очереди утверждения. */
export const CATALOG_SOURCE = "каталог VendHub Snack & Drinks";

/** Группа автомата: напитки или снеки — как в доноре (drinks/snacks). */
export type CatalogGroup = "напитки" | "снеки";

/** Одна позиция каталога: имя, фасовка, цена продажи (сум). */
export interface CatalogItem {
  name: string;
  /** Фасовка как в доноре: «0.25 CAN», «50g» — объём/вес и тип упаковки. */
  vol: string;
  /** Цена продажи в сумах (selling_price донора). */
  price: number;
}

/** Каталог по категориям — ровно как в `03_seed.sql` донора. */
export const CATALOG: { group: CatalogGroup; category: string; items: CatalogItem[] }[] = [
  {
    group: "напитки",
    category: "Газированные",
    items: [
      { name: "Coca-Cola Classic", vol: "0.25 CAN", price: 10000 },
      { name: "Coca-Cola Zero", vol: "0.25 CAN", price: 10000 },
      { name: "Pepsi", vol: "0.25 CAN", price: 10000 },
      { name: "Pepsi Black", vol: "0.25 CAN", price: 10000 },
      { name: "Fanta Orange", vol: "0.25 CAN", price: 10000 },
      { name: "Sprite", vol: "0.25 CAN", price: 10000 },
      { name: "7UP", vol: "0.25 CAN", price: 10000 },
      { name: "Mirinda", vol: "0.25 CAN", price: 10000 },
    ],
  },
  {
    group: "напитки",
    category: "Энергетики",
    items: [
      { name: "Red Bull", vol: "0.25 CAN", price: 25000 },
      { name: "Flash Up Energy", vol: "0.45 CAN", price: 15000 },
      { name: "Adrenaline Rush", vol: "0.25 CAN", price: 18000 },
      { name: "Monster Energy", vol: "0.33 CAN", price: 22000 },
    ],
  },
  {
    group: "напитки",
    category: "Мохито",
    items: [
      { name: "Moxito Lime", vol: "0.5 CAN", price: 15000 },
      { name: "Moxito Mint", vol: "0.5 CAN", price: 15000 },
      { name: "Moxito Classic", vol: "0.5 CAN", price: 15000 },
    ],
  },
  {
    group: "напитки",
    category: "Фреш",
    items: [
      { name: "Omaf Apple", vol: "0.5 PET", price: 8000 },
      { name: "Omaf Multifruit", vol: "0.5 PET", price: 8000 },
      { name: "Laimon Fresh", vol: "0.5 PET", price: 12000 },
    ],
  },
  {
    group: "напитки",
    category: "Чай",
    items: [
      { name: "Fuse Tea Mango", vol: "0.5 PET", price: 10000 },
      { name: "Fuse Tea Lemon", vol: "0.5 PET", price: 10000 },
      { name: "Fuse Tea Peach", vol: "0.5 PET", price: 10000 },
      { name: "Lipton Ice Tea", vol: "0.5 PET", price: 11000 },
    ],
  },
  {
    group: "напитки",
    category: "Вода",
    items: [
      { name: "Borjomi", vol: "0.33 CAN", price: 12000 },
      { name: "Bonaqua", vol: "0.5 PET", price: 6000 },
      { name: "Hayat", vol: "0.5 PET", price: 5000 },
      { name: "Nestle Pure Life", vol: "0.5 PET", price: 6000 },
      { name: "Sensation", vol: "0.5 PET", price: 7000 },
      { name: "Ozbegim", vol: "0.5 PET", price: 5000 },
    ],
  },
  {
    group: "снеки",
    category: "Батончики",
    items: [
      { name: "Snickers", vol: "50g", price: 9000 },
      { name: "Twix", vol: "55g", price: 10000 },
      { name: "Bounty", vol: "55g", price: 10000 },
      { name: "KitKat", vol: "45g", price: 12000 },
      { name: "Milky Way", vol: "52g", price: 9000 },
      { name: "Picnic", vol: "52g", price: 10000 },
      { name: "Kinder Bueno", vol: "43g", price: 13000 },
    ],
  },
  {
    group: "снеки",
    category: "Снеки и чипсы",
    items: [
      { name: "Lay's Classic", vol: "70g", price: 10000 },
      { name: "Lay's Sour Cream", vol: "70g", price: 10000 },
      { name: "Pringles Original", vol: "40g", price: 18000 },
      { name: "Cheetos", vol: "55g", price: 8000 },
      { name: "TUC Crackers", vol: "100g", price: 12000 },
    ],
  },
];

/** Готовая к вставке строка entity — карточка товара на перепродажу. */
export interface CatalogEntity {
  orgId: string;
  type: "product";
  name: string;
  attrs: Record<string, unknown>;
  createdFrom: string;
}

/**
 * Разворачивает каталог в строки реестра.
 *
 * Чистая функция (без базы) — её и проверяют тесты: состав, цены, уникальность
 * имён. `вид: перепродажа` — эти позиции продаются как есть, не из рецепта;
 * `цена продажи` из донора, `цена покупки` пуста (владелец допишет).
 */
export function catalogEntities(orgId: string): CatalogEntity[] {
  const rows: CatalogEntity[] = [];
  for (const g of CATALOG) {
    for (const it of g.items) {
      rows.push({
        orgId,
        type: "product",
        name: it.name,
        attrs: {
          "вид": "перепродажа",
          "цена продажи": it.price,
          "фасовка": it.vol,
          "группа": g.group,
          "категория товара": g.category,
          "источник": CATALOG_SOURCE,
        },
        createdFrom: CATALOG_SOURCE,
      });
    }
  }
  return rows;
}

async function main(): Promise<void> {
  loadEnv({ path: path.resolve(__dirname, "../../../.env"), quiet: true });
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL не задан. Заполните его в корневом .env монорепо.");
  }

  const db = createDb(url);

  const [dom] = await db.select({ id: org.id }).from(org).where(eq(org.code, DOMAIN));
  if (!dom) {
    throw new Error(
      `Направление «${DOMAIN}» не заведено. Сначала выполните структурный сид (pnpm db:seed).`,
    );
  }

  const rows = catalogEntities(dom.id);
  const names = rows.map((r) => r.name);

  // Идемпотентность: что из каталога уже заведено в этом направлении — не трогаем.
  const existing = await db
    .select({ name: entity.name })
    .from(entity)
    .where(and(eq(entity.orgId, dom.id), eq(entity.type, "product"), inArray(entity.name, names)));
  const have = new Set(existing.map((e) => e.name));

  const toInsert = rows.filter((r) => !have.has(r.name));
  if (toInsert.length > 0) {
    // approved_at не ставим: карточки заведены не владельцем, ждут его слова в
    // очереди утверждения. createdFrom помечает источник — владелец видит его словами.
    await db.insert(entity).values(
      toInsert.map((r) => ({
        orgId: r.orgId,
        type: r.type,
        name: r.name,
        attrs: r.attrs,
        createdFrom: r.createdFrom,
      })),
    );
  }

  console.log(
    `Каталог «${CATALOG_SOURCE}»: заведено ${toInsert.length}, уже было ${have.size}, всего ${rows.length}.`,
  );
  console.log(
    "Карточки ждут утверждения владельцем — открой «На утверждение» (/queue) и подтверди (правь цену там же).",
  );
  process.exit(0);
}

// Запуск только как скрипт (node dist/seed-catalog.js), не при импорте из теста.
if (require.main === module) {
  main().catch((err: unknown) => {
    console.error("Каталог не загружен:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
