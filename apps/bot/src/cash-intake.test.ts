import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { VendingCashSession } from "./core-client";
import {
  formatCashAck,
  formatCashSessions,
  isCashCommand,
  isCashHistoryQuery,
  isCashPrefixed,
  parseCashSession,
} from "./cash-intake";
import { isPurchaseReceiveCommand } from "./purchase-brief";

describe("Касса закупа: разбор команды (§5.8)", () => {
  it("воспроизводит реальную запись 02.08.2026: получил + три статьи", () => {
    const session = parseCashSession(
      "касса закупа: получил 2400000, корзинка 98230, базар 376300, базар 1023000",
    );
    assert.ok(session);
    assert.equal(session!.receivedAmount, 2_400_000);
    assert.deepEqual(session!.categories, [
      { name: "корзинка", amount: 98_230 },
      { name: "базар", amount: 376_300 },
      { name: "базар", amount: 1_023_000 },
    ]);
  });

  it("принимает переводы строк вместо запятых", () => {
    const session = parseCashSession("касса закупа\nполучил 100000\nбазар 30000");
    assert.deepEqual(session, { receivedAmount: 100_000, categories: [{ name: "базар", amount: 30_000 }] });
  });

  it("без «получил» — не сессия (нечего записывать как полученное)", () => {
    assert.equal(parseCashSession("касса закупа: базар 30000"), null);
  });

  it("без статей — не сессия (только получил, потратить некуда)", () => {
    assert.equal(parseCashSession("касса закупа: получил 100000"), null);
  });

  it("повторное «получил» — весь разбор отклоняется, а не тихо берёт последнее (регресс)", () => {
    // Раньше второе «получил» молча побеждало первое — реальная полученная
    // сумма терялась без единого сообщения владельцу (найдено адверсариал-ревью).
    assert.equal(parseCashSession("касса закупа: получил 2400000, базар 300000, получил 500000"), null);
  });

  it("безымянное число не подменяет собой «получил» — просто пропускается (регресс)", () => {
    // «100000» без названия статьи раньше трактовалось как ещё одно «получил»
    // (label==="" совпадал с тем же условием) и тихо перезаписывало 2400000.
    // Теперь непонятный хвост отбрасывается, а верно введённое — сохраняется
    // (тот же приём, что и у parseStockItems в stock-intake.ts).
    const session = parseCashSession("касса закупа: получил 2400000, база 300000, 100000");
    assert.deepEqual(session, { receivedAmount: 2_400_000, categories: [{ name: "база", amount: 300_000 }] });
  });

  it("isCashPrefixed: только префикс, без требования валидного разбора", () => {
    assert.equal(isCashPrefixed("касса закупа: получил 100000, базар 30000"), true);
    assert.equal(isCashPrefixed("касса закупа: получил 100000"), true); // без статьи — префикс всё равно есть
    assert.equal(isCashPrefixed("касса-закупа: получил 100000, базар 30000"), true); // дефис допустим
    assert.equal(isCashPrefixed("касса"), false); // без «закупа»
    assert.equal(isCashPrefixed("кассы закупа"), false); // множественное число — не префикс команды
    assert.equal(isCashPrefixed("оформить закуп"), false);
  });

  it("isCashCommand: полная команда — да, чужая фраза — нет", () => {
    assert.equal(isCashCommand("касса закупа: получил 100000, базар 30000"), true);
    assert.equal(isCashCommand("касса"), false); // без «закупа» — не наша команда
    assert.equal(isCashCommand("что заказать"), false);
    assert.equal(isCashCommand("склад Montella 24"), false);
  });

  it("НЕ путается с приёмкой накладной, хотя содержит «получил» и «закуп»", () => {
    // Ключевая проверка: у обеих команд общие слова — без явного порядка в
    // handler.ts «касса закупа: получил…» ушла бы в «принять закуп».
    const text = "касса закупа: получил 2400000, базар 376300";
    assert.equal(isCashCommand(text), true);
    assert.equal(isPurchaseReceiveCommand(text), true); // да, тоже сработает — поэтому гейт в handler.ts именно isCashPrefixed
  });
});

describe("Касса закупа: подтверждение и история", () => {
  const session = (o: Partial<VendingCashSession> = {}): VendingCashSession => ({
    id: "cs1",
    receivedAmount: 2_400_000,
    categories: [
      { name: "корзинка", lines: [{ label: "корзинка", amount: 98_230 }], subtotal: 98_230 },
      { name: "базар", lines: [{ label: "базар", amount: 376_300 }], subtotal: 376_300 },
      { name: "базар", lines: [{ label: "базар", amount: 1_023_000 }], subtotal: 1_023_000 },
    ],
    totalSpent: 1_497_530,
    remainder: 902_470,
    createdBy: "owner",
    createdAt: "2026-08-02T12:00:00Z",
    ...o,
  });

  it("подтверждение перечисляет статьи и остаток (реальные цифры)", () => {
    const t = formatCashAck(session());
    assert.match(t, /Получил: 2\s?400\s?000 сум/);
    assert.match(t, /корзинка: 98\s?230 сум/);
    assert.match(t, /Потрачено: 1\s?497\s?530 сум/);
    assert.match(t, /Остаток: 902\s?470 сум/);
    assert.doesNotMatch(t, /Потратил больше/);
  });

  it("перерасход — предупреждение, не молчим", () => {
    const t = formatCashAck(session({ receivedAmount: 100_000, totalSpent: 150_000, remainder: -50_000 }));
    assert.match(t, /Остаток: -50\s?000 сум/); // toLocaleString даёт обычный дефис, не спецсимвол минуса
    assert.match(t, /Потрачено больше, чем получил/);
  });

  it("isCashHistoryQuery распознаёт запрос истории (в т.ч. фразу из HELP) и не пересекается с «накладные»", () => {
    assert.equal(isCashHistoryQuery("история кассы"), true);
    assert.equal(isCashHistoryQuery("кассы закупа"), true); // фраза из HELP — раньше не ловилась (регресс)
    assert.equal(isCashHistoryQuery("прошлые кассы"), true);
    assert.equal(isCashHistoryQuery("накладные"), false);
    assert.equal(isCashHistoryQuery("оформить закуп"), false);
  });

  it("пустая история — подсказывает формат ввода", () => {
    assert.match(formatCashSessions([]), /пока нет/);
  });

  it("список показывает получено/потрачено/остаток по каждой кассе", () => {
    const t = formatCashSessions([session(), session({ id: "cs2", receivedAmount: 100_000, totalSpent: 40_000, remainder: 60_000 })]);
    assert.match(t, /получил 2\s?400\s?000, потратил 1\s?497\s?530, остаток 902\s?470/);
    assert.match(t, /получил 100\s?000, потратил 40\s?000, остаток 60\s?000/);
  });
});
