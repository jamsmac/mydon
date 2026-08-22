import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  coffeeBunkerConfig as coffeeBunkerConfigTable,
  coffeeContainerTare as coffeeContainerTareTable,
  coffeeIngredient as coffeeIngredientTable,
  coffeeRefill as coffeeRefillTable,
  collection as collectionTable,
  machinePlacement as machinePlacementTable,
  moneyFlow as moneyFlowTable,
  purchase as purchaseTable,
  rawReportDef as rawReportDefTable,
  sale as saleTable,
  stockBatch as stockBatchTable,
  stockMovement as stockMovementTable,
} from "@mydon/db";
import type { CollectionsService, ИнтервалСверки, РезультатСверки, РезультатСверкиСтрока } from "../collections/collections.service";
import type { FinanceService } from "../finance/finance.service";
import type { CashReconcileReport } from "../finance/finance.math";
import {
  bankDepositsWithoutCollectionGaps,
  bankFlowsWithoutDomainGap,
  batchesWithoutExpiryGap,
  batchesWithoutInvoiceDateGap,
  billReconciliationGap,
  bunkerTareNetNonPositiveGap,
  collectionSilenceGap,
  GapsService,
  healthTimezoneGap,
  ingredientsWithoutPackageWeightGap,
  ingredientsWithoutPriceGap,
  ingredientsWithoutPurchaseGap,
  journalHoleGaps,
  locationsWithoutMachinePlacementGap,
  neverCollectedRevenueGaps,
  purchasesWithoutDateGap,
  recipeCardsWithoutCompositionGap,
  refillMeasuredBeforeMissingGap,
  refillsWithoutIngredientGap,
  snackPaymentChannelGap,
  stockIntakeSilenceGap,
  targetFillWeightMissingGap,
  telegramImportStalledGap,
  unconfiguredBunkerPositionGap,
} from "./gaps.service";

type Row = Record<string, unknown>;

const TODAY = "2026-08-22";

/* ── Детектор 1: инкассации — тишина ─────────────────────────────────────── */

describe("Реестр пробелов — инкассации: тишина", () => {
  it("нет ни одной инкассации вовсе — честный пробел", () => {
    const gaps = collectionSilenceGap([], TODAY);
    assert.equal(gaps.length, 1);
    assert.match(gaps[0].missing, /нет ни одной/);
    assert.equal(gaps[0].scale, null);
  });

  it("59 дней тишины (проверено на проде 22.08.2026) — гэп с датой и числом дней", () => {
    const gaps = collectionSilenceGap(["2026-06-24T10:00:00+05:00"], TODAY);
    assert.equal(gaps.length, 1);
    assert.equal(gaps[0].topic, "инкассации: тишина");
    assert.match(gaps[0].missing, /2026-06-24/);
    assert.match(gaps[0].missing, /59 дней/);
    assert.deepEqual(gaps[0].period, { from: "2026-06-24", to: TODAY });
  });

  it("КЛЮЧЕВОЙ ТЕСТ: пробел исчезает, когда данные появились", () => {
    // Было тихо 59 дней — гэп есть.
    const было = collectionSilenceGap(["2026-06-24T10:00:00+05:00"], TODAY);
    assert.equal(было.length, 1);

    // Появилась свежая инкассация (вчера) — тот же детектор, без единой правки кода, гэпа больше нет.
    const стало = collectionSilenceGap(["2026-06-24T10:00:00+05:00", "2026-08-21T09:00:00+05:00"], TODAY);
    assert.deepEqual(стало, []);
  });

  it("тишина в пределах порога (≤14 дней) — не гэп", () => {
    const gaps = collectionSilenceGap(["2026-08-10T10:00:00+05:00"], TODAY);
    assert.deepEqual(gaps, []);
  });
});

/* ── Детектор 2: касса — банк без инкассации ──────────────────────────────── */

describe("Реестр пробелов — касса: банк показал взнос без инкассации", () => {
  const base: CashReconcileReport["periods"][number] = {
    period: "2026-07",
    withdrawn: 0,
    withdrawnCount: 0,
    withdrawnPending: 0,
    deposited: 5_000_000,
    depositedCount: 2,
    diff: 5_000_000,
    status: "noWithdrawn",
  };

  it("статус noWithdrawn — гэп с границами месяца и суммой взноса", () => {
    const gaps = bankDepositsWithoutCollectionGaps([base]);
    assert.equal(gaps.length, 1);
    assert.deepEqual(gaps[0].period, { from: "2026-07-01", to: "2026-07-31" });
    assert.match(gaps[0].missing, /5 000 000/);
    assert.match(gaps[0].scale ?? "", /5 000 000/);
  });

  it("статус ok/empty/noDeposit — не гэп этого детектора", () => {
    assert.deepEqual(bankDepositsWithoutCollectionGaps([{ ...base, status: "ok" }]), []);
    assert.deepEqual(bankDepositsWithoutCollectionGaps([{ ...base, status: "empty" }]), []);
    assert.deepEqual(bankDepositsWithoutCollectionGaps([{ ...base, status: "noDeposit" }]), []);
  });

  it("КЛЮЧЕВОЙ ТЕСТ: инкассация внесена — период стал ok — гэп исчезает", () => {
    const было = bankDepositsWithoutCollectionGaps([base]);
    assert.equal(было.length, 1);
    const стало = bankDepositsWithoutCollectionGaps([{ ...base, status: "ok", withdrawn: 4_800_000, withdrawnCount: 3 }]);
    assert.deepEqual(стало, []);
  });
});

/* ── Детектор 3: дыра в журнале инкассаций ────────────────────────────────── */

function interval(over: Partial<ИнтервалСверки>): ИнтервалСверки {
  return {
    id: "iv",
    machineId: "m1",
    имя: null,
    с: "2026-01-01T00:00:00.000Z",
    по: "2026-01-10T00:00:00.000Z",
    дней: 9,
    ожидалось: 0,
    изъято: 0,
    разница: 0,
    доля: null,
    статус: "обычный",
    ...over,
  };
}

