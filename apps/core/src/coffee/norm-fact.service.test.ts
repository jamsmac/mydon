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
      // Сценарий 1: даты 01..09 + повтор 01 (i=0 и i=9 оба дают "01"). "01" —
      // день заливки этого же периода (p.from) — полуоткрытый интервал
      // (from, to] (ревью 1.3) обязан его ИСКЛЮЧИТЬ, иначе он задвоился бы с
      // предыдущим периодом на той же точке. Итог по норме считается ниже
      // от 9 чашек (02..09 + одна из двух "01" вычеркнута), а не от 10.
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
    // 10 «плановых» дат (01..09 + повторная "01") минус 1 чашка "01" — день
    // заливки ЭТОГО периода, полуоткрытый интервал (from, to] его исключает
    // (ревью 1.3) — плюс 1 выданная-но-неучтённая-в-выручке (delivered:true,
    // countable:false — та же строка, что считается в расхождении R-F5 ниже):
    // сырьё списывается по orderIsDelivered, поэтому она тоже входит в норму.
    // Итого 10 - 1 + 1 = 9 чашек, ни одна без нормы (все — «Капучино»).
    assert.equal(p1.чашек, 9);
    assert.equal(p1.чашекБезНормы, 0);
    assert.equal(p1.норма, 180);
    assert.equal(p1.разница, 170);

    const p2 = report.periods.find((p) => p.to === "2026-02-05")!;
    assert.equal(p2.полнота, "тара не откалибрована");
    assert.equal(p2.разница, null);

    const p3 = report.periods.find((p) => p.to === "2026-03-05")!;
    assert.equal(p3.полнота, "позиция неоднозначна");
    assert.equal(p3.ingredientId, null);
    assert.equal(p3.разница, null);

    const p4 = report.periods.find((p) => p.to === "2026-04-05")!;
    assert.equal(p4.полнота, "нет тары");
    assert.equal(p4.разница, null);

    const p5 = report.periods.find((p) => p.to === "2026-05-10")!;
    assert.equal(p5.полнота, "нормы нет");
    assert.equal(p5.норма, null);
    assert.equal(p5.разница, null);

    // Итог — ТОЛЬКО по «полному» периоду (R-F2): единственный вклад — p1.
    assert.deepEqual(report.итог, { факт: 350, норма: 180, разница: 170, периодов: 1 });

    // внеИтога — 4 периода, разбивка по причине без потерь (4 = 1+1+1+1).
    assert.equal(report.внеИтога.периодов, 4);
    const причины = new Map(report.внеИтога.причины.map((c) => [c.причина, c.периодов]));
    assert.equal(причины.get("тара не откалибрована"), 1);
    assert.equal(причины.get("позиция неоднозначна"), 1);
    assert.equal(причины.get("нет тары"), 1);
    assert.equal(причины.get("нормы нет"), 1);

    // Ревью 1.4: в этой фикстуре у каждой заливки есть ровно один возврат —
    // непарных нет (отдельная фикстура ниже проверяет обратное).
    assert.equal(report.внеИтога.непарныхЗаливок, 0);
    assert.equal(report.внеИтога.непарныхВозвратов, 0);

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

  it("ревью 1.1: чашка без опознанного товара или без разобранного состава не даёт норму 0 — период уходит в «рецепт неизвестен»", async () => {
    // ДО фикса: обе неопознанные чашки добавляли к норме 0 и молча
    // протаскивали период в «полный» с заниженной нормой (220 нормы вместо
    // фактических ожиданий) — ровно тот подлог, от которого защищает срез.
    const cardNoRecipe = { id: "card-no-recipe", type: "product", name: "Латте без рецепта", attrs: {} };
    const refills = [{ position: 1, containerNumber: 100, enteredDate: "2026-09-01", filledWeight: 600, locationId: "loc-1", ingredientId: null }];
    const returns = [{ position: 1, containerNumber: 100, weight: 100, returnedDate: "2026-09-15" }];
    const tare = [{ containerNumber: 100, position: 1, tareWeight: 100 }];
    const bunkerConfig = [{ position: 1, ingredientId: "ing-1" }];
    const orders = [
      order("2026-09-05"), // «Капучино» — известный рецепт, вносит 20г
      order("2026-09-06", { goodsName: "Марсианский эспрессо" }), // товар не опознан ни картой, ни алиасом
      order("2026-09-07", { goodsName: "Латте без рецепта" }), // товар опознан, но у карточки нет «состава»
    ];

    const db = normFactDb({
      refills, returns, tare, bunkerConfig,
      ingredients: [ingredient],
      placements: [placement],
      orders,
      entities: [loc, machine, coffeeCard, cardNoRecipe],
      aliases: [],
    });
    const s = new NormFactService(db);
    const report = await s.report("2026-09-01", "2026-09-15");

    assert.equal(report.periods.length, 1);
    const p = report.periods[0]!;
    assert.equal(p.чашек, 3);
    assert.equal(p.чашекБезНормы, 2, "2 из 3 чашек не дали вклада в норму");
    assert.equal(p.норма, 20, "норма — сырое диагностическое число (вклад только известной чашки), не итог для сверки");
    assert.equal(p.полнота, "рецепт неизвестен", "не «полный» с заниженной нормой");
    assert.equal(p.разница, null);
  });

  it("ревью 1.2: единица состава, отличная от «г», не конвертируется молча в граммы", async () => {
    // Состав хранит 0.02 «кг» (= 20г). Молчаливая трактовка qty как граммов
    // (баг ДО фикса) дала бы норму 0.02г — почти весь факт превратился бы в
    // перерасход. После фикса чашка с чужой единицей не даёт вклада вовсе.
    const cardKg = { id: "card-kg", type: "product", name: "Латте в кг", attrs: { "состав": JSON.stringify([{ ingredientId: "ing-entity-coffee", quantity: 0.02, unit: "кг" }]) } };
    const refills = [{ position: 1, containerNumber: 101, enteredDate: "2026-10-01", filledWeight: 600, locationId: "loc-1", ingredientId: null }];
    const returns = [{ position: 1, containerNumber: 101, weight: 100, returnedDate: "2026-10-15" }];
    const tare = [{ containerNumber: 101, position: 1, tareWeight: 100 }];
    const bunkerConfig = [{ position: 1, ingredientId: "ing-1" }];
    const orders = [order("2026-10-05", { goodsName: "Латте в кг" })];

    const db = normFactDb({
      refills, returns, tare, bunkerConfig,
      ingredients: [ingredient],
      placements: [placement],
      orders,
      entities: [loc, machine, cardKg],
      aliases: [],
    });
    const s = new NormFactService(db);
    const report = await s.report("2026-10-01", "2026-10-15");

    assert.equal(report.periods.length, 1);
    const p = report.periods[0]!;
    assert.equal(p.чашек, 1);
    assert.equal(p.чашекБезНормы, 1);
    assert.equal(p.норма, 0, "единица «кг» не пересчитана в граммы молча — вклада нет вовсе, а не 0.02");
    assert.equal(p.полнота, "рецепт неизвестен");
    assert.equal(p.разница, null);
  });

  it("ревью 1.3: день визита (возврат одного набора = заливка следующего) не задваивается между периодами", async () => {
    // Смена бункеров в один визит: набор 200 возвращают и в тот же день
    // 2026-11-10 заливают набор 201. Полуоткрытый интервал (from, to]
    // обязан отдать чашку этого дня ТОЛЬКО закрывающемуся периоду (200).
    const refills = [
      { position: 1, containerNumber: 200, enteredDate: "2026-11-01", filledWeight: 600, locationId: "loc-1", ingredientId: null },
      { position: 1, containerNumber: 201, enteredDate: "2026-11-10", filledWeight: 600, locationId: "loc-1", ingredientId: null },
    ];
    const returns = [
      { position: 1, containerNumber: 200, weight: 100, returnedDate: "2026-11-10" },
      { position: 1, containerNumber: 201, weight: 200, returnedDate: "2026-11-20" },
    ];
    const tare = [
      { containerNumber: 200, position: 1, tareWeight: 100 },
      { containerNumber: 201, position: 1, tareWeight: 100 },
    ];
    const bunkerConfig = [{ position: 1, ingredientId: "ing-1" }];
    // Одна-единственная чашка — ровно в день визита.
    const orders = [order("2026-11-10")];

    const db = normFactDb({
      refills, returns, tare, bunkerConfig,
      ingredients: [ingredient],
      placements: [placement],
      orders,
      entities: [loc, machine, coffeeCard],
      aliases: [],
    });
    const s = new NormFactService(db);
    const report = await s.report("2026-11-01", "2026-11-20");

    const periodX = report.periods.find((p) => p.to === "2026-11-10")!; // закрывающийся (набор 200)
    const periodY = report.periods.find((p) => p.to === "2026-11-20")!; // следующий (набор 201)
    assert.equal(periodX.чашек, 1, "день возврата (to) — периоду принадлежит");
    assert.equal(periodY.чашек, 0, "тот же день как start (from) следующего периода — исключён, не задвоен");
    assert.equal(periodX.чашек + periodY.чашек, 1, "чашка учтена ровно один раз на всю историю, а не дважды");
  });

  it("ревью 1.4: непарные заливки и возвраты видны числом, а не пропадают", async () => {
    // 300↔300 — нормальная пара. 301 залит, но никогда не возвращён (нет
    // строки возврата вовсе). 302 возвращён, но заливки для него в журнале
    // нет вовсе (например, начало истории). Обе ситуации раньше не были
    // видны нигде — ни строкой, ни счётчиком.
    const refills = [
      { position: 1, containerNumber: 300, enteredDate: "2026-12-01", filledWeight: 600, locationId: "loc-1", ingredientId: null },
      { position: 1, containerNumber: 301, enteredDate: "2026-12-01", filledWeight: 400, locationId: "loc-1", ingredientId: null },
    ];
    const returns = [
      { position: 1, containerNumber: 300, weight: 200, returnedDate: "2026-12-10" },
      { position: 1, containerNumber: 302, weight: 300, returnedDate: "2026-12-05" },
    ];
    const tare = [{ containerNumber: 300, position: 1, tareWeight: 100 }];
    const bunkerConfig = [{ position: 1, ingredientId: "ing-1" }];

    const db = normFactDb({
      refills, returns, tare, bunkerConfig,
      ingredients: [ingredient],
      placements: [placement],
      orders: [],
      entities: [loc, machine],
      aliases: [],
    });
    const s = new NormFactService(db);
    const report = await s.report("2026-12-01", "2026-12-31");

    // Только пара 300↔300 строит период — 301 и 302 без пары не участвуют.
    assert.equal(report.periods.length, 1);
    assert.equal(report.внеИтога.непарныхЗаливок, 1, "заливка 301 без возврата — видна числом");
    assert.equal(report.внеИтога.непарныхВозвратов, 1, "возврат 302 без заливки — виден числом");
  });
  /**
   * Ревью, блокер Б1. Замена бункера за один визит — штатный процесс: снятый
   * набор возвращают и в тот же день ставят заправленный. `enteredDate` и
   * `returnedDate` — календарные даты без времени, поэтому у возврата и у
   * СЛЕДУЮЩЕЙ заливки одна и та же дата, и ничья тут структурная, а не
   * случайная (на живых данных 108 пар из 885 имели нулевую длину).
   *
   * Отбор «последняя заливка с датой <= даты возврата» брал в этой ничьей
   * ЗАЛИВКУ ТОГО ЖЕ ДНЯ. Получался период [день, день] с абсурдным расходом
   * (нетто свежего набора минус нетто отработанного), а настоящая заливка при
   * этом помечалась потреблённой заодно — её период не строился вовсе, и
   * следующему возврату уже не с чем было спариться. Один визит рушил две
   * пары и подставлял третью, фантомную.
   */
  it("замена набора в один визит: возврат закрывает прежнюю заливку, а не сегодняшнюю", async () => {
    const refills = [
      { position: 1, containerNumber: 1, enteredDate: "2026-01-01", filledWeight: 700, locationId: "loc-1", ingredientId: null },
      // Тот же день, что и первый возврат: оператор снял отработанный набор и поставил заправленный.
      { position: 1, containerNumber: 1, enteredDate: "2026-01-15", filledWeight: 700, locationId: "loc-1", ingredientId: null },
    ];
    const returns = [
      { position: 1, containerNumber: 1, weight: 200, returnedDate: "2026-01-15" },
      { position: 1, containerNumber: 1, weight: 250, returnedDate: "2026-01-25" },
    ];
    const tare = [{ containerNumber: 1, position: 1, tareWeight: 100 }];
    const bunkerConfig = [{ position: 1, ingredientId: "ing-1" }];

    const db = normFactDb({
      refills, returns, tare, bunkerConfig,
      ingredients: [ingredient],
      placements: [placement],
      orders: [],
      entities: [loc, machine],
      aliases: [],
    });
    const s = new NormFactService(db);
    const report = await s.report("2026-01-01", "2026-01-31");

    assert.equal(report.periods.length, 2, "две заливки и два возврата дают ДВА периода, а не один");
    assert.equal(report.внеИтога.непарныхЗаливок, 0);
    assert.equal(report.внеИтога.непарныхВозвратов, 0);

    const первый = report.periods.find((p) => p.to === "2026-01-15")!;
    assert.equal(первый.from, "2026-01-01", "возврат 15-го закрывает заливку 1-го, а не заливку 15-го");
    assert.equal(первый.факт, 500, "(700-100) - (200-100)");

    const второй = report.periods.find((p) => p.to === "2026-01-25")!;
    assert.equal(второй.from, "2026-01-15", "заливка 15-го осталась свободной и закрылась возвратом 25-го");
    assert.equal(второй.факт, 450, "(700-100) - (250-100)");

    assert.ok(
      !report.periods.some((p) => p.from === p.to),
      "периода нулевой длины быть не должно — это и есть фантом, который ловит блокер",
    );
  });
  /**
   * Ревью, блокер Б2. Условие R-F2 «размещение автомата есть» не проверялось
   * НИ ОДНОЙ строкой. Чашка автомата, у которого на её дату нет покрывающего
   * `machine_placement`, молча выбрасывалась при сборке `cupsByLocation` — она
   * не попадала ни в `чашек`, ни в `чашекБезНормы`, то есть исчезала бесследно.
   *
   * Полностью непокрытый период это ещё переживал: чашек выходило 0, и ветка
   * «нормы нет» его ловила. Опасен ЧАСТИЧНО покрытый: половина чашек интервала
   * выпадает, норма считается по оставшимся — заниженная, но НЕ `null`, —
   * и период получает «полный» с разницей, которой нет. Ровно ложное обвинение
   * в перерасходе, от которого защищает весь срез.
   *
   * Вход штатный, а не выдуманный: `linkMachine()` ставит `startDate` = день
   * привязки, поэтому у каждого аппарата вся история ДО привязки остаётся
   * непокрытой (на проде так и случилось с Parus F4, привязанной 05.08.2026).
   */
  it("период, чей интервал шире размещения автомата, не может быть «полным»", async () => {
    const refills = [
      { position: 1, containerNumber: 1, enteredDate: "2026-01-01", filledWeight: 700, locationId: "loc-1", ingredientId: null },
    ];
    const returns = [{ position: 1, containerNumber: 1, weight: 200, returnedDate: "2026-01-20" }];
    const tare = [{ containerNumber: 1, position: 1, tareWeight: 100 }];
    const bunkerConfig = [{ position: 1, ingredientId: "ing-1" }];
    // Автомат привязан к точке только с 10-го — первые девять дней интервала
    // бункера продажами не покрыты вовсе.
    const позднееРазмещение = { entityId: "machine-1", locationId: "loc-1", startDate: "2026-01-10", endDate: null };
    const orders = Array.from({ length: 19 }, (_, i) => order(`2026-01-${String(i + 2).padStart(2, "0")}`));

    const db = normFactDb({
      refills, returns, tare, bunkerConfig,
      ingredients: [ingredient],
      placements: [позднееРазмещение],
      orders,
      entities: [loc, machine, coffeeCard],
      aliases: [],
    });
    const s = new NormFactService(db);
    const report = await s.report("2026-01-01", "2026-01-31");

    assert.equal(report.periods.length, 1);
    const период = report.periods[0]!;
    assert.equal(
      период.полнота,
      "размещение неполно",
      "часть интервала без размещения — норма заведомо занижена, вердикта быть не может",
    );
    assert.equal(период.разница, null, "разницы нет там, где половина чашек интервала невидима");
    assert.equal(report.итог.периодов, 0, "в итог такой период не идёт");
    assert.ok(
      report.внеИтога.причины.some((c) => c.причина === "размещение неполно" && c.периодов === 1),
      "причина обязана быть названа отдельной строкой, а не растворяться",
    );
  });

  it("размещение покрывает интервал целиком — период считается как обычно", async () => {
    const refills = [
      { position: 1, containerNumber: 1, enteredDate: "2026-01-01", filledWeight: 700, locationId: "loc-1", ingredientId: null },
    ];
    const returns = [{ position: 1, containerNumber: 1, weight: 200, returnedDate: "2026-01-20" }];
    const tare = [{ containerNumber: 1, position: 1, tareWeight: 100 }];
    const bunkerConfig = [{ position: 1, ingredientId: "ing-1" }];
    const orders = Array.from({ length: 19 }, (_, i) => order(`2026-01-${String(i + 2).padStart(2, "0")}`));

    const db = normFactDb({
      refills, returns, tare, bunkerConfig,
      ingredients: [ingredient],
      placements: [placement], // с 2025-12-01, бессрочно — интервал покрыт
      orders,
      entities: [loc, machine, coffeeCard],
      aliases: [],
    });
    const s = new NormFactService(db);
    const report = await s.report("2026-01-01", "2026-01-31");

    const период = report.periods[0]!;
    assert.equal(период.полнота, "полный");
    assert.equal(период.чашек, 19);
    assert.equal(период.норма, 380); // 19 чашек × 20 г
    assert.equal(период.факт, 500); // (700-100) - (200-100)
    assert.equal(период.разница, 120);
  });
});
