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
import type { VendingStockAdjustment } from "./core-client";

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

const RU = (n: number): string => Math.round(n).toLocaleString("ru-RU");

/** Сколько строк расхождения показывать в одном блоке — остальное «…и ещё N». */
const MAX_ADJUSTMENT_LINES = 20;

/** Одна строка блока недостачи/излишка. */
function adjustmentLine(a: VendingStockAdjustment, sign: string): string {
  const val = a.noPrice ? "" : ` · ~${RU(a.value)} сум`;
  return `• ${a.product}: было ${a.before} → стало ${a.after} (${sign}${Math.abs(a.delta)}${val})`;
}

/**
 * Подтверждение: что именно записали (и на сколько позиций), плюс расхождение
 * с предыдущим пересчётом — недостача и излишек отдельными блоками, как
 * реальный лист владельца («было 55 → стало 54»). Одно и то же число не может
 * быть одновременно недостачей и излишком — сортируем по знаку delta один раз.
 *
 * Оба блока (как и список позиций выше) режутся до MAX_ADJUSTMENT_LINES:
 * Core допускает до 5000 позиций за раз, и без среза полный пересчёт легко
 * пробил бы лимит Telegram в 4096 символов — сообщение не дошло бы вовсе
 * (найдено адверсариал-ревью).
 */
export function formatStockAck(items: StockItem[], adjustments: VendingStockAdjustment[] = []): string {
  const lines = items.slice(0, 20).map((i) => `• ${i.product}: ${i.quantity}`);
  if (items.length > 20) lines.push(`…и ещё ${items.length - 20}`);
  const out = [`📦 Склад обновлён (${items.length} поз.):`, "", ...lines];

  const losses = adjustments.filter((a) => a.delta < 0);
  const surplus = adjustments.filter((a) => a.delta > 0);

  if (losses.length > 0) {
    out.push("", "📉 Недостача при пересчёте:");
    out.push(...losses.slice(0, MAX_ADJUSTMENT_LINES).map((a) => adjustmentLine(a, "−")));
    if (losses.length > MAX_ADJUSTMENT_LINES) out.push(`…и ещё ${losses.length - MAX_ADJUSTMENT_LINES}`);
  }
  if (surplus.length > 0) {
    out.push("", "📈 Излишек при пересчёте:");
    out.push(...surplus.slice(0, MAX_ADJUSTMENT_LINES).map((a) => adjustmentLine(a, "+")));
    if (surplus.length > MAX_ADJUSTMENT_LINES) out.push(`…и ещё ${surplus.length - MAX_ADJUSTMENT_LINES}`);
  }

  out.push("", "«что заказать» — пересчитать закуп.");
  return out.join("\n");
}