describe("Реестр пробелов — дыра в журнале инкассаций", () => {
  it("нет интервалов со статусом «пробел в журнале» — пусто", () => {
    assert.deepEqual(journalHoleGaps([interval({ статус: "обычный" })]), []);
  });

  it("пересекающиеся окна разных автоматов схлопываются в один факт (форма прода: ~186 млн против ~14,8 млн)", () => {
    const holes: ИнтервалСверки[] = [
      interval({ machineId: "m1", с: "2025-07-30T00:00:00.000Z", по: "2025-12-01T00:00:00.000Z", статус: "пробел в журнале", ожидалось: 90_000_000, изъято: 7_000_000 }),
      interval({ machineId: "m2", с: "2025-09-01T00:00:00.000Z", по: "2026-01-30T00:00:00.000Z", статус: "пробел в журнале", ожидалось: 96_000_000, изъято: 7_800_000 }),
    ];
    const gaps = journalHoleGaps(holes);
    assert.equal(gaps.length, 1, "два пересекающихся окна — один факт, а не два");
    assert.equal(gaps[0].topic, "инкассации: дыра в журнале");
    assert.deepEqual(gaps[0].period, { from: "2025-07-30", to: "2026-01-30" });
    assert.match(gaps[0].missing, /2 автомат/);
    assert.match(gaps[0].missing, /186 000 000/);
    assert.match(gaps[0].missing, /14 800 000/);
  });

  it("непересекающиеся окна — раздельные факты", () => {
    const holes: ИнтервалСверки[] = [
      interval({ machineId: "m1", с: "2024-01-01T00:00:00.000Z", по: "2024-02-01T00:00:00.000Z", статус: "пробел в журнале" }),
      interval({ machineId: "m2", с: "2026-01-01T00:00:00.000Z", по: "2026-02-01T00:00:00.000Z", статус: "пробел в журнале" }),
    ];
    assert.equal(journalHoleGaps(holes).length, 2);
  });

  it("КЛЮЧЕВОЙ ТЕСТ: выгрузка из VendCash закрывает дыру — статус меняется на «обычный», гэп исчезает", () => {
    const было = journalHoleGaps([interval({ статус: "пробел в журнале" })]);
    assert.equal(было.length, 1);
    const стало = journalHoleGaps([interval({ статус: "обычный" })]);
    assert.deepEqual(стало, []);
  });
});

/* ── Детектор 4: выручка есть, инкассаций нет вовсе ──────────────────────── */

function row(over: Partial<РезультатСверкиСтрока>): РезультатСверкиСтрока {
  return {
    machineId: "snack1",
    имя: "American Hospital · snack",
    выручка: 0,
    изъято: 0,
    разница: 0,
    доля: null,
    инкассаций: 0,
    медианныйИнтервалДней: null,
    медианныйЛагДней: null,
    статус: "обычный",
    ...over,
  };
}

describe("Реестр пробелов — снек: выручка есть, инкассаций нет вовсе", () => {
  it("статус «инкассаций нет вовсе» — гэп с именем и суммой", () => {
    const gaps = neverCollectedRevenueGaps([row({ выручка: 5_258_000, статус: "инкассаций нет вовсе" })]);
    assert.equal(gaps.length, 1);
    assert.match(gaps[0].missing, /American Hospital/);
    assert.match(gaps[0].missing, /5 258 000/);
  });

  it("«обычный» и «выручки нет» — не этот гэп", () => {
    assert.deepEqual(neverCollectedRevenueGaps([row({ статус: "обычный" }), row({ статус: "выручки нет" })]), []);
  });

  it("КЛЮЧЕВОЙ ТЕСТ: инкассацию завели — статус стал «обычный», гэп исчезает", () => {
    const было = neverCollectedRevenueGaps([row({ выручка: 12_000, статус: "инкассаций нет вовсе" })]);
    assert.equal(было.length, 1);
    const стало = neverCollectedRevenueGaps([row({ выручка: 12_000, изъято: 11_000, инкассаций: 1, статус: "обычный" })]);
    assert.deepEqual(стало, []);
  });
});

/* ── Детектор 5: заливки без ингредиента ─────────────────────────────────── */

describe("Реестр пробелов — заливки без ингредиента", () => {
  it("66 заливок, 62,1 кг (проверено на проде) — гэп с суммарным весом", () => {
    const refills = Array.from({ length: 66 }, (_, i) => ({
      ingredientId: null,
      filledWeight: i === 0 ? 62_100 - 65 * 941 : 941, // суммарно даёт 62 100 г = 62,1 кг
      enteredDate: "2026-05-01",
    }));
    const gaps = refillsWithoutIngredientGap(refills);
    assert.equal(gaps.length, 1);
    assert.match(gaps[0].missing, /66 заливок/);
    assert.match(gaps[0].missing, /62,1 кг/);
  });

  it("у всех заливок есть ингредиент — пусто", () => {
    assert.deepEqual(
      refillsWithoutIngredientGap([{ ingredientId: "ing-1", filledWeight: 500, enteredDate: "2026-05-01" }]),
      [],
    );
  });

  it("КЛЮЧЕВОЙ ТЕСТ: ингредиент дописали в заливку — гэп исчезает", () => {
    const было = refillsWithoutIngredientGap([{ ingredientId: null, filledWeight: 500, enteredDate: "2026-05-01" }]);
    assert.equal(было.length, 1);
    const стало = refillsWithoutIngredientGap([{ ingredientId: "ing-1", filledWeight: 500, enteredDate: "2026-05-01" }]);
    assert.deepEqual(стало, []);
  });
});

/* ── Детекторы 6–7: партии ────────────────────────────────────────────────── */

describe("Реестр пробелов — партии: сроки годности и дата счёта", () => {
  it("35 из 35 без срока годности (проверено на проде) — механизм работает, данных нет", () => {
    const batches = Array.from({ length: 35 }, (_, i) => ({
      receivedOn: `2026-0${(i % 6) + 1}-01`,
      expiryDate: null,
      manufactureDate: null,
      invoiceDate: i < 2 ? null : "2026-01-01",
    }));
    const expiry = batchesWithoutExpiryGap(batches);
    assert.equal(expiry.length, 1);
    assert.match(expiry[0].missing, /35 из 35/);

    const invoice = batchesWithoutInvoiceDateGap(batches);
    assert.equal(invoice.length, 1);
    assert.match(invoice[0].missing, /2 из 35/);
  });

  it("хотя бы одна из дат партии есть — не пробел срока годности", () => {
    assert.deepEqual(
      batchesWithoutExpiryGap([{ receivedOn: "2026-01-01", expiryDate: "2027-01-01", manufactureDate: null }]),
      [],
    );
    assert.deepEqual(
      batchesWithoutExpiryGap([{ receivedOn: "2026-01-01", expiryDate: null, manufactureDate: "2026-01-01" }]),
      [],
    );
  });

  it("КЛЮЧЕВОЙ ТЕСТ: партии проставили срок годности — гэп исчезает", () => {
    const было = batchesWithoutExpiryGap([{ receivedOn: "2026-01-01", expiryDate: null, manufactureDate: null }]);
    assert.equal(было.length, 1);
    const стало = batchesWithoutExpiryGap([{ receivedOn: "2026-01-01", expiryDate: "2027-01-01", manufactureDate: null }]);
    assert.deepEqual(стало, []);
  });
});

