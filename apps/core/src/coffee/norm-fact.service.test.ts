import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  coffeeBunkerConfig,
  coffeeContainerReturn,
  coffeeContainerTare,
  coffeeIngredient,
  coffeeOrder,
  coffeeRefill,
  entity,
  machinePlacement,
  productNameAlias,
} from "@mydon/db";
import { NormFactService } from "./norm-fact.service";

/**
 * Стаб БД: различает таблицы по ссылке (тот же приём, что и в
 * `coffee.service.test.ts`). Колонки, запрошенные в `.select({...})`,
 * стаб НЕ проецирует — он возвращает фикстуру как есть, поэтому поля
 * фикстуры должны называться так же, как их читает сервис (см. норма
 * считается по алиасу SQL-колонки `date`, а не по `ts` — стаб не выполняет
 * настоящий SQL, только имя поля имеет значение).
 */
function normFactDb(tables: {
  refills?: unknown[];
  returns?: unknown[];
  tare?: unknown[];
  bunkerConfig?: unknown[];
  ingredients?: unknown[];
  placements?: unknown[];
  orders?: unknown[];
  entities?: unknown[];
  aliases?: unknown[];
}) {
  const tableOf = (t: unknown): unknown[] => {
    if (t === coffeeRefill) return tables.refills ?? [];
    if (t === coffeeContainerReturn) return tables.returns ?? [];
    if (t === coffeeContainerTare) return tables.tare ?? [];
    if (t === coffeeBunkerConfig) return tables.bunkerConfig ?? [];
    if (t === coffeeIngredient) return tables.ingredients ?? [];
    if (t === machinePlacement) return tables.placements ?? [];
    if (t === coffeeOrder) return tables.orders ?? [];
    if (t === entity) return tables.entities ?? [];
    if (t === productNameAlias) return tables.aliases ?? [];
    return [];
  };
  const selectChain = (t: unknown) => {
    const rows = tableOf(t);
    const chain = {
      where: () => chain,
      orderBy: () => chain,
      limit: () => Promise.resolve(rows),
      innerJoin: () => chain,
      leftJoin: () => chain,
      then: (resolve: (v: unknown[]) => void) => resolve(rows),
    };
    return chain;
  };
  const db = { select: (_cols?: unknown) => ({ from: (t: unknown) => selectChain(t) }) };
  return db as never;
}

// ── Общая фикстура: точка «КПП», автомат «Автомат 1» размещён с 2025-12-01. ──
const loc = { id: "loc-1", type: "location", name: "КПП" };
const machine = { id: "machine-1", type: "machine", name: "Автомат 1" };
const coffeeCard = { id: "card-coffee", type: "product", name: "Капучино", attrs: { "состав": JSON.stringify([{ ingredientId: "ing-entity-coffee", quantity: 20, unit: "г" }]) } };
const ingredient = { id: "ing-1", name: "Кофе", entityId: "ing-entity-coffee" };
const placement = { entityId: "machine-1", locationId: "loc-1", startDate: "2025-12-01", endDate: null };

function order(date: string, opts: { delivered?: boolean; countable?: boolean; goodsName?: string; machineId?: string | null } = {}) {
  const delivered = opts.delivered ?? true;
  return {
    machineId: opts.machineId ?? "machine-1",
    date,
    goodsName: opts.goodsName ?? "Капучино",
    brewStatus: delivered ? "2" : "1",
    countable: opts.countable ?? true,
  };
}

