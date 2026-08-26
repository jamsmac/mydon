import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { StockCountsReport } from "../lib/core";
import { VENDHUB_GROUPS, isTableBackedLeaf } from "../lib/domain-nav";
import {
  STOCK_HISTORY_WINDOWS,
  StockHistoryTables,
  StockHistoryView,
  groupStockCounts,
  лидИстории,
} from "./stock-history-view";

const mocks = vi.hoisted(() => ({ vendingStockCounts: vi.fn() }));
// В одном файле с таблицами живёт серверный `StockHistoryView`, а он тянет
// клиент Core — тот первой строкой импортирует пакет `server-only`, которого
// вне RSC не существует.
vi.mock("../lib/core", () => ({
  core: { vendingStockCounts: mocks.vendingStockCounts },
  CoreUnavailable: class CoreUnavailable extends Error {
    constructor(readonly detail: string) {
      super("Core недоступен");
    }
  },
}));

/**
 * Боевая форма — та, которую КОД РЕАЛЬНО ПРОИЗВОДИТ, а не удобная глазу.
 *
 * · `own`: `note` = актор `ingestStock`, а контроллер зовёт её без аргумента
 *   (`vending.controller.ts`), то есть сегодня на всех своих строках стоит
 *   ровно `"owner"`. Красивое «Рустам» здесь было бы фикстурой, прячущей вход.
 * · `stock-import`: `note` = ВСЯ пометка целиком, с 30-символьным техническим
 *   префиксом (`importNote` в `packages/shared/src/stock-history.ts`). Именно
 *   этот вид приезжает на всех ~460 донорских строках.
 */
const ИСТОРИЯ: StockCountsReport = {
  days: 90,
  since: "2026-05-28",
  product: null,
  rows: [
    { dt: "2026-08-25", product: "Sprite 250ml", qty: 19, source: "own", countedAt: "2026-08-25T09:40:00+05:00", note: "owner" },
    { dt: "2026-08-25", product: "TUC Sour cream", qty: 6, source: "own", countedAt: "2026-08-25T09:40:00+05:00", note: "owner" },
    {
      dt: "2026-06-01",
      product: "Montella Вода минеральная 330ml",
      qty: 3,
      source: "stock-import",
      countedAt: "2026-06-01T07:00:00+05:00",
      note: "импорт истории mydon-stock · место: Холодильник",
    },
    {
      dt: "2026-06-01",
      product: "Snickers",
      qty: 41,
      source: "stock-import",
      countedAt: "2026-06-01T07:00:00+05:00",
      note: "импорт истории mydon-stock · место: Склад (основной)",
    },
  ],
  warnings: [],
};

