/**
 * Точки, ингредиенты бункеров и тара контейнеров — кофе-вендинг.
 *
 * Перенос из боевого референс-приложения владельца (vendhubunker): список
 * адресов, назначение ингредиентов на позиции 1–8 и эталонная тара по
 * контейнерам («наборам» 1–27) сняты 1:1 с его текущих настроек. Дальше
 * правится в панели, не в коде. Идемпотентно: повторный запуск не дублирует
 * (узнаём по уникальным ключам), существующих значений владельца не трогает.
 */
import path from "node:path";
import { config as loadEnv } from "dotenv";
import { createDb } from "./index";
import { and, eq } from "drizzle-orm";
import { coffeeBunkerConfig, coffeeContainerTare, coffeeIngredient, entity, org } from "./schema";

/** 22 точки, в порядке референс-приложения. */
export const COFFEE_LOCATIONS: string[] = [
  "American Hospital",
  "кардиология кпп",
  "кардиология 2 корпус",
  "KIUT CLINIC",
  "Grand clinic",
  "KIUT M corp",
  "SOLIQ OLMAZOR",
  "KIMYO",
  "Logistics",
  "DUNYO Supermarket",
  "ZIYO market",
  "KIUT Общежитие",
  "KIUT Библиотека",
  "4 корпус кардиология",
  "UzPost Office",
  "UzPost Hall",
  "Рынок Тансыкбаева",
  "Zemfira",
  "Фидокор",
  "Olma Администрация",
  "Mevazor Med",
  "Winners School",
];

/**
 * Позиция бункера (1–8) → допустимые ингредиенты. Позиция 8 без записей —
 * «Пусто» (бункер не используется). Позиция 3 держит два ингредиента —
 * техник заправляет то, что есть (см. комментарий у coffeeBunkerConfig).
 */
export const COFFEE_BUNKER_INGREDIENTS: Record<number, string[]> = {
  1: ["Сухое молоко"],
  2: ["Ягодный чай"],
  3: ["Лимонный чай", "Матча"],
  4: ["Сахар"],
  5: ["Шоколад"],
  6: ["MacCoffee"],
  7: ["Кофе"],
  8: [],
};

/**
 * Эталонная тара (пустой вес, г) — «набор» (физический контейнер 1–27) ×
 * позиция (1–8). `null` — контейнер в этой позиции ещё не калибровали.
 * Индекс массива = набор−1, элемент массива = позиция 1..8 по порядку.
 */
export const COFFEE_CONTAINER_TARE: (number | null)[][] = [
  [636, null, null, null, 620, null, 620, null], // 001
  [630, 630, 641, 627, 639, 637, 632, 630], // 002
  [628, 628, 624, 628, 658, 643, 625, 645], // 003
  [638, 624, 641, 635, 634, 636, 634, 634], // 004
  [617, 628, 642, 638, 632, 604, 659, 641], // 005
  [645, 626, 647, 643, 643, 625, 633, 643], // 006
  [627, 612, 643, 616, 618, 633, 629, 646], // 007
  [628, 622, 633, 620, 653, 631, 648, 648], // 008
  [617, 624, 626, 623, 640, 645, 645, 651], // 009
  [619, 624, 625, 620, 640, 621, 644, 614], // 010
  [609, 601, 638, 623, 627, 631, 646, 612], // 011
  [612, 615, 634, 628, 621, 600, 644, 640], // 012
  [635, 636, 625, 651, 651, 620, 624, 621], // 013
  [619, 620, 626, 625, 622, 616, 650, 667], // 014
  [637, 629, 644, 625, 628, 637, 626, 647], // 015
  [638, 645, 632, 643, 630, 611, 625, 632], // 016
  [626, 616, 634, 616, 633, 637, 680, 669], // 017
  [664, 639, 636, 628, 625, 648, 649, 621], // 018
  [636, 637, 610, 619, 648, 638, 644, 633], // 019
  [625, 653, 672, 659, 624, 648, 630, 625], // 020
  [643, 629, 642, 636, 617, 627, 634, 646], // 021
  [642, 622, 631, 627, 630, 648, 636, 620], // 022
  [629, 636, 643, 609, 629, 630, 628, 638], // 023
  [634, 628, 619, 627, 619, 629, 626, 647], // 024
  [634, 631, 632, 639, 614, 623, 632, 629], // 025
  [634, 615, 621, 624, 608, 623, 631, 643], // 026
  [647, 638, 622, 626, 618, 625, 618, 638], // 027
];

/**
 * Занести 22 точки. Идемпотентно: по имени.
 *
 * Точка — карточка реестра типа `location` (миграция 0049 влила справочник
 * `coffee_location` в `entity`). Утверждаем сразу: эти точки владелец знает и
 * по ним годами идёт работа — оставить их ждущими слова значило бы объявить
 * неподтверждённым то, что работает.
 */
