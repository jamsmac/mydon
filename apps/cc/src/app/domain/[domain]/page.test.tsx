import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Obligations } from "../../../lib/core";

// Все методы Core, которые страница может дёрнуть. По умолчанию — «пусто/нет
// данных»; каждый тест переопределяет только те источники, чей отказ проверяет.
const CORE_METHODS = [
  "brvValues",
  "cashEstimate",
  "cashReconcile",
  "coffeeBunkerConfig",
  "coffeeFillStatus",
  "coffeeNormFact",
  "coffeeOrdersStatus",
  "coffeeOrdersSummary",
  "collections",
  "collectionsSummary",
  "contractorsAll",
  "contracts",
  "entitiesOf",
  "entitiesOfType",
  "expiryReport",
  "financeCounterparties",
  "financeFlows",
  "financeSummary",
  "fxRates",
  "gaps",
  "imports",
  "machineCards",
  "obligations",
  "people",
  "preorders",
  "recentCoffeeRefills",
  "reconcileCollections",
  "salesDaily",
  "salesSummary",
  "supplySummary",
  "tasks",
  "tasksOverdue",
  "tnvedRates",
  "units",
  "unitsSummary",
  "vendingDeficit",
  "vendingRefillList",
] as const;

const mocks = vi.hoisted(() => {
  const core = {} as Record<string, ReturnType<typeof vi.fn>>;
  for (const name of [
    "brvValues",
    "cashEstimate",
    "cashReconcile",
    "coffeeBunkerConfig",
    "coffeeFillStatus",
    "coffeeNormFact",
    "coffeeOrdersStatus",
    "coffeeOrdersSummary",
    "collections",
    "collectionsSummary",
    "contractorsAll",
    "contracts",
    "entitiesOf",
    "entitiesOfType",
    "expiryReport",
    "financeCounterparties",
    "financeFlows",
    "financeSummary",
    "fxRates",
    "gaps",
    "imports",
    "machineCards",
    "obligations",
    "people",
    "preorders",
    "recentCoffeeRefills",
    "reconcileCollections",
    "salesDaily",
    "salesSummary",
    "supplySummary",
    "tasks",
    "tasksOverdue",
    "tnvedRates",
    "units",
    "unitsSummary",
    "vendingDeficit",
    "vendingRefillList",
  ]) {
    core[name] = vi.fn();
  }
  return { core };
});

vi.mock("../../../lib/core", () => ({
  CoreUnavailable: class CoreUnavailable extends Error {
    detail: string;
    constructor(detail = "boom") {
      super(detail);
      this.detail = detail;
    }
  },
  core: mocks.core,
}));

// Клиентские виджеты, которые рендерятся на дашборде — их поведение не входит в
// зону этого теста, подменяем заглушками.
vi.mock("../../../components/quick-actions", () => ({
  QuickActions: () => <div data-quick-actions />,
}));
vi.mock("../../../components/mini-bars", () => ({
  MiniBars: () => <div data-mini-bars />,
}));

import DomainPage from "./page";
import { CoreUnavailable } from "../../../lib/core";

const NO_OBLIGATIONS: Obligations = {
  domain: "mydon",
  totals: [],
  overdue: [],
  overdueTotal: 0,
  overdueTruncated: false,
};

async function renderResolved(domain: string, tab: string) {
  return render(
    await DomainPage({
      params: Promise.resolve({ domain }),
      searchParams: Promise.resolve({ tab }),
    }),
  );
}

