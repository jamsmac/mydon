// @vitest-environment node
//
// Только чтение файлов, без DOM: под jsdom (общий environment пакета)
// `new URL(relative, import.meta.url)` резолвится от window.location
// (http://localhost:3000/…), а не от файла теста, и readFileSync падает
// ENOENT — тест не про рендер, ему рендер-окружение не нужно и мешает.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Сторож ПО ИСХОДНИКУ, а не по рендеру (R-H-3), тем же приёмом, что
 * `vending.controller.test.ts:15`.
 *
 * Три из пяти снек-листов — асинхронные серверные компоненты, ходящие в Core
 * (`SalesView`, `SupplyViews`, `VendingPanel`): отрендерить их в юните дороже,
 * чем прочитать файл, а утверждение всё равно про исходник — «снек-лист не
 * заводит своего форматтера чисел».
 *
 * Запрещены ровно две формы:
 *  · `toLocaleString("ru-RU")` БЕЗ второго аргумента — форматирование ЧИСЛА,
 *    оно и ставит U+00A0 между тройками разрядов;
 *  · вызов `money(` — она NBSP оставляет НАМЕРЕННО (докблок в `format.ts`).
 * Дата с опциями (`toLocaleString("ru-RU", { timeZone… })` в `vending-panel.tsx`)
 * под запрет НЕ попадает: разрядов там нет, и в списке правок R-H-3 этой
 * строки тоже нет.
 */
const СНЕК_ЛИСТЫ = [
  "shrinkage-view.tsx",
  "purchase-plan-view.tsx",
  "sales-view.tsx",
  "supply-views.tsx",
  "vending-panel.tsx",
] as const;

describe("Снек-листы не заводят своего форматтера чисел (R-H-3)", () => {
  for (const файл of СНЕК_ЛИСТЫ) {
    it(`${файл}: ни toLocaleString("ru-RU") для числа, ни money()`, () => {
      const код = readFileSync(new URL(`./${файл}`, import.meta.url), "utf8");
      expect(код).not.toMatch(/toLocaleString\("ru-RU"\)/);
      expect(код).not.toMatch(/\bmoney\(/);
    });
  }
});