/* ── Детектор 8: закупки без даты ─────────────────────────────────────────── */

describe("Реестр пробелов — закупки без даты прихода", () => {
  it("0 из N (проверено на проде — dt notNull) — пусто", () => {
    assert.deepEqual(purchasesWithoutDateGap([{ dt: "2026-01-01" }, { dt: "2026-02-01" }]), []);
  });

  it("строка без даты — гэп", () => {
    const gaps = purchasesWithoutDateGap([{ dt: "2026-01-01" }, { dt: null }]);
    assert.equal(gaps.length, 1);
    assert.match(gaps[0].missing, /1 из 2/);
  });
});

/* ── Детектор 9: ингредиенты без цены (ЛОВУШКА purchase_price) ───────────── */

describe("Реестр пробелов — ингредиенты без цены", () => {
  it("ЛОВУШКА: purchase_price пуст у всех 8, но цена в карточке есть — НЕ гэп (иначе 8 ложных пробелов)", () => {
    const ingredients = [
      { id: "1", name: "Кофе", purchasePrice: null, cardAttrs: { "цена покупки": 260000, "единица": "кг" } },
      { id: "2", name: "Матча", purchasePrice: null, cardAttrs: { "цена покупки": 582400, "единица": "кг" } },
      { id: "3", name: "MacCoffee", purchasePrice: null, cardAttrs: { "цена покупки": 80, "единица": "г" } },
      { id: "4", name: "Сахар", purchasePrice: null, cardAttrs: { "цена покупки": 13.495, "единица": "г" } },
      { id: "5", name: "Сухое молоко", purchasePrice: null, cardAttrs: { "цена покупки": 100000, "единица": "кг" } },
      { id: "6", name: "Шоколад", purchasePrice: null, cardAttrs: { "цена покупки": 182000, "единица": "кг" } },
      { id: "7", name: "Ягодный чай", purchasePrice: null, cardAttrs: { "цена покупки": 147000, "единица": "кг" } },
      { id: "8", name: "Лимонный чай", purchasePrice: null, cardAttrs: { "цена покупки": 147000, "единица": "кг" } },
    ];
    assert.deepEqual(ingredientsWithoutPriceGap(ingredients), [], "0 из 8 — прямое чтение purchase_price сломало бы это на 8 ложных пробелов");
  });

  it("ни карточки, ни реестра — настоящий гэп", () => {
    const gaps = ingredientsWithoutPriceGap([{ id: "1", name: "Стакан+крышка", purchasePrice: null, cardAttrs: null }]);
    assert.equal(gaps.length, 1);
    assert.match(gaps[0].missing, /Стакан\+крышка/);
  });

  it("КЛЮЧЕВОЙ ТЕСТ: цену вписали в карточку — гэп исчезает", () => {
    const было = ingredientsWithoutPriceGap([{ id: "1", name: "Новый ингредиент", purchasePrice: null, cardAttrs: null }]);
    assert.equal(было.length, 1);
    const стало = ingredientsWithoutPriceGap([
      { id: "1", name: "Новый ингредиент", purchasePrice: null, cardAttrs: { "цена покупки": 50000, "единица": "кг" } },
    ]);
    assert.deepEqual(стало, []);
  });
});

/* ── Детектор 10: вес упаковки (ЛОВУШКА «нужен не всем») ─────────────────── */

describe("Реестр пробелов — ингредиенты без веса упаковки", () => {
  it("ЛОВУШКА: 6 ингредиентов на вес (никогда не заливались пачками) — вес упаковки НЕ требуется", () => {
    const ingredients = [
      { id: "1", name: "Кофе", packageWeight: null, cardAttrs: {} },
      { id: "2", name: "Сахар", packageWeight: null, cardAttrs: {} },
      { id: "3", name: "Шоколад", packageWeight: null, cardAttrs: {} },
      { id: "4", name: "Сухое молоко", packageWeight: null, cardAttrs: {} },
      { id: "5", name: "Ягодный чай", packageWeight: null, cardAttrs: {} },
      { id: "6", name: "Лимонный чай", packageWeight: null, cardAttrs: {} },
    ];
    // Ни у одного нет заливки со счётом упаковок вовсе — считаются на вес.
    const refills = ingredients.map((i) => ({ ingredientId: i.id, packageCount: null }));
    assert.deepEqual(
      ingredientsWithoutPackageWeightGap(ingredients, refills),
      [],
      "требовать вес упаковки у весовых ингредиентов дало бы 6 ложных пробелов",
    );
  });

  it("ингредиент реально заливают пачками, а вес упаковки не указан — настоящий гэп", () => {
    const ingredients = [{ id: "mc", name: "MacCoffee", packageWeight: null, cardAttrs: {} }];
    const refills = [{ ingredientId: "mc", packageCount: 3 }];
    const gaps = ingredientsWithoutPackageWeightGap(ingredients, refills);
    assert.equal(gaps.length, 1);
    assert.match(gaps[0].missing, /MacCoffee/);
  });

  it("вес упаковки указан (в карточке или в реестре) — не гэп", () => {
    const refills = [{ ingredientId: "mc", packageCount: 3 }];
    assert.deepEqual(
      ingredientsWithoutPackageWeightGap([{ id: "mc", name: "MacCoffee", packageWeight: 20, cardAttrs: {} }], refills),
      [],
    );
    assert.deepEqual(
      ingredientsWithoutPackageWeightGap([{ id: "mc", name: "MacCoffee", packageWeight: null, cardAttrs: { "вес упаковки, г": 20 } }], refills),
      [],
    );
  });

  it("КЛЮЧЕВОЙ ТЕСТ: вес упаковки вписали — гэп исчезает", () => {
    const ingredients = [{ id: "mc", name: "MacCoffee", packageWeight: null as number | null, cardAttrs: {} as Record<string, unknown> }];
    const refills = [{ ingredientId: "mc", packageCount: 3 }];
    const было = ingredientsWithoutPackageWeightGap(ingredients, refills);
    assert.equal(было.length, 1);
    const стало = ingredientsWithoutPackageWeightGap([{ ...ingredients[0], packageWeight: 20 }], refills);
    assert.deepEqual(стало, []);
  });
});

/* ── Детектор 11: снек — канала оплаты нет ───────────────────────────────── */

