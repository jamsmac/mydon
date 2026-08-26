/**
 * Продажи автоматов — быстрый ответ владельцу в Telegram.
 *
 * «продажи» / «выручка» отвечались общим LLM-разбором с приблизительным
 * ответом; теперь — детерминированно и мгновенно из /sales/summary
 * (те же цифры, что на дашборде VendHub, источник — синк OurVend).
 */

export interface SalesSummary {
  today: { qty: number; amount: number };
  yesterday: { qty: number; amount: number };
  days30: { qty: number; amount: number };
  lastSaleDt: string | null;
  /**
   * ИСТОЧНИК ЧИТАЕМ — не «переменная задана» (переопределено в П8b).
   * В режиме `stock` это «`STOCK_DATABASE_URL` задан», в режиме `own` —
   * «учётный снапшот свежий». Одно поле, два разных отказа: что именно
   * чинить, говорит `source`.
   */
  configured: boolean;
  /**
   * Действующий источник учёта (`OURVEND_ACCOUNTING_SOURCE` с учётом фолбэка).
   *
   * НЕОБЯЗАТЕЛЬНОЕ: Core прошлой сборки поля не шлёт, и «неизвестно» здесь —
   * это `stock`, каким режим и был. Нужно оно ровно для одного: не звать
   * владельца настраивать `STOCK_DATABASE_URL` после шага 3 рунбука, который
   * эту переменную УДАЛЯЕТ.
   */
  source?: "stock" | "own";
}

/** Вопрос о продажах/выручке. Слова-намерения без глаголов действия. */
export function isSalesQuery(text: string): boolean {
  const t = text.trim().toLowerCase();
  // «оформить закуп»/«касса закупа» перехватываются раньше по цепочке —
  // здесь только чтение. \b с кириллицей в JS не работает — без него.
  return /^(продажи|выручка)/.test(t) || /сколько (продали|выручк)/.test(t);
}

const num = (n: number) => Math.round(n).toLocaleString("ru-RU");

export function formatSalesSummary(s: SalesSummary): string {
  if (!s.configured && s.lastSaleDt === null) {
    // В режиме `own` зеркала нет и не должно быть: продажи приносит агент
    // `ourvend:accounting` своим снапшотом. Совет «настрой STOCK_DATABASE_URL»
    // там отправляет владельца заводить переменную, которую шаг 3 рунбука
    // катовера как раз удалил (M2 финального ревью).
    return s.source === "own"
      ? "Учёт ведёт агент ourvend:accounting — снапшота за сутки нет, цифр пока нет."
      : "Синк продаж не настроен на сервере (STOCK_DATABASE_URL) — цифр пока нет.";
  }
  if (s.lastSaleDt === null) {
    return "Продаж в журнале пока нет — синк настроен, но данных ещё не приносил.";
  }
  return [
    "💰 Продажи автоматов:",
    "",
    `Сегодня: ${num(s.today.amount)} сум · ${num(s.today.qty)} шт`,
    `Вчера: ${num(s.yesterday.amount)} сум · ${num(s.yesterday.qty)} шт`,
    `30 дней: ${num(s.days30.amount)} сум · ${num(s.days30.qty)} шт`,
    "",
    `Последняя продажа в журнале: ${s.lastSaleDt}`,
  ].join("\n");
}