describe("страница направления: частичный отказ Core честен", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    for (const name of CORE_METHODS) mocks.core[name]!.mockResolvedValue(null);
    mocks.core.entitiesOf!.mockResolvedValue([]);
    mocks.core.people!.mockResolvedValue([]);
    mocks.core.tasks!.mockResolvedValue([]);
    mocks.core.contractorsAll!.mockResolvedValue([]);
    mocks.core.obligations!.mockResolvedValue(NO_OBLIGATIONS);
  });

  it("провал обязательств → «данные недоступны», а не «просрочек нет»/ноль", async () => {
    mocks.core.obligations!.mockRejectedValue(new Error("obligations down"));

    const { container } = await renderResolved("mydon", "overview");
    const text = container.textContent ?? "";

    expect(text).toContain("данные недоступны");
    expect(text).not.toContain("просрочек нет");
    expect(text).not.toContain("нет открытых счетов");
    // Плитка «Просрочено» показывает прочерк, а не ложный ноль.
    const overdueTile = Array.from(container.querySelectorAll(".tile")).find((t) =>
      t.querySelector(".lab")?.textContent?.includes("Просрочено"),
    );
    expect(overdueTile?.querySelector(".v")?.textContent).toBe("—");
  });

  it("успех обязательств без долгов → «просрочек нет», без «данные недоступны»", async () => {
    const { container } = await renderResolved("mydon", "overview");
    const text = container.textContent ?? "";

    expect(text).toContain("просрочек нет");
    expect(text).not.toContain("данные недоступны");
    const overdueTile = Array.from(container.querySelectorAll(".tile")).find((t) =>
      t.querySelector(".lab")?.textContent?.includes("Просрочено"),
    );
    expect(overdueTile?.querySelector(".v")?.textContent).toBe("0");
  });

  it("провал команды/задач → вкладка «Команда» честно говорит «Данные недоступны»", async () => {
    mocks.core.people!.mockRejectedValue(new Error("people down"));
    mocks.core.tasks!.mockRejectedValue(new Error("tasks down"));

    const { container } = await renderResolved("mydon", "team");
    const text = container.textContent ?? "";

    expect(text).toContain("Данные недоступны");
    expect(text).not.toContain("В этом направлении пока никого");
  });

  it("провал команды/задач → вкладка «Задачи» честно говорит «Данные недоступны»", async () => {
    mocks.core.people!.mockRejectedValue(new Error("people down"));
    mocks.core.tasks!.mockRejectedValue(new Error("tasks down"));

    const { container } = await renderResolved("mydon", "tasks");
    const text = container.textContent ?? "";

    expect(text).toContain("Данные недоступны");
    expect(text).not.toContain("Открытых задач нет");
  });

  it("успех команды без записей → прежние пустые состояния, без «Данные недоступны»", async () => {
    const teamText = (await renderResolved("mydon", "team")).container.textContent ?? "";
    expect(teamText).toContain("В этом направлении пока никого");
    expect(teamText).not.toContain("Данные недоступны");

    const tasksText = (await renderResolved("mydon", "tasks")).container.textContent ?? "";
    expect(tasksText).toContain("Открытых задач нет");
    expect(tasksText).not.toContain("Данные недоступны");
  });

  it("провал реестра → CoreDown, а не пустая страница", async () => {
    mocks.core.entitiesOf!.mockRejectedValue(new CoreUnavailable("core-off"));

    const { container } = await renderResolved("mydon", "overview");
    const text = container.textContent ?? "";

    expect(text).toContain("Нет связи с ядром MYDON");
    expect(text).toContain("core-off");
  });
});