describe("Лист «История склада» (R-H-2)", () => {
  it("сутки идут свежими сверху, внутри суток — группы по пометке", () => {
    const дни = groupStockCounts(ИСТОРИЯ.rows);
    expect(дни.map((d) => d.dt)).toEqual(["2026-08-25", "2026-06-01"]);
    expect(дни[1]!.groups.map((g) => g.note)).toEqual([
      "импорт истории mydon-stock · место: Холодильник",
      "импорт истории mydon-stock · место: Склад (основной)",
    ]);
    expect(дни[0]!.groups).toHaveLength(1);
    expect(дни[0]!.groups[0]!.rows.map((r) => r.product)).toEqual(["Sprite 250ml", "TUC Sour cream"]);
  });

  it("сутки сортируются ЯВНО: строка, введённая сегодня за июнь, июньскую группу не разрывает", () => {
    // Core сортирует по `counted_at desc`, а не по `dt`: поздний ввод за старый
    // день приезжает первым, и группировка «как пришло» дала бы три группы
    // вместо двух и июнь дважды.
    const поздняяЗаИюнь = { ...ИСТОРИЯ.rows[2]!, countedAt: "2026-08-25T18:00:00+05:00" };
    const дни = groupStockCounts([поздняяЗаИюнь, ...ИСТОРИЯ.rows.filter((_, i) => i !== 2)]);
    expect(дни.map((d) => d.dt)).toEqual(["2026-08-25", "2026-06-01"]);
    expect(дни[1]!.groups).toHaveLength(2);
  });

  it("подпись «место» — у импорта; «кто считал» — только там, где в пометке ИМЯ", () => {
    // Подпись «кто считал» — обещание, что рядом стоит человек. Над системным
    // литералом `owner` (единственное, что сегодня пишет `ingestStock`) она
    // читалась бы как «человека зовут owner», поэтому у переведённых заголовков
    // подписи нет вовсе, а у именной пометки — есть.
    const сИменем: StockCountsReport = {
      ...ИСТОРИЯ,
      rows: [{ ...ИСТОРИЯ.rows[0]!, note: "Рустам" }, ИСТОРИЯ.rows[2]!],
    };
    render(<StockHistoryTables report={сИменем} />);
    expect(within(screen.getByText("Рустам").closest("div")!).getByText("кто считал")).toBeVisible();
    expect(within(screen.getByText("Холодильник").closest("div")!).getByText("место")).toBeVisible();
  });

  it("свой пересчёт с литералом `owner` в заголовке назван «владелец», без подписи «кто считал»", () => {
    render(<StockHistoryTables report={ИСТОРИЯ} />);
    expect(screen.getByText("владелец")).toBeVisible();
    expect(screen.queryByText("owner")).toBeNull();
    expect(within(screen.getByText("владелец").closest("div")!).queryByText("кто считал")).toBeNull();
  });

  it("свой пересчёт без пометки назван источником — «инвентаризация MYDON», а не «без пометки»", () => {
    render(
      <StockHistoryTables
        report={{ ...ИСТОРИЯ, rows: [{ ...ИСТОРИЯ.rows[0]!, note: null }] }}
      />,
    );
    expect(screen.getByText("инвентаризация MYDON")).toBeVisible();
  });

  it("в заголовке импортированной группы стоит МЕСТО, а не технический префикс пометки", () => {
    // `note` в API остаётся сырым (честные данные), а префикс снимает обратная
    // к `importNote` — `placeFromImportNote` из `@mydon/shared`. Своей копии
    // строки «импорт истории mydon-stock» витрина не заводит: разъехавшись,
    // копия молча перестала бы сокращать заголовки.
    render(<StockHistoryTables report={ИСТОРИЯ} />);
    expect(screen.getByText("Холодильник")).toBeVisible();
    expect(screen.getByText("Склад (основной)")).toBeVisible();
    expect(screen.queryByText(/импорт истории mydon-stock/)).toBeNull();
  });

  it("импорт БЕЗ места назван «место не указано» — ни выдумки, ни технической строки донора", () => {
    // Раньше здесь печаталась сырая пометка целиком, и владелец читал в
    // заголовке имя чужого проекта. Выдумывать «Основной склад» по-прежнему
    // нельзя: донор место не сохранил, и лист говорит ровно это.
    render(
      <StockHistoryTables
        report={{
          ...ИСТОРИЯ,
          rows: [{ ...ИСТОРИЯ.rows[2]!, note: "импорт истории mydon-stock" }],
        }}
      />,
    );
    expect(screen.getByText("место не указано")).toBeVisible();
    expect(screen.queryByText(/mydon-stock/)).toBeNull();
  });

  it("ни одна подпись листа не печатает техническую строку: ни донора, ни литерала роли, ни ключа настройки", () => {
    // Сторож на весь рендер, а не на один заголовок: техническая строка
    // пролезает туда, куда её никто не звал, — в подпись группы, в пустое
    // состояние, в лид.
    const { container } = render(
      <StockHistoryTables
        report={{
          ...ИСТОРИЯ,
          rows: [
            { ...ИСТОРИЯ.rows[0]!, note: null },
            { ...ИСТОРИЯ.rows[1]! },
            { ...ИСТОРИЯ.rows[2]!, note: "импорт истории mydon-stock" },
            ИСТОРИЯ.rows[3]!,
          ],
        }}
      />,
    );
    const текст = container.textContent ?? "";
    for (const техническое of ["mydon-stock", "owner", "stock-import", "STOCK_COUNT", "REFILL_DETECT_MIN_UNITS"]) {
      expect(текст).not.toContain(техническое);
    }
  });

  it("заголовок группы носит класс, который globals.css стилизует ВНЕ `.row`", () => {
    // Голый `.t` объявлен только как `.row .t`: заголовок, стоящий НАД
    // карточкой `.rows`, получил бы от него ровно ничего — «Холодильник» и
    // «место» слиплись бы в строку неоформленного текста. jsdom CSS не
    // применяет, поэтому сторож утверждает про класс и про сам файл стилей.
    render(<StockHistoryTables report={ИСТОРИЯ} />);
    const подпись = screen.getByText("Холодильник").closest("div")!;
    expect(подпись.className).toBe("rcard-h");

    const css = readFileSync(join(process.cwd(), "src/app/globals.css"), "utf8");
    expect(css).toMatch(/^\.rcard-h\s*\{/m);
    expect(css).toMatch(/^\.rcard-h \.t\s*\{/m);
    expect(css).toMatch(/^\.rcard-h \.ts\s*\{/m);
    // Тот самый дефект, ради которого сторож и написан: правила для голого
    // `.t` в файле нет вовсе — значит выносить `.t` за пределы `.row` нельзя.
    expect(css).not.toMatch(/^\.t\s*\{/m);
  });

  it("подпись окна берёт `since` из ответа, а не пересчитывает его", () => {
    render(<StockHistoryTables report={ИСТОРИЯ} />);
    expect(screen.getByText(/Пересчёты склада за 90 дн\. · с 28\.05\.2026 · 4 строки/)).toBeVisible();
  });

  it("обрезанная история НЕ утверждает «с {since}»: лид называет хвост и его настоящую границу", () => {
    // При `history_capped` Core отдаёт свежие 2000 строк (`counted_at desc` +
    // потолок), и до первых суток окна показанное НЕ доходит. «с 28.05.2026»
    // наверху листа — прямая ложь, и предупреждение в самом хвосте её не
    // отменяет: шапку владелец читает первой.
    render(
      <StockHistoryTables
        report={{
          ...ИСТОРИЯ,
          days: 730,
          warnings: [
            { code: "history_capped", message: "Показаны первые 2000 строк истории — сузь окно или задай товар" },
          ],
        }}
      />,
    );
    const лид = screen.getByText(/Пересчёты склада за 730 дн\./);
    expect(лид.textContent).toContain("показаны последние 4 записи, с 01.06.2026");
    expect(лид.textContent).toContain("сузьте окно или задайте товар");
    expect(лид.textContent).not.toContain("с 28.05.2026");
  });

  it("боевая обрезка пришпилена ЧИСЛОМ ПОТОЛКА: 2000 строк, а не «сколько дала фикстура»", () => {
    // Правило писано ради `STOCK_COUNTS_MAX = 2000` (`vending.service.ts`), и
    // утверждение на четырёх строках проверяло бы форму, но не то число, из-за
    // которого шапка листа и начала врать. Фикстура строится ровно на потолок;
    // рендер для этого не нужен — лид считает чистая функция.
    const rows = Array.from({ length: 2000 }, (_, i) => ({
      ...ИСТОРИЯ.rows[0]!,
      // Самые свежие сверху, как их отдаёт Core (`counted_at desc`): самая
      // ранняя ПОКАЗАННАЯ строка — последняя, её дату лид и печатает.
      dt: i === 1999 ? "2026-03-12" : "2026-08-25",
    }));
    const лид = лидИстории({
      ...ИСТОРИЯ,
      days: 730,
      since: "2024-05-28",
      rows,
      warnings: [
        { code: "history_capped", message: "Показаны первые 2000 строк истории — сузь окно или задай товар" },
      ],
    });
    expect(лид).toBe(
      "Пересчёты склада за 730 дн. · показаны последние 2 000 записей, с 12.03.2026 — сузьте окно или задайте товар",
    );
  });

  it("необрезанный лид пришпилен целиком, вместе с фильтром по товару", () => {
    expect(лидИстории({ ...ИСТОРИЯ, product: "Snickers" })).toBe(
      "Пересчёты склада за 90 дн. · с 28.05.2026 · 4 строки · товар «Snickers»",
    );
  });

  it("обрезка названа В ЛИДЕ и не повторяется хвостом «Посчитано не всё»", () => {
    // Одну причину владелец читает один раз: раз лид уже сказал про обрезку в
    // том месте, где она меняет смысл шапки, хвост её дублировать не должен.
    render(
      <StockHistoryTables
        report={{
          ...ИСТОРИЯ,
          warnings: [
            { code: "history_capped", message: "Показаны первые 2000 строк истории — сузь окно или задай товар" },
          ],
        }}
      />,
    );
    expect(screen.queryByText(/Показаны первые 2000 строк/)).toBeNull();
  });

  it("ответ СТАРОГО Core без `since` не роняет лист: окно просто не подписано датой", () => {
    // `since` — новое обязательное поле ответа, а форма с провода никем не
    // валидируется: откат образа Core при живой панели дал бы `undefined.slice`
    // и 500 вместо листа.
    const безSince = { ...ИСТОРИЯ, since: undefined } as unknown as StockCountsReport;
    render(<StockHistoryTables report={безSince} />);
    const лид = screen.getByText(/Пересчёты склада за 90 дн\./);
    expect(лид.textContent).toContain("4 строки");
    expect(лид.textContent).not.toMatch(/· с /);
  });

  it("пустая история без фильтра называет ОКНО и путь наружу, а не «вы никогда не считали»", () => {
    // «Инвентаризаций за окно нет» звучало как приговор складу, хотя причина
    // обычно проще: последний счёт был раньше 90 дней, а кнопки окна стоят
    // прямо над этим блоком.
    render(<StockHistoryTables report={{ ...ИСТОРИЯ, rows: [] }} />);
    expect(screen.getByText("За 90 дн. инвентаризаций нет")).toBeVisible();
    expect(screen.getByText(/расширьте окно кнопками выше \(365 или 730 дн\.\)/)).toBeVisible();
    // Свои пересчёты попадают в историю не «всегда», а с появления таблицы:
    // счёт 25.08.2026 в неё уже не попал, и обещать его нельзя.
    expect(screen.getByText(/свои пересчёты копятся с 26\.08\.2026/)).toBeVisible();
  });

  it("на самом широком окне пустое состояние не советует расширять его дальше", () => {
    render(<StockHistoryTables report={{ ...ИСТОРИЯ, days: 730, rows: [] }} />);
    expect(screen.getByText("За 730 дн. инвентаризаций нет")).toBeVisible();
    expect(screen.queryByText(/расширьте окно/)).toBeNull();
  });

  it("`stock_missing` хвостом не показывается: лист покрыл его своим состоянием", () => {
    render(
      <StockHistoryTables
        report={{
          ...ИСТОРИЯ,
          rows: [],
          product: "Загадка",
          warnings: [{ code: "stock_missing", message: "Истории пересчётов по «Загадка» за окно нет" }],
        }}
      />,
    );
    expect(screen.queryByText(/Истории пересчётов по «Загадка»/)).toBeNull();
  });

  it("фильтр по товару достижим с листа: своя GET-форма, окно она сохраняет", async () => {
    // Без формы ветка «По этому товару истории нет» и весь смысл
    // `COVERED_BY_STOCK_HISTORY` включались бы только руками собранным адресом:
    // общего поля поиска у страницы отчётов нет — его рисуют книги.
    mocks.vendingStockCounts.mockResolvedValueOnce({ ...ИСТОРИЯ, days: 365, product: "Snickers" });
    render(await StockHistoryView({ domain: "vendhub", days: 365, q: "Snickers" }));
    const поле = screen.getByLabelText("Фильтр истории по товару");
    expect(поле).toHaveValue("Snickers");
    const форма = поле.closest("form")!;
    expect(форма.getAttribute("method")).toBe("get");
    expect(форма.getAttribute("action")).toBe("/domain/vendhub");
    expect(форма.querySelector<HTMLInputElement>('input[name="days"]')!.value).toBe("365");
    expect(форма.querySelector<HTMLInputElement>('input[name="tab"]')!.value).toBe("reports:stock_history");
  });

  it("длинный `?q=` обрезается по потолку DTO ядра, а не превращается в «Core недоступен» (S10)", async () => {
    // 400 от `@MaxLength(512)` панель показала бы как отказ ЯДРА — то есть
    // соврала бы про ядро там, где виноват адрес. Поле тоже знает потолок,
    // иначе форма отправила бы то, что ядро всё равно не примет.
    mocks.vendingStockCounts.mockResolvedValueOnce(ИСТОРИЯ);
    render(await StockHistoryView({ domain: "vendhub", days: 90, q: `  ${"Ф".repeat(600)}  ` }));
    const поле = screen.getByLabelText("Фильтр истории по товару");
    expect((поле as HTMLInputElement).value).toHaveLength(512);
    expect(поле.getAttribute("maxlength")).toBe("512");
    expect(mocks.vendingStockCounts).toHaveBeenCalledWith(90, "Ф".repeat(512));
  });

  it("Core не ответил — лист говорит это, а не рисует пустую историю", async () => {
    const { CoreUnavailable } = await import("../lib/core");
    mocks.vendingStockCounts.mockRejectedValueOnce(new CoreUnavailable("ECONNREFUSED"));
    render(await StockHistoryView({ domain: "vendhub", days: 90, q: "" }));
    expect(screen.getByText(/ECONNREFUSED/)).toBeVisible();
  });

  it("окна листа — те, что сервер отдаёт целиком: 730 — его потолок", () => {
    expect(STOCK_HISTORY_WINDOWS).toEqual([30, 90, 365, 730]);
  });
});

describe("навигация: лист «История склада»", () => {
  it("стоит в «Отчётах» сразу за «Приходом» и не гасится счётчиком реестра", () => {
    const reports = VENDHUB_GROUPS.find((g) => g.key === "reports");
    const i = reports!.leaves.findIndex((l) => l.type === "purchase");
    expect(reports!.leaves[i + 1]).toEqual({ label: "История склада", type: "stock_history" });
    // Считается на чтении (`/vending/stock-counts`), своих карточек реестра не
    // заводит — счёт по `byType` всегда 0, и чип бы погас.
    expect(isTableBackedLeaf("stock_history")).toBe(true);
  });
});