describe("Реестр пробелов — снек: канала оплаты нет", () => {
  it("968 продаж (проверено на проде) — гэп-модель, число видно", () => {
    const gaps = snackPaymentChannelGap(968);
    assert.equal(gaps.length, 1);
    assert.match(gaps[0].missing, /968/);
    assert.match(gaps[0].action, /пробел модели/);
  });

  it("продаж снека нет вовсе — нечего мисклассифицировать, пусто", () => {
    assert.deepEqual(snackPaymentChannelGap(0), []);
  });
});

/* ── Детектор 12: сверка купюр — односторонняя ───────────────────────────── */

describe("Реестр пробелов — сверка купюр по автомату", () => {
  it("raw_report_def пуст для ourvend (проверено на проде) — гэп", () => {
    const gaps = billReconciliationGap([]);
    assert.equal(gaps.length, 1);
    assert.match(gaps[0].missing, /raw_report_def/);
  });

  it("КЛЮЧЕВОЙ ТЕСТ: появился отчёт о купюрах — гэп исчезает сам", () => {
    const было = billReconciliationGap([]);
    assert.equal(было.length, 1);
    const стало = billReconciliationGap([{ sourceCode: "ourvend", code: "banknotes", title: "Принятые купюры", ru: "Купюры" }]);
    assert.deepEqual(стало, []);
  });

  it("отчёты другого источника или не про купюры — гэп остаётся", () => {
    const gaps = billReconciliationGap([{ sourceCode: "ourvend", code: "order_query", title: "Order Query", ru: "Заказы" }]);
    assert.equal(gaps.length, 1);
  });
});

/* ── Детектор 13: банковские записи без направления ──────────────────────── */

describe("Реестр пробелов — банковские записи без направления", () => {
  it("записи с domain=null суммируются, отменённые и привязанные не считаются", () => {
    const gaps = bankFlowsWithoutDomainGap([
      { domain: null, direction: "in", source: "bank", amount: "1000000", currency: "UZS", amountUzs: null, status: "actual" },
      { domain: null, direction: "in", source: "bank", amount: "500000", currency: "UZS", amountUzs: null, status: "actual" },
      { domain: null, direction: "in", source: "bank", amount: "999999", currency: "UZS", amountUzs: null, status: "cancelled" },
      { domain: "vendhub", direction: "in", source: "bank", amount: "777", currency: "UZS", amountUzs: null, status: "actual" },
    ]);
    assert.equal(gaps.length, 1);
    assert.match(gaps[0].missing, /2 записей/);
    assert.match(gaps[0].missing, /1 500 000/);
  });

  it("все записи привязаны к направлению — пусто", () => {
    assert.deepEqual(
      bankFlowsWithoutDomainGap([
        { domain: "vendhub", direction: "in", source: "bank", amount: "1000", currency: "UZS", amountUzs: null, status: "actual" },
      ]),
      [],
    );
  });

  it("КЛЮЧЕВОЙ ТЕСТ: запись привязали к направлению — гэп исчезает", () => {
    const было = bankFlowsWithoutDomainGap([
      { domain: null, direction: "in", source: "bank", amount: "1000000", currency: "UZS", amountUzs: null, status: "actual" },
    ]);
    assert.equal(было.length, 1);
    const стало = bankFlowsWithoutDomainGap([
      { domain: "vendhub", direction: "in", source: "bank", amount: "1000000", currency: "UZS", amountUzs: null, status: "actual" },
    ]);
    assert.deepEqual(стало, []);
  });

  it("ФИКС 1.3: ручная запись (source='manual') с пустым domain — не пробел импорта выписки, счёт не идёт", () => {
    // Ручные записи без domain — обычное дело (владелец решает привязку
    // позже), а не симптом импорта. Раньше выборка шла по ВСЕЙ money_flow —
    // такая строка ложно попадала в «банковские записи без направления».
    assert.deepEqual(
      bankFlowsWithoutDomainGap([
        { domain: null, direction: "in", source: "manual", amount: "1000000", currency: "UZS", amountUzs: null, status: "actual" },
      ]),
      [],
    );
  });

  it("ФИКС 1.3: приход и расход считаются РАЗДЕЛЬНО — сумма не смешивает дебет с кредитом", () => {
    const gaps = bankFlowsWithoutDomainGap([
      { domain: null, direction: "in", source: "bank", amount: "1000000", currency: "UZS", amountUzs: null, status: "actual" },
      { domain: null, direction: "out", source: "bank", amount: "300000", currency: "UZS", amountUzs: null, status: "actual" },
    ]);
    assert.equal(gaps.length, 1);
    assert.match(gaps[0].missing, /приход 1 000 000/);
    assert.match(gaps[0].missing, /расход 300 000/);
    // Сальдо (700 000) — единственное число, которое честно называет "сколько
    // денег без направления"; голая сумма 1 300 000 не равна ни приходу, ни
    // расходу, ни сальдо (ровно баг из ревью 1.3).
    assert.match(gaps[0].scale ?? "", /700 000/);
  });
});

/* ── Детектор 14: здоровье — часовой пояс ─────────────────────────────────── */

describe("Реестр пробелов — здоровье: часовой пояс процесса", () => {
  it("пояс не совпадает с ожидаемым — гэп, /health при этом молчит про это в status", () => {
    const gaps = healthTimezoneGap("UTC", "Asia/Tashkent");
    assert.equal(gaps.length, 1);
    assert.match(gaps[0].missing, /UTC/);
    assert.match(gaps[0].missing, /status: "ok"/);
  });

  it("пояс совпадает — пусто", () => {
    assert.deepEqual(healthTimezoneGap("Asia/Tashkent", "Asia/Tashkent"), []);
  });
});

/* ── Детектор 15: заливки — замер «до досыпки» не делают ─────────────────── */

describe("Реестр пробелов — заливки: замер «до досыпки» не делают", () => {
  it("0 из 1153 (проверено на проде 22.08.2026) — гэп с числом", () => {
    const refills = Array.from({ length: 1153 }, () => ({ measuredBefore: null }));
    const gaps = refillMeasuredBeforeMissingGap(refills);
    assert.equal(gaps.length, 1);
    assert.match(gaps[0].missing, /1153 из 1153/);
  });

  it("заливок нет вовсе — нечего мерить, пусто", () => {
    assert.deepEqual(refillMeasuredBeforeMissingGap([]), []);
  });

  it("КЛЮЧЕВОЙ ТЕСТ: замер стали делать частично — число падает, у всех — гэп исчезает", () => {
    const было = refillMeasuredBeforeMissingGap([{ measuredBefore: null }, { measuredBefore: null }]);
    assert.equal(было.length, 1);
    assert.match(было[0].missing, /2 из 2/);

    const частично = refillMeasuredBeforeMissingGap([{ measuredBefore: 900 }, { measuredBefore: null }]);
    assert.equal(частично.length, 1);
    assert.match(частично[0].missing, /1 из 2/);

    const стало = refillMeasuredBeforeMissingGap([{ measuredBefore: 900 }, { measuredBefore: 850 }]);
    assert.deepEqual(стало, []);
  });
});

