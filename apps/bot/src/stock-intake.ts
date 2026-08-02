/**
 * Ввод остатков склада вендинга владельцем прямо в Telegram (§5.4).
 *
 * Фаза 3 дала расчёт закупа с учётом склада, но склад надо чем-то наполнять.
 * Здесь — короткая команда основного канала: «склад Montella 24, Fanta 12».
 * Владелец (или менеджер) вводит пересчёт списком — бот перезаписывает остаток,
 * и брифинг «что заказать» сразу считает честную нехватку.
 *
 * Разбор детерминированный и тестируется без сети: команда → пары «товар N».
 */

export interface StockItem {
  product: string;
  quantity: number;
}

/**
 * Команда начинается словом склад/остаток(и)/приход, дальше — пары.
 * Граница — lookahead, а не `\b`: в JS-regex `\b` не срабатывает после
 * кириллицы (она не входит в `\w`), поэтому «складской» отсекаем явно.
 */
const PREFIX = /^(склад|остатки|остаток|приход)(?=$|[\s:.\-—])[\s:.\-—]*/i;

/**
 * Похоже ли на команду ввода остатков: префикс И хотя бы одно число дальше.
 * Без числа («остаток Montella?») — это вопрос, а не ввод: пропускаем в общий
 * разбор, чтобы не перехватывать чтение.
 */
export function isStockCommand(text: string): boolean {
  const t = text.trim();
  if (!PREFIX.test(t)) return false;
  return parseStockItems(t).length > 0;
}

/**
 * Разбор пар «товар количество». Разделители позиций — перевод строки,
 * запятая, точка с запятой. Внутри позиции количество — последнее целое число,
 * имя — всё до него (допускаем «Montella - 24», «Кола 12»). Дробное и
 * отрицательное количество для штучного склада не принимаем.
 */
export function parseStockItems(raw: string): StockItem[] {
  const body = raw.trim().replace(PREFIX, "");
  const out: StockItem[] = [];
  for (const chunk of body.split(/[,;\n]+/)) {
    const part = chunk.trim();
    if (!part) continue;
    // Количество — последнее целое число позиции; имя — всё до него.
    const m = /^(.*?)[\s:.\-—=]*(\d+)\s*(?:шт\.?|ед\.?)?$/i.exec(part);
    if (!m) continue;
    const product = m[1].trim().replace(/[«»"']/g, "");
    const quantity = Number(m[2]);
    if (!product || !Number.isInteger(quantity) || quantity < 0) continue;
    out.push({ product, quantity });
  }
  return out;
}

/** Подтверждение: что именно записали (и на сколько позиций). */
export function formatStockAck(items: StockItem[]): string {
  const lines = items.slice(0, 20).map((i) => `• ${i.product}: ${i.quantity}`);
  if (items.length > 20) lines.push(`…и ещё ${items.length - 20}`);
  return [`📦 Склад обновлён (${items.length} поз.):`, "", ...lines, "", "«что заказать» — пересчитать закуп."].join("\n");
}