describe("NormFactService.report — сборка периодов бункера", () => {
  it("валидирует период: формат даты и порядок границ", async () => {
    const s = new NormFactService(normFactDb({}));
    await assert.rejects(() => s.report("2026-01-01", "не дата"), /ГГГГ-ММ-ДД/);
    await assert.rejects(() => s.report("2026-06-01", "2026-01-01"), /позже конца/);
  });

  it("пять сценариев полноты + окно дат + расхождение delivered/countable", async () => {
    const refills = [
      // 1) полный: тара откалибрована, позиция однозначна, продажи есть.
      { position: 1, containerNumber: 1, enteredDate: "2026-01-01", filledWeight: 600, locationId: "loc-1", ingredientId: null },
      // 2) тара не откалибрована: возврат (нетто) тяжелее заливки.
      { position: 1, containerNumber: 2, enteredDate: "2026-02-01", filledWeight: 400, locationId: "loc-1", ingredientId: null },
      // 3) позиция неоднозначна: два кандидата у позиции 2, заливка без ingredientId.
      { position: 2, containerNumber: 3, enteredDate: "2026-03-01", filledWeight: 300, locationId: "loc-1", ingredientId: null },
      // 4) нет размещения: набор 9 никогда не калибровался (тары нет вовсе).
      { position: 1, containerNumber: 9, enteredDate: "2026-04-01", filledWeight: 400, locationId: "loc-1", ingredientId: null },
      // 5) нормы нет: тара и позиция в порядке, но за интервал ни одной чашки.
      { position: 1, containerNumber: 4, enteredDate: "2026-05-01", filledWeight: 500, locationId: "loc-1", ingredientId: null },
      // Вне запрошенного окна (ноябрь 2025) — не должен попасть в выдачу вовсе.
      { position: 1, containerNumber: 5, enteredDate: "2025-11-01", filledWeight: 500, locationId: "loc-1", ingredientId: null },
    ];
    const returns = [
      { position: 1, containerNumber: 1, weight: 250, returnedDate: "2026-01-10" },
      { position: 1, containerNumber: 2, weight: 900, returnedDate: "2026-02-05" },
      { position: 2, containerNumber: 3, weight: 100, returnedDate: "2026-03-05" },
      { position: 1, containerNumber: 9, weight: 100, returnedDate: "2026-04-05" },
      { position: 1, containerNumber: 4, weight: 200, returnedDate: "2026-05-10" },
      { position: 1, containerNumber: 5, weight: 100, returnedDate: "2025-11-10" },
    ];
    const tare = [
      { containerNumber: 1, position: 1, tareWeight: 100 },
      { containerNumber: 2, position: 1, tareWeight: 100 },
      { containerNumber: 3, position: 2, tareWeight: 50 },
      { containerNumber: 4, position: 1, tareWeight: 100 },
      { containerNumber: 5, position: 1, tareWeight: 100 },
      // контейнер 9 намеренно не откалиброван — сценарий «нет размещения».
    ];
    const bunkerConfig = [
      { position: 1, ingredientId: "ing-1" },
      { position: 2, ingredientId: "ing-a" },
      { position: 2, ingredientId: "ing-b" },
    ];
    const ingredients = [ingredient, { id: "ing-a", name: "Лимонный чай", entityId: "ing-entity-a" }, { id: "ing-b", name: "Матча", entityId: "ing-entity-b" }];

    const orders = [
      // Сценарий 1: 10 выданных чашек капучино в интервале — норма 20г × 10 = 200г.
      ...Array.from({ length: 10 }, (_, i) => order(`2026-01-0${(i % 9) + 1}`)),
      // Расхождение orderIsDelivered/countable (R-F5): 2 строки, обе внутри окна.
      order("2026-01-05", { delivered: true, countable: false }),
      order("2026-01-06", { delivered: false, countable: true }),
    ];

    const db = normFactDb({
      refills,
      returns,
      tare,
      bunkerConfig,
      ingredients,
      placements: [placement],
      orders,
      entities: [loc, machine, coffeeCard],
      aliases: [],
    });
    const s = new NormFactService(db);
    const report = await s.report("2026-01-01", "2026-05-31");

    // Вне окна (2025-11) не попадает вовсе.
    assert.equal(report.periods.length, 5);
    assert.ok(!report.periods.some((p) => p.from === "2025-11-01"));

    const p1 = report.periods.find((p) => p.to === "2026-01-10")!;
    assert.equal(p1.полнота, "полный");
    assert.equal(p1.факт, 350); // (600-100) - (250-100)
    // 10 «плановых» чашек + 1 выданная-но-неучтённая-в-выручке (delivered:true,
    // countable:false — та же строка, что считается в расхождении R-F5 ниже):
    // сырьё списывается по orderIsDelivered, поэтому она тоже входит в норму.
    assert.equal(p1.чашек, 11);
    assert.equal(p1.норма, 220);
    assert.equal(p1.разница, 130);

    const p2 = report.periods.find((p) => p.to === "2026-02-05")!;
    assert.equal(p2.полнота, "тара не откалибрована");
    assert.equal(p2.разница, null);

    const p3 = report.periods.find((p) => p.to === "2026-03-05")!;
    assert.equal(p3.полнота, "позиция неоднозначна");
    assert.equal(p3.ingredientId, null);
    assert.equal(p3.разница, null);

    const p4 = report.periods.find((p) => p.to === "2026-04-05")!;
    assert.equal(p4.полнота, "нет размещения");
    assert.equal(p4.разница, null);

    const p5 = report.periods.find((p) => p.to === "2026-05-10")!;
    assert.equal(p5.полнота, "нормы нет");
    assert.equal(p5.норма, null);
    assert.equal(p5.разница, null);

    // Итог — ТОЛЬКО по «полному» периоду (R-F2): единственный вклад — p1.
    assert.deepEqual(report.итог, { факт: 350, норма: 220, разница: 130, периодов: 1 });

    // внеИтога — 4 периода, разбивка по причине без потерь (4 = 1+1+1+1).
    assert.equal(report.внеИтога.периодов, 4);
    const причины = new Map(report.внеИтога.причины.map((c) => [c.причина, c.периодов]));
    assert.equal(причины.get("тара не откалибрована"), 1);
    assert.equal(причины.get("позиция неоднозначна"), 1);
    assert.equal(причины.get("нет размещения"), 1);
    assert.equal(причины.get("нормы нет"), 1);

    // R-F5: 2 несовпадения delivered/countable внутри окна — видно числом.
    assert.equal(report.расхождениеDeliveredCountable, 2);
  });

  it("товар опознаётся через product_name_alias, а «состав» разбирается и из JSON-строки, и из готового массива", async () => {
    // Карточка хранит состав ДВОЙНЫМ кодированием (проверено на проде,
    // jsonb_typeof(attrs->'состав') = 'string') — сервис обязан её распознать.
    const cardViaAlias = { id: "card-tea", type: "product", name: "Матча Латте", attrs: { "состав": JSON.stringify([{ ingredientId: "ing-entity-coffee", quantity: 15, unit: "г" }]) } };
    const refills = [{ position: 1, containerNumber: 1, enteredDate: "2026-06-01", filledWeight: 600, locationId: "loc-1", ingredientId: null }];
    const returns = [{ position: 1, containerNumber: 1, weight: 200, returnedDate: "2026-06-10" }];
    const tare = [{ containerNumber: 1, position: 1, tareWeight: 100 }];
    const bunkerConfig = [{ position: 1, ingredientId: "ing-1" }];
    const orders = [order("2026-06-05", { goodsName: "Matcha Latte (панель)" })];
    const aliases = [{ name: "Matcha Latte (панель)", entityId: "card-tea" }];

    const db = normFactDb({
      refills, returns, tare, bunkerConfig,
      ingredients: [ingredient],
      placements: [placement],
      orders,
      entities: [loc, machine, cardViaAlias],
      aliases,
    });
    const s = new NormFactService(db);
    const report = await s.report("2026-06-01", "2026-06-30");

    assert.equal(report.periods.length, 1);
    const p = report.periods[0]!;
    assert.equal(p.полнота, "полный");
    assert.equal(p.чашек, 1);
    assert.equal(p.норма, 15); // разобрали JSON-строку состава и нашли товар по алиасу
  });

  it("период без единой чашки: явный расход — «нормы нет», шум весов — «полный» с нормой 0", async () => {
    // Ни одного заказа за август 2026 на этой точке нет вовсе — все три
    // периода ниже честно получают чашек: 0. Различает их только факт.
    const refills = [
      // A: реальный расход без единой продажи — ровно тот отказ, ради
      // которого сделан весь срез. факт = (500-100) - (150-100) = 350.
      { position: 1, containerNumber: 20, enteredDate: "2026-07-01", filledWeight: 500, locationId: "loc-1", ingredientId: null },
      // B: на границе порога шума весов (10 г) — ещё «полный».
      // факт = (500-100) - (490-100) = 10.
      { position: 1, containerNumber: 21, enteredDate: "2026-08-01", filledWeight: 500, locationId: "loc-1", ingredientId: null },
      // C: на 1 г за порогом — уже «нормы нет», а не «почти полный».
      // факт = (500-100) - (489-100) = 11.
      { position: 1, containerNumber: 22, enteredDate: "2026-08-10", filledWeight: 500, locationId: "loc-1", ingredientId: null },
    ];
    const returns = [
      { position: 1, containerNumber: 20, weight: 150, returnedDate: "2026-07-10" },
      { position: 1, containerNumber: 21, weight: 490, returnedDate: "2026-08-05" },
      { position: 1, containerNumber: 22, weight: 489, returnedDate: "2026-08-15" },
    ];
    const tare = [
      { containerNumber: 20, position: 1, tareWeight: 100 },
      { containerNumber: 21, position: 1, tareWeight: 100 },
      { containerNumber: 22, position: 1, tareWeight: 100 },
    ];
    const bunkerConfig = [{ position: 1, ingredientId: "ing-1" }];

    const db = normFactDb({
      refills, returns, tare, bunkerConfig,
      ingredients: [ingredient],
      placements: [placement],
      orders: [], // ни одной чашки за весь период — по всем трём точкам
      entities: [loc, machine, coffeeCard],
      aliases: [],
    });
    const s = new NormFactService(db);
    const report = await s.report("2026-07-01", "2026-08-31");

    assert.equal(report.periods.length, 3);
    const a = report.periods.find((p) => p.to === "2026-07-10")!;
    assert.equal(a.чашек, 0);
    assert.equal(a.факт, 350);
    assert.equal(a.полнота, "нормы нет", "расход есть, продаж не видно вовсе — это пробел, а не подтверждённый ноль");
    assert.equal(a.норма, null);
    assert.equal(a.разница, null);

    const b = report.periods.find((p) => p.to === "2026-08-05")!;
    assert.equal(b.чашек, 0);
    assert.equal(b.факт, 10);
    assert.equal(b.полнота, "полный", "факт в пределах шума весов (10г) — обе стороны честно нулевые");
    assert.equal(b.норма, 0);
    assert.equal(b.разница, 10);

    const c = report.periods.find((p) => p.to === "2026-08-15")!;
    assert.equal(c.чашек, 0);
    assert.equal(c.факт, 11);
    assert.equal(c.полнота, "нормы нет", "на 1г за порогом шума — уже не «честный ноль»");
    assert.equal(c.норма, null);
    assert.equal(c.разница, null);
  });
});