/* ── Детекторы 16–17: тара бункера — позиции 3 и 4 ────────────────────────── */

describe("Реестр пробелов — тара бункера: позиции 3 и 4 не откалиброваны", () => {
  const tare = new Map<string, number>([
    ["1:4", 500],
    ["1:3", 500],
  ]);

  it("позиция 4 (сахар): 42 из 90 заливок с известной тарой дают нетто ≤ 0 (проверено на проде — медиана 14 г)", () => {
    const positive = Array.from({ length: 48 }, () => ({ position: 4, containerNumber: 1, filledWeight: 520 })); // нетто +20
    const nonPositive = Array.from({ length: 42 }, () => ({ position: 4, containerNumber: 1, filledWeight: 500 })); // нетто 0
    const gaps = bunkerTareNetNonPositiveGap(4, [...positive, ...nonPositive], tare);
    assert.equal(gaps.length, 1);
    assert.equal(gaps[0].topic, "тара бункера: позиция 4 не откалибрована");
    assert.match(gaps[0].missing, /42 из 90/);
  });

  it("позиция 3 (лимонный чай/матча) — 13 из 58, СВОЕЙ строкой, а не спрятана за позицией 4", () => {
    const positive = Array.from({ length: 45 }, () => ({ position: 3, containerNumber: 1, filledWeight: 520 }));
    const nonPositive = Array.from({ length: 13 }, () => ({ position: 3, containerNumber: 1, filledWeight: 480 }));
    const gaps = bunkerTareNetNonPositiveGap(3, [...positive, ...nonPositive], tare);
    assert.equal(gaps.length, 1);
    assert.equal(gaps[0].topic, "тара бункера: позиция 3 не откалибрована");
    assert.match(gaps[0].missing, /13 из 58/);
  });

  it("заливки без известной тары не входят в знаменатель — это другой пробел", () => {
    const refills = [{ position: 4, containerNumber: 99, filledWeight: 100 }]; // тары для набора 99 нет
    assert.deepEqual(bunkerTareNetNonPositiveGap(4, refills, tare), []);
  });

  it("КЛЮЧЕВОЙ ТЕСТ: тару перекалибровали — нетто ушло в плюс, гэп исчезает", () => {
    const refills = [{ position: 4, containerNumber: 1, filledWeight: 500 }]; // нетто 0 при таре 500
    const было = bunkerTareNetNonPositiveGap(4, refills, tare);
    assert.equal(было.length, 1);
    const перекалибровано = new Map([["1:4", 400]]); // теперь нетто +100
    const стало = bunkerTareNetNonPositiveGap(4, refills, перекалибровано);
    assert.deepEqual(стало, []);
  });
});

/* ── Детектор 18: бункеры — позиция не сконфигурирована ───────────────────── */

describe("Реестр пробелов — бункеры: позиция не сконфигурирована", () => {
  it("позиция 8 встречается в заливках, конфигурации нет (проверено на проде) — гэп", () => {
    const used = [1, 2, 3, 4, 5, 6, 7, 8];
    const configured = new Set([1, 2, 3, 4, 5, 6, 7]);
    const gaps = unconfiguredBunkerPositionGap(used, configured);
    assert.equal(gaps.length, 1);
    assert.match(gaps[0].missing, /позиция 8/);
  });

  it("все использованные позиции сконфигурированы — пусто", () => {
    assert.deepEqual(unconfiguredBunkerPositionGap([1, 2, 3], new Set([1, 2, 3, 4])), []);
  });

  it("КЛЮЧЕВОЙ ТЕСТ: конфигурацию для позиции 8 добавили — гэп исчезает", () => {
    const было = unconfiguredBunkerPositionGap([8], new Set());
    assert.equal(было.length, 1);
    const стало = unconfiguredBunkerPositionGap([8], new Set([8]));
    assert.deepEqual(стало, []);
  });
});

/* ── Детектор 19: бункеры — недолив не проверяется ────────────────────────── */

describe("Реестр пробелов — бункеры: недолив не проверяется (target_fill_weight)", () => {
  it("считает СТРОКИ конфигурации, а не позиции: у позиции 3 два ингредиента — два эталона", () => {
    // Прод 22.08.2026: 8 строк конфигурации на 7 позициях (позиция 3 — лимонный
    // чай и матча). Потребитель ключуется парой `позиция:ингредиент`, поэтому
    // знаменатель — строки. Счёт по различным позициям дал бы 7 и спрятал матчу.
    const configs = [1, 2, 3, 3, 4, 5, 6, 7].map((position) => ({ position, targetFillWeight: null }));
    const gaps = targetFillWeightMissingGap(configs);
    assert.equal(gaps.length, 1);
    assert.match(gaps[0].missing, /8 из 8/);
    assert.match(gaps[0].missing, /не ловится ни на одной/);
  });

  it("часть бункеров получила цель — число падает, гэп не пропадает", () => {
    const gaps = targetFillWeightMissingGap([
      { position: 1, targetFillWeight: 500 },
      { position: 2, targetFillWeight: null },
    ]);
    assert.equal(gaps.length, 1);
    assert.match(gaps[0].missing, /1 из 2/);
    assert.doesNotMatch(gaps[0].missing, /ни на одной/, "часть бункеров уже проверяется — хвост неуместен");
  });

  it("КЛЮЧЕВОЙ ТЕСТ: все настроенные бункеры получили цель — гэп ИСЧЕЗАЕТ (R-K4)", () => {
    // Прежний знаменатель был константой 8 («столько разрешает схема»), а
    // настроено семь позиций — `8 − 7 = 1` оставался навсегда, и пробел не
    // закрылся бы никогда, сколько бы владелец ни заполнял. Это и чинит ревью.
    const configs = [1, 2, 3, 3, 4, 5, 6, 7].map((position) => ({ position, targetFillWeight: null }));
    assert.equal(targetFillWeightMissingGap(configs).length, 1);
    const заполнено = configs.map((c) => ({ ...c, targetFillWeight: 500 }));
    assert.deepEqual(targetFillWeightMissingGap(заполнено), [], "заполнили — пробел обязан исчезнуть сам");
  });

  it("конфигурации нет вовсе — пробел остаётся, но без выдуманного знаменателя", () => {
    const gaps = targetFillWeightMissingGap([]);
    assert.equal(gaps.length, 1, "недолив не ловится нигде — молчать об этом нельзя");
    assert.equal(gaps[0].scale, null, "знаменателя не существует — выдумывать его из схемы и значило бы держать незакрываемый пробел");
    assert.match(gaps[0].missing, /не сконфигурированы/);
  });
});