describe("VendHub-итоги: недоступный источник не складывается как ноль", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    for (const name of CORE_METHODS) mocks.core[name]!.mockResolvedValue(null);
    mocks.core.entitiesOf!.mockResolvedValue([]);
    mocks.core.people!.mockResolvedValue([]);
    mocks.core.tasks!.mockResolvedValue([]);
    mocks.core.contractorsAll!.mockResolvedValue([]);
    mocks.core.obligations!.mockResolvedValue({ ...NO_OBLIGATIONS, domain: "vendhub" });
  });

  it("кофе-контур провалился, снек жив → «Выручка» показывает «частично недоступно», а не снек-часть", async () => {
    // Снек-выручка отвечает, кофе-контур null (провал/эндпоинт не на проде).
    mocks.core.salesSummary!.mockResolvedValue({
      days30: { amount: 5_000_000, qty: 100 },
      yesterday: { amount: 100_000, qty: 5 },
      lastSaleDt: "2026-08-30T10:00:00.000Z",
    });
    mocks.core.coffeeOrdersSummary!.mockResolvedValue(null);

    const { container } = await renderResolved("vendhub", "overview");
    const revenueTile = Array.from(container.querySelectorAll(".wt")).find((t) =>
      t.querySelector(".wl")?.textContent?.includes("Выручка"),
    );

    expect(revenueTile?.querySelector(".wf")?.textContent).toContain("частично недоступно");
    // Занижённое число (5 млн снека) НЕ выдаётся за итог выручки.
    expect(revenueTile?.querySelector(".wv")?.textContent).toBe("—");
    expect(revenueTile?.querySelector(".wv")?.textContent).not.toContain("5");
  });

  it("оба контура выручки живы → сумма показывается как раньше", async () => {
    mocks.core.salesSummary!.mockResolvedValue({
      days30: { amount: 5_000_000, qty: 100 },
      yesterday: { amount: 100_000, qty: 5 },
      lastSaleDt: "2026-08-30T10:00:00.000Z",
    });
    mocks.core.coffeeOrdersSummary!.mockResolvedValue({
      всего: { выручка: 3_000_000, чашек: 200, среднийЧек: 15000 },
      неВыдано: 0,
      поТоварам: [],
      поДням: [],
      поАвтоматам: [],
    });

    const { container } = await renderResolved("vendhub", "overview");
    const revenueTile = Array.from(container.querySelectorAll(".wt")).find((t) =>
      t.querySelector(".wl")?.textContent?.includes("Выручка"),
    );

    expect(revenueTile?.querySelector(".wf")?.textContent).not.toContain("частично недоступно");
    // 5 млн снек + 3 млн кофе = 8 000 000.
    expect(revenueTile?.querySelector(".wv")?.textContent?.replace(/\s/g, "")).toBe("8000000");
  });

  it("провал core.tasks на вкладке «Задачи» vendhub → мини-KPI не рендерится ложным нулём", async () => {
    // Единственный контур, где taskKpi вообще строится, — vendhub+tasks.
    // При провале задач openTasks=[], и «Открыто: 0» повисло бы над «Данные
    // недоступны». KPI должен быть обесточен, а не показывать успокаивающий ноль.
    mocks.core.tasks!.mockRejectedValue(new Error("tasks down"));

    const { container } = await renderResolved("vendhub", "tasks");
    const text = container.textContent ?? "";

    expect(text).toContain("Данные недоступны");
    expect(text).not.toContain("Открытых задач нет");
    // Плитки мини-KPI («Открыто»/«Свободных»/«За неделю») не отрисованы.
    const openKpi = Array.from(container.querySelectorAll(".wt")).find((t) =>
      t.querySelector(".wl")?.textContent?.includes("Открыто"),
    );
    expect(openKpi).toBeUndefined();
  });
});

