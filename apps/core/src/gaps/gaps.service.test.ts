import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  coffeeIngredient as coffeeIngredientTable,
  coffeeRefill as coffeeRefillTable,
  collection as collectionTable,
  moneyFlow as moneyFlowTable,
  purchase as purchaseTable,
  rawReportDef as rawReportDefTable,
  sale as saleTable,
  stockBatch as stockBatchTable,
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
  collectionSilenceGap,
  GapsService,
  healthTimezoneGap,
  ingredientsWithoutPackageWeightGap,
  ingredientsWithoutPriceGap,
  journalHoleGaps,
  neverCollectedRevenueGaps,
  purchasesWithoutDateGap,
  refillsWithoutIngredientGap,
  snackPaymentChannelGap,
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
      { domain: null, amount: "1000000", currency: "UZS", amountUzs: null, status: "actual" },
      { domain: null, amount: "500000", currency: "UZS", amountUzs: null, status: "actual" },
      { domain: null, amount: "999999", currency: "UZS", amountUzs: null, status: "cancelled" },
      { domain: "vendhub", amount: "777", currency: "UZS", amountUzs: null, status: "actual" },
    ]);
    assert.equal(gaps.length, 1);
    assert.match(gaps[0].missing, /2 записей/);
    assert.match(gaps[0].missing, /1 500 000/);
  });

  it("все записи привязаны к направлению — пусто", () => {
    assert.deepEqual(
      bankFlowsWithoutDomainGap([{ domain: "vendhub", amount: "1000", currency: "UZS", amountUzs: null, status: "actual" }]),
      [],
    );
  });

  it("КЛЮЧЕВОЙ ТЕСТ: запись привязали к направлению — гэп исчезает", () => {
    const было = bankFlowsWithoutDomainGap([{ domain: null, amount: "1000000", currency: "UZS", amountUzs: null, status: "actual" }]);
    assert.equal(было.length, 1);
    const стало = bankFlowsWithoutDomainGap([{ domain: "vendhub", amount: "1000000", currency: "UZS", amountUzs: null, status: "actual" }]);
    assert.deepEqual(стало, []);
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
      [coffeeRefillTable, [{ ingredientId: "ing1", filledWeight: 500, enteredDate: TODAY, packageCount: null }]],
      [stockBatchTable, [{ receivedOn: TODAY, expiryDate: "2027-01-01", manufactureDate: null, invoiceDate: TODAY }]],
      [purchaseTable, [{ dt: TODAY }]],
      [coffeeIngredientTable, [{ id: "ing1", name: "Кофе", purchasePrice: null, packageWeight: null, cardAttrs: { "цена покупки": 260000, "единица": "кг" } }]],
      [moneyFlowTable, [{ domain: "vendhub", amount: "1000", currency: "UZS", amountUzs: null, status: "actual" }]],
      [rawReportDefTable, [{ sourceCode: "ourvend", code: "banknotes", title: "Купюры", ru: "Купюры" }]],
      [saleTable, [{ n: 0 }]],
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
      [coffeeRefillTable, [{ ingredientId: null, filledWeight: 1000, enteredDate: TODAY, packageCount: null }]],
      [stockBatchTable, [{ receivedOn: TODAY, expiryDate: null, manufactureDate: null, invoiceDate: null }]],
      [purchaseTable, [{ dt: null }]],
      [coffeeIngredientTable, [{ id: "ing1", name: "Стакан", purchasePrice: null, packageWeight: null, cardAttrs: null }]],
      [moneyFlowTable, [{ domain: null, amount: "500000", currency: "UZS", amountUzs: null, status: "actual" }]],
      [rawReportDefTable, []],
      [saleTable, [{ n: 968 }]],
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
  });
});