/* ── Детектор 20: заливки — телеграм-импорт архива застыл ─────────────────── */

describe("Реестр пробелов — заливки: телеграм-импорт архива застыл", () => {
  const TODAY_LOCAL = "2026-08-22";

  it("импорт оборван 03.08, живой ввод продолжается до 17.08 (проверено на проде день в день) — гэп", () => {
    const refills = [
      ...Array.from({ length: 1143 }, () => ({ createdBy: "import:telegram-history", enteredDate: "2026-08-03" })),
      ...Array.from({ length: 10 }, () => ({ createdBy: "operator", enteredDate: "2026-08-17" })),
    ];
    const gaps = telegramImportStalledGap(refills, TODAY_LOCAL);
    assert.equal(gaps.length, 1);
    assert.match(gaps[0].missing, /2026-08-03/);
    assert.match(gaps[0].missing, /19 дней/);
    assert.match(gaps[0].missing, /2026-08-17/);
  });

  it("нет ни одной строки импорта вовсе — не гэп этого детектора", () => {
    assert.deepEqual(telegramImportStalledGap([{ createdBy: "operator", enteredDate: "2026-08-20" }], TODAY_LOCAL), []);
  });

  it("тишина в пределах порога — не гэп", () => {
    assert.deepEqual(telegramImportStalledGap([{ createdBy: "import:telegram-history", enteredDate: "2026-08-10" }], TODAY_LOCAL), []);
  });

  it("КЛЮЧЕВОЙ ТЕСТ: новый импорт с недавней датой — гэп исчезает", () => {
    const было = telegramImportStalledGap([{ createdBy: "import:telegram-history", enteredDate: "2026-08-03" }], TODAY_LOCAL);
    assert.equal(было.length, 1);
    const стало = telegramImportStalledGap(
      [
        { createdBy: "import:telegram-history", enteredDate: "2026-08-03" },
        { createdBy: "import:telegram-history", enteredDate: "2026-08-21" },
      ],
      TODAY_LOCAL,
    );
    assert.deepEqual(стало, []);
  });
});

/* ── Детектор 21: закупки сырья — тишина ──────────────────────────────────── */

describe("Реестр пробелов — закупки сырья: тишина", () => {
  it("последний приход 08.01.2026 (проверено на проде) — гэп", () => {
    const gaps = stockIntakeSilenceGap(["2026-01-08"], "2026-08-22");
    assert.equal(gaps.length, 1);
    assert.match(gaps[0].missing, /2026-01-08/);
  });

  it("прихода нет вовсе — пусто (это область другого детектора)", () => {
    assert.deepEqual(stockIntakeSilenceGap([], "2026-08-22"), []);
  });

  it("тишина в пределах порога — не гэп", () => {
    assert.deepEqual(stockIntakeSilenceGap(["2026-08-01"], "2026-08-22"), []);
  });

  it("КЛЮЧЕВОЙ ТЕСТ: свежий приход — гэп исчезает", () => {
    const было = stockIntakeSilenceGap(["2026-01-08"], "2026-08-22");
    assert.equal(было.length, 1);
    const стало = stockIntakeSilenceGap(["2026-01-08", "2026-08-15"], "2026-08-22");
    assert.deepEqual(стало, []);
  });
});

/* ── Детектор 22: закупки сырья — у ингредиента нет ни одной ──────────────── */

describe("Реестр пробелов — закупки сырья: у ингредиента нет ни одной закупки", () => {
  const bunkerIngredients = [
    { id: "1", name: "Сухое молоко" },
    { id: "2", name: "Ягодный чай" },
    { id: "3", name: "Лимонный чай" },
    { id: "4", name: "Матча" },
    { id: "5", name: "Сахар" },
    { id: "6", name: "Шоколад" },
    { id: "7", name: "MacCoffee" },
    { id: "8", name: "Кофе" },
  ];

  it("7 из 8 — у сахара приходов нет (проверено на проде)", () => {
    const intake = new Set(["1", "2", "3", "4", "6", "7", "8"]);
    const gaps = ingredientsWithoutPurchaseGap(bunkerIngredients, intake);
    assert.equal(gaps.length, 1);
    assert.match(gaps[0].missing, /1 из 8/);
    assert.match(gaps[0].missing, /Сахар/);
  });

  it("у всех бункерных ингредиентов есть приход — пусто", () => {
    assert.deepEqual(ingredientsWithoutPurchaseGap(bunkerIngredients, new Set(bunkerIngredients.map((i) => i.id))), []);
  });

  it("КЛЮЧЕВОЙ ТЕСТ: приход сахара завели — гэп исчезает", () => {
    const было = ingredientsWithoutPurchaseGap(bunkerIngredients, new Set(["1", "2", "3", "4", "6", "7", "8"]));
    assert.equal(было.length, 1);
    const стало = ingredientsWithoutPurchaseGap(bunkerIngredients, new Set(bunkerIngredients.map((i) => i.id)));
    assert.deepEqual(стало, []);
  });
});

describe("Реестр пробелов — закупки сырья: ингредиент без карточки реестра", () => {
  it("ингредиент без карточки не выпадает из знаменателя молча", () => {
    const gaps = ingredientsWithoutPurchaseGap(
      [{ id: "ent-1", name: "Кофе" }, { id: "ent-2", name: "Сахар" }],
      new Set(["ent-1"]),
      ["Матча"],
    );
    assert.equal(gaps.length, 1);
    assert.match(gaps[0].missing, /1 из 3/, "знаменатель обязан включать ингредиент без карточки");
    assert.match(gaps[0].missing, /Сахар/);
    assert.match(gaps[0].missing, /нет карточки реестра/);
    assert.match(gaps[0].missing, /Матча/);
  });

  it("все с карточками и все приходовались — пусто", () => {
    assert.deepEqual(ingredientsWithoutPurchaseGap([{ id: "ent-1", name: "Кофе" }], new Set(["ent-1"]), []), []);
  });

  it("приходов нет ни у кого, карточки у всех — прежнее поведение не изменилось", () => {
    const gaps = ingredientsWithoutPurchaseGap([{ id: "ent-1", name: "Кофе" }], new Set(), []);
    assert.equal(gaps.length, 1);
    assert.match(gaps[0].missing, /1 из 1/);
    assert.doesNotMatch(gaps[0].missing, /нет карточки/);
  });
});

