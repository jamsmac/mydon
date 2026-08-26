import { describe, expect, it } from "vitest";
import { причинаБезПродаж, чипИсточникаПродаж } from "./sales-source";

describe("Почему в журнале продаж пусто — по действующему источнику (M2)", () => {
  it("режим own — чинить агента, а не заводить удалённую переменную", () => {
    // После шага 3 рунбука катовера `STOCK_DATABASE_URL` УДАЛЕНА: совет её
    // настроить отправляет владельца ровно туда, откуда он только что ушёл.
    const t = причинаБезПродаж("own");
    expect(t).toMatch(/ourvend:accounting/);
    expect(t).toMatch(/снапшота за сутки нет/);
    expect(t).not.toMatch(/STOCK_DATABASE_URL/);
  });

  it("режим stock и «режим не назван» — прежний текст про зеркало", () => {
    expect(причинаБезПродаж("stock")).toMatch(/STOCK_DATABASE_URL/);
    expect(причинаБезПродаж()).toMatch(/STOCK_DATABASE_URL/);
  });

  it("чип: «снапшот не пришёл» в own, «не настроен» в stock, «настроен» когда читаем", () => {
    expect(чипИсточникаПродаж(false, "own")).toBe("снапшот не пришёл");
    expect(чипИсточникаПродаж(false, "stock")).toBe("не настроен");
    expect(чипИсточникаПродаж(false)).toBe("не настроен");
    expect(чипИсточникаПродаж(true, "own")).toBe("источник настроен");
  });
});