describe("свежесть кофе-данных: давность видима, а не молчит (аудит 02.09)", () => {
  const COFFEE_SUMMARY = {
    всего: { выручка: 3_000_000, чашек: 200, среднийЧек: 15000 },
    неВыдано: 0,
    поТоварам: [],
    поДням: [],
    поАвтоматам: [],
  };
  const ordersStatus = (последний: string | null) => ({
    всего: 1000,
    вВыручке: 990,
    первый: "2026-01-01T00:00:00.000Z",
    последний,
  });

  // Копия shortRuDate страницы: «24 июн» по Ташкенту, без точки после месяца —
  // тест сверяет именно ту дату, которую увидит владелец.
  const shortRu = (iso: string) =>
    new Date(iso)
      .toLocaleDateString("ru-RU", { timeZone: "Asia/Tashkent", day: "numeric", month: "short" })
      .replace(/\.$/, "");

  beforeEach(() => {
    vi.resetAllMocks();
    for (const name of CORE_METHODS) mocks.core[name]!.mockResolvedValue(null);
    mocks.core.entitiesOf!.mockResolvedValue([]);
    mocks.core.people!.mockResolvedValue([]);
    mocks.core.tasks!.mockResolvedValue([]);
    mocks.core.contractorsAll!.mockResolvedValue([]);
    mocks.core.obligations!.mockResolvedValue({ ...NO_OBLIGATIONS, domain: "vendhub" });
    mocks.core.salesSummary!.mockResolvedValue({
      days30: { amount: 5_000_000, qty: 100 },
      yesterday: { amount: 100_000, qty: 5 },
      lastSaleDt: "2026-08-30T10:00:00.000Z",
    });
    mocks.core.coffeeOrdersSummary!.mockResolvedValue(COFFEE_SUMMARY);
  });

  it("свежий кофе (последний заказ вчера) → обычная подпись с датой, без тревоги", async () => {
    // «Вчера» относительно текущего дня: давность 1 сутки — норма, не тревога.
    const lastAt = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    mocks.core.coffeeOrdersStatus!.mockResolvedValue(ordersStatus(lastAt));

    const { container } = await renderResolved("vendhub", "overview");
    const text = container.textContent ?? "";

    expect(text).toContain(`кофе: данные до ${shortRu(lastAt)}`);
    expect(text).not.toContain("импорт стоит");
    expect(text).not.toContain("свежесть кофе: данные недоступны");
    // Чип свежести в секции «Кофе» — нейтральный, не тревожный (не .h).
    const chip = Array.from(container.querySelectorAll(".chip")).find((c) =>
      c.textContent?.includes("данные до"),
    );
    expect(chip).toBeDefined();
    // classList, а не подстрока: само слово «chip» содержит букву «h».
    expect(chip!.classList.contains("h")).toBe(false);
    expect(chip!.classList.contains("g")).toBe(false);
  });

  it("давность больше суток → заметная (тревожная) пометка с датой и «импорт стоит»", async () => {
    // Кофе-импорт стоит почти две недели — сценарий аудита (стоял с 20.08).
    const lastAt = new Date(Date.now() - 13 * 24 * 3600 * 1000).toISOString();
    mocks.core.coffeeOrdersStatus!.mockResolvedValue(ordersStatus(lastAt));

    const { container } = await renderResolved("vendhub", "overview");
    const text = container.textContent ?? "";

    expect(text).toContain("импорт стоит");
    // Пометка — тревожный чип (.chip.h), не зелёный и не нейтральный, с датой
    // последнего заказа; стоит и у секции «Кофе», и у плитки «Выручка».
    const hotChips = Array.from(container.querySelectorAll(".chip.h")).filter((c) =>
      c.textContent?.includes("данные до"),
    );
    expect(hotChips.length).toBeGreaterThanOrEqual(2);
    for (const chip of hotChips) expect(chip.textContent).toContain(shortRu(lastAt));
  });

  it("провал запроса статуса → «свежесть кофе: данные недоступны», а не молчание", async () => {
    mocks.core.coffeeOrdersStatus!.mockRejectedValue(new Error("status down"));

    const { container } = await renderResolved("vendhub", "overview");
    const text = container.textContent ?? "";

    expect(text).toContain("свежесть кофе: данные недоступны");
    // Неизвестная свежесть ≠ свежо: пометка тревожная, не нейтральная.
    const hotChip = Array.from(container.querySelectorAll(".chip.h")).find((c) =>
      c.textContent?.includes("данные недоступны"),
    );
    expect(hotChip).toBeDefined();
  });

  it("пустая таблица заказов (последний === null) → «заказов в базе нет» тревожным чипом", async () => {
    // Статус ответил, но заказов нет вовсе: импорт никогда не бежал или факт
    // полностью потерян. Это предельно несвежее состояние — чип тревожный,
    // а не спокойное нейтральное «заказов нет».
    mocks.core.coffeeOrdersStatus!.mockResolvedValue(ordersStatus(null));

    const { container } = await renderResolved("vendhub", "overview");
    const text = container.textContent ?? "";

    expect(text).toContain("кофе: заказов в базе нет");
    const hotChip = Array.from(container.querySelectorAll(".chip.h")).find((c) =>
      c.textContent?.includes("заказов в базе нет"),
    );
    expect(hotChip).toBeDefined();
  });

  it("контейнеры с чипом свежести переносят элементы (flex-wrap) — чип не клипается на узких экранах", async () => {
    // .chip несёт white-space: nowrap, а .sect-h и .wt .wf — flex без
    // переноса: на min-колонке 260px чип «кофе: данные до … · импорт стоит»
    // вылезал бы за границу плитки/шапки. Проверяем оба места.
    const lastAt = new Date(Date.now() - 13 * 24 * 3600 * 1000).toISOString();
    mocks.core.coffeeOrdersStatus!.mockResolvedValue(ordersStatus(lastAt));

    const { container } = await renderResolved("vendhub", "overview");
    const chips = Array.from(container.querySelectorAll(".chip.h")).filter((c) =>
      c.textContent?.includes("данные до"),
    );
    // Чип стоит и в шапке «Кофе» (.sect-h), и в подвале «Выручки» (.wf).
    expect(chips.length).toBeGreaterThanOrEqual(2);
    for (const chip of chips) {
      const holder = chip.parentElement as HTMLElement;
      expect(["sect-h", "wf"].some((cls) => holder.classList.contains(cls))).toBe(true);
      expect(holder.style.flexWrap).toBe("wrap");
    }
  });

  it("снек «Продано вчера» подписан «данные приходят к 08:00» — утренний ноль не тревога", async () => {
    const { container } = await renderResolved("vendhub", "overview");
    const tile = Array.from(container.querySelectorAll(".wt")).find((t) =>
      t.querySelector(".wl")?.textContent?.includes("Продано вчера"),
    );
    expect(tile?.querySelector(".wf")?.textContent).toContain("данные приходят к 08:00");
  });
});