/* ── Детектор 23: заливки — точка без размещения автомата ─────────────────── */

describe("Реестр пробелов — заливки: точка без размещения автомата", () => {
  /**
   * Ревью, блокер Б3. `filledWeight` — вес БРУТТО, вместе с тарой набора;
   * весь остальной код (включая соседний детектор тары) считает через
   * `netWeight()`. Складывая брутто, детектор объявлял сырья примерно вдвое
   * больше, чем его было.
   *
   * Числа проверены на проде 22.08.2026 по точке «кардиология 1 корпус»:
   * две заливки 1691 г и 1668 г — это 3359 г брутто (ровно то число, что
   * стояло в прежней версии), но тара наборов 609 г и 640 г, значит сырья
   * 1082 + 1028 = 2110 г. Тара съедала 37% объявленного.
   */
  it("сумма считается по НЕТТО, а не по брутто (кардиология: 2110 г, а не 3359 г)", () => {
    const refills = [
      { locationId: "kardio", containerNumber: 10, position: 1, filledWeight: 1691 },
      { locationId: "kardio", containerNumber: 11, position: 1, filledWeight: 1668 },
      { locationId: "soliq", containerNumber: 12, position: 1, filledWeight: 5000 },
      { locationId: "placed", containerNumber: 13, position: 1, filledWeight: 999 },
    ];
    const tare = new Map([["10:1", 609], ["11:1", 640], ["12:1", 600], ["13:1", 100]]);
    const names = new Map([
      ["kardio", "кардиология 1 корпус"],
      ["soliq", "Soliq Yashnobod"],
      ["placed", "Точка с размещением"],
    ]);
    const gaps = locationsWithoutMachinePlacementGap(refills, new Set(["placed"]), names, tare);
    assert.equal(gaps.length, 1);
    assert.match(gaps[0].missing, /2 точек/);
    // 2110 (кардиология, нетто) + 4400 (Soliq, нетто) = 6510 г = 6,5 кг.
    assert.match(gaps[0].missing, /6,5 кг/);
    assert.doesNotMatch(gaps[0].missing, /9,4 кг/, "9,4 кг — это сумма брутто, ровно та ошибка, что чинит блокер");
    assert.match(gaps[0].missing, /кардиология 1 корпус/);
  });

  it("заливки с неизвестной тарой не молчат: в сумму не входят, но названы числом", () => {
    const refills = [
      { locationId: "kardio", containerNumber: 10, position: 1, filledWeight: 1691 },
      // Набор 99 никогда не калибровался — нетто посчитать НЕЧЕМ. Прежде его
      // брутто просто прибавлялось к сумме, выдавая тару за сырьё.
      { locationId: "kardio", containerNumber: 99, position: 1, filledWeight: 1000 },
      { locationId: "kardio", containerNumber: null, position: 1, filledWeight: 500 },
    ];
    const tare = new Map([["10:1", 609]]);
    const names = new Map([["kardio", "кардиология 1 корпус"]]);
    const gaps = locationsWithoutMachinePlacementGap(refills, new Set(), names, tare);
    assert.equal(gaps.length, 1);
    assert.match(gaps[0].missing, /1,1 кг/, "в сумму идут только 1082 г нетто откалиброванного набора");
    assert.match(gaps[0].missing, /заливок с неизвестной тарой: 2/, "две заливки без известной тары обязаны быть видны отдельно");
  });

  it("у всех точек есть размещение — пусто", () => {
    assert.deepEqual(
      locationsWithoutMachinePlacementGap(
        [{ locationId: "a", containerNumber: 1, position: 1, filledWeight: 100 }],
        new Set(["a"]),
        new Map(),
        new Map([["1:1", 10]]),
      ),
      [],
    );
  });

  it("КЛЮЧЕВОЙ ТЕСТ: точке завели размещение — она выпадает из списка (Parus F4 после 05.08.2026)", () => {
    const refills = [
      { locationId: "parusF4", containerNumber: 20, position: 1, filledWeight: 1000 },
      { locationId: "soliq", containerNumber: 21, position: 1, filledWeight: 5000 },
    ];
    const tare = new Map([["20:1", 100], ["21:1", 600]]);
    const names = new Map([
      ["parusF4", "Parus F4"],
      ["soliq", "Soliq Yashnobod"],
    ]);
    const было = locationsWithoutMachinePlacementGap(refills, new Set(), names, tare);
    assert.match(было[0].missing, /Parus F4/);
    const стало = locationsWithoutMachinePlacementGap(refills, new Set(["parusF4"]), names, tare);
    assert.doesNotMatch(стало[0].missing, /Parus F4/);
    assert.match(стало[0].missing, /Soliq Yashnobod/);
  });
});

/* ── Детектор 24: карточка-рецепт без состава ─────────────────────────────── */

describe("Реестр пробелов — карточка-рецепт без состава", () => {
  it("критерий сегодня — 0 строк: все 19 карточек вида «рецепт» состав имеют (проверено на проде 22.08.2026)", () => {
    const cards = [
      { id: "1", name: "Americano", type: "product", attrs: { "вид": "рецепт", "состав": '[{"ingredientId":"i","quantity":8,"unit":"г"}]' } },
      { id: "2", name: "Latte", type: "product", attrs: { "вид": "рецепт", "состав": '[{"ingredientId":"i","quantity":18,"unit":"г"}]' } },
    ];
    assert.deepEqual(recipeCardsWithoutCompositionGap(cards), []);
  });

  it("карточка вида «рецепт» без состава — гэп (дефект спит, пока такой карточки нет)", () => {
    const cards = [{ id: "3", name: "Новый рецепт", type: "product", attrs: { "вид": "рецепт" } }];
    const gaps = recipeCardsWithoutCompositionGap(cards);
    assert.equal(gaps.length, 1);
    assert.match(gaps[0].missing, /Новый рецепт/);
  });

  it("товар «на перепродажу» без состава — не гэп: у него состава и не должно быть", () => {
    assert.deepEqual(recipeCardsWithoutCompositionGap([{ id: "4", name: "Кола", type: "product", attrs: { "вид": "перепродажа" } }]), []);
  });

  it("КЛЮЧЕВОЙ ТЕСТ: состав заполнили — гэп исчезает", () => {
    const было = recipeCardsWithoutCompositionGap([{ id: "3", name: "Новый рецепт", type: "product", attrs: { "вид": "рецепт" } }]);
    assert.equal(было.length, 1);
    const стало = recipeCardsWithoutCompositionGap([
      { id: "3", name: "Новый рецепт", type: "product", attrs: { "вид": "рецепт", "состав": [{ ingredientId: "i", quantity: 10, unit: "г" }] } },
    ]);
    assert.deepEqual(стало, []);
  });
});

