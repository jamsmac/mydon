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
  configured: boolean;
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
    return "Синк продаж не настроен на сервере (STOCK_DATABASE_URL) — цифр пока нет.";
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