export async function seedCoffeeLocations(db: ReturnType<typeof createDb>): Promise<{ seeded: number; skipped: number }> {
  const [vendhub] = await db.select({ id: org.id }).from(org).where(eq(org.code, "vendhub")).limit(1);
  if (!vendhub) throw new Error("Направление vendhub не заведено — сначала структурный сид");

  const existing = await db
    .select({ name: entity.name })
    .from(entity)
    .where(and(eq(entity.type, "location"), eq(entity.orgId, vendhub.id)));
  const have = new Set(existing.map((e) => e.name));
  const fresh = COFFEE_LOCATIONS.filter((name) => !have.has(name));
  if (fresh.length > 0) {
    await db.insert(entity).values(
      fresh.map((name) => ({
        orgId: vendhub.id,
        type: "location",
        name,
        approvedAt: new Date(),
        approvedBy: "owner",
        createdFrom: "seed-coffee",
      })),
    );
  }
  return { seeded: fresh.length, skipped: COFFEE_LOCATIONS.length - fresh.length };
}

/** Занести справочник ингредиентов + назначение на позиции бункера. Идемпотентно. */
export async function seedCoffeeBunkerIngredients(
  db: ReturnType<typeof createDb>,
): Promise<{ ingredientsSeeded: number; configSeeded: number }> {
  const names = [...new Set(Object.values(COFFEE_BUNKER_INGREDIENTS).flat())];
  const existingIngredients = await db.select({ id: coffeeIngredient.id, name: coffeeIngredient.name }).from(coffeeIngredient);
  const idByName = new Map(existingIngredients.map((e) => [e.name, e.id]));
  const freshNames = names.filter((n) => !idByName.has(n));
  if (freshNames.length > 0) {
    const inserted = await db
      .insert(coffeeIngredient)
      .values(freshNames.map((name) => ({ name })))
      .returning({ id: coffeeIngredient.id, name: coffeeIngredient.name });
    for (const row of inserted) idByName.set(row.name, row.id);
  }

  const existingConfig = await db.select({ position: coffeeBunkerConfig.position, ingredientId: coffeeBunkerConfig.ingredientId }).from(coffeeBunkerConfig);
  const haveConfig = new Set(existingConfig.map((c) => `${c.position}:${c.ingredientId}`));
  const configRows: { position: number; ingredientId: string }[] = [];
  for (const [posStr, ingredientNames] of Object.entries(COFFEE_BUNKER_INGREDIENTS)) {
    const position = Number(posStr);
    for (const name of ingredientNames) {
      const ingredientId = idByName.get(name);
      if (!ingredientId) continue;
      if (haveConfig.has(`${position}:${ingredientId}`)) continue;
      configRows.push({ position, ingredientId });
    }
  }
  if (configRows.length > 0) await db.insert(coffeeBunkerConfig).values(configRows);
  return { ingredientsSeeded: freshNames.length, configSeeded: configRows.length };
}

/** Занести эталонную тару 27×8. Идемпотентно: по (набор, позиция); пустые ячейки пропускаются. */
export async function seedCoffeeContainerTare(db: ReturnType<typeof createDb>): Promise<{ seeded: number; skipped: number }> {
  const existing = await db
    .select({ containerNumber: coffeeContainerTare.containerNumber, position: coffeeContainerTare.position })
    .from(coffeeContainerTare);
  const have = new Set(existing.map((e) => `${e.containerNumber}:${e.position}`));

  const rows: { containerNumber: number; position: number; tareWeight: number }[] = [];
  let blank = 0;
  COFFEE_CONTAINER_TARE.forEach((row, containerIdx) => {
    row.forEach((tareWeight, posIdx) => {
      if (tareWeight == null) {
        blank += 1;
        return;
      }
      const containerNumber = containerIdx + 1;
      const position = posIdx + 1;
      if (have.has(`${containerNumber}:${position}`)) return;
      rows.push({ containerNumber, position, tareWeight });
    });
  });
  if (rows.length > 0) await db.insert(coffeeContainerTare).values(rows);
  const total = COFFEE_CONTAINER_TARE.length * 8 - blank;
  return { seeded: rows.length, skipped: total - rows.length };
}

async function main(): Promise<void> {
  loadEnv({ path: path.resolve(__dirname, "../../../.env"), quiet: true });
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL не задан — кофе-вендинг не занести.");
  const db = createDb(url);

  const loc = await seedCoffeeLocations(db);
  console.log(`Точки кофе-вендинга: занесено ${loc.seeded}, уже было ${loc.skipped} (всего ${COFFEE_LOCATIONS.length}).`);

  const ing = await seedCoffeeBunkerIngredients(db);
  console.log(`Ингредиенты: занесено ${ing.ingredientsSeeded}. Назначений на позиции: занесено ${ing.configSeeded}.`);

  const tare = await seedCoffeeContainerTare(db);
  console.log(`Тара контейнеров: занесено ${tare.seeded}, уже было ${tare.skipped}.`);
}

if (require.main === module) {
  main().catch((err: unknown) => {
    console.error("Сид кофе-вендинга упал:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