/* ── Сборка: GapsService.list() ───────────────────────────────────────────── */

/** Заглушка select().from(table)[.where()][.leftJoin()] — где/джойн не фильтруют, тестовые данные уже «отфильтрованы». */
function stubDb(tables: Map<unknown, Row[]>) {
  const rowsFor = (t: unknown) => tables.get(t) ?? [];
  const chain = (rows: Row[]): unknown =>
    Object.assign(Promise.resolve(rows), {
      where: () => chain(rows),
      leftJoin: () => chain(rows),
      limit: () => chain(rows),
    });
  return { select: () => ({ from: (t: unknown) => chain(rowsFor(t)) }) } as never;
}

const EMPTY_RECONCILE: РезультатСверки = {
  from: "2000-01-01",
  to: TODAY,
  rows: [],
  intervals: [],
  первыхИсключено: 0,
  итог: { выручка: 0, изъято: 0, разница: 0, доля: null, автоматов: 0 },
  внеИтога: { автоматов: 0, выручка: 0 },
};

const EMPTY_CASH_RECONCILE: CashReconcileReport = {
  from: "2000-01-01",
  to: TODAY,
  withdrawn: 0,
  withdrawnCount: 0,
  withdrawnPendingCount: 0,
  hasWithdrawn: false,
  deposited: 0,
  depositedCount: 0,
  hasDeposited: false,
  diff: 0,
  periods: [],
  gaps: [],
  note: "",
};

describe("GapsService.list() — сборка реестра", () => {
  it("пустой список — хорошая новость: полностью здоровая система отдаёт []", async () => {
    const tables = new Map<unknown, Row[]>([
      [collectionTable, [{ collectedAt: new Date(`${TODAY}T09:00:00+05:00`) }]],
      [
        coffeeRefillTable,
        [
          {
            ingredientId: "ing1",
            filledWeight: 500,
            enteredDate: TODAY,
            packageCount: null,
            position: 7,
            containerNumber: 1,
            locationId: "loc1",
            measuredBefore: 400,
            createdBy: "bot",
          },
        ],
      ],
      [stockBatchTable, [{ receivedOn: TODAY, expiryDate: "2027-01-01", manufactureDate: null, invoiceDate: TODAY }]],
      [purchaseTable, [{ dt: TODAY }]],
      [
        coffeeIngredientTable,
        [{ id: "ing1", name: "Кофе", entityId: "ent-ing1", purchasePrice: null, packageWeight: null, cardAttrs: { "цена покупки": 260000, "единица": "кг" } }],
      ],
      [moneyFlowTable, [{ domain: "vendhub", direction: "in", source: "bank", amount: "1000", currency: "UZS", amountUzs: null, status: "actual" }]],
      [rawReportDefTable, [{ sourceCode: "ourvend", code: "banknotes", title: "Купюры", ru: "Купюры" }]],
      [saleTable, [{ n: 0 }]],
      // Все 8 позиций сконфигурированы и с эталонным весом — детекторы 18/19 молчат.
      [coffeeBunkerConfigTable, Array.from({ length: 8 }, (_, i) => ({ position: i + 1, ingredientId: "ing1", targetFillWeight: 500 }))],
      [machinePlacementTable, [{ locationId: "loc1" }]],
      [stockMovementTable, [{ ingredientId: "ent-ing1", dt: TODAY }]],
    ]);
    const db = stubDb(tables);
    const collections = { reconcile: async () => EMPTY_RECONCILE } as unknown as CollectionsService;
    const finance = { cashReconcile: async () => EMPTY_CASH_RECONCILE } as unknown as FinanceService;

    // appConfig.tz совпадает с TZ в этом процессе (config.ts форсирует process.env.TZ) — гэп 14 тоже не сработает.
    const service = new GapsService(db, collections, finance);
    const gaps = await service.list();
    assert.deepEqual(gaps, []);
  });

  it("нездоровая система — несколько источников гэпов собираются в один список", async () => {
    const tables = new Map<unknown, Row[]>([
      [collectionTable, []], // тишина: инкассаций нет вовсе
      [
        coffeeRefillTable,
        [
          {
            ingredientId: null,
            filledWeight: 1000,
            enteredDate: TODAY,
            packageCount: null,
            position: 8,
            containerNumber: null,
            locationId: "loc-bad",
            measuredBefore: null,
            createdBy: "import:telegram-history",
          },
        ],
      ],
      [stockBatchTable, [{ receivedOn: TODAY, expiryDate: null, manufactureDate: null, invoiceDate: null }]],
      [purchaseTable, [{ dt: null }]],
      [coffeeIngredientTable, [{ id: "ing1", name: "Стакан", entityId: null, purchasePrice: null, packageWeight: null, cardAttrs: null }]],
      [moneyFlowTable, [{ domain: null, direction: "in", source: "bank", amount: "500000", currency: "UZS", amountUzs: null, status: "actual" }]],
      [rawReportDefTable, []],
      [saleTable, [{ n: 968 }]],
      // coffeeBunkerConfigTable/machinePlacementTable/stockMovementTable намеренно пусты
      // (по умолчанию []) — позиция 8 без конфигурации, точка без размещения, прихода нет.
    ]);
    const db = stubDb(tables);
    const collections = { reconcile: async () => EMPTY_RECONCILE } as unknown as CollectionsService;
    const finance = { cashReconcile: async () => EMPTY_CASH_RECONCILE } as unknown as FinanceService;

    const service = new GapsService(db, collections, finance);
    const gaps = await service.list();
    const topics = gaps.map((g) => g.topic);
    assert.ok(topics.includes("инкассации: тишина"));
    assert.ok(topics.includes("заливки без ингредиента"));
    assert.ok(topics.includes("сроки годности партий"));
    assert.ok(topics.includes("партии без даты счёта"));
    assert.ok(topics.includes("закупки без даты прихода"));
    assert.ok(topics.includes("ингредиенты без цены"));
    assert.ok(topics.includes("банковские записи без направления"));
    assert.ok(topics.includes("сверка купюр по автомату — односторонняя"));
    assert.ok(topics.includes("снек: канала оплаты нет"));
    assert.ok(topics.includes("заливки: замер «до досыпки» не делают"));
    assert.ok(topics.includes("бункеры: позиция не сконфигурирована"));
    assert.ok(topics.includes("бункеры: недолив не проверяется"));
    assert.ok(topics.includes("заливки: точка без размещения автомата"));
  });
});
