/**
 * Формулы UZS-договора купли-продажи — перенос из PROMACH (ContractModule.tsx)
 * ДОСЛОВНО, включая округления: НДС 12% считается «изнутри» суммы (×12/112),
 * рассрочка — равными долями или аннуитетом, округление — только на отображении.
 */

/** Позиция спецификации договора. */
export interface ContractItem {
  /** Карточка техники в реестре (entity type='equipment'). null — без привязки. */
  equipmentId?: string | null;
  name: string;
  unit?: string;
  qty: number;
  price: number;
}

/** Итоги договора: сумма с НДС, НДС «изнутри» (12/112), без НДС. */
export function contractTotals(items: readonly Pick<ContractItem, "qty" | "price">[]): {
  totalWithVat: number;
  totalVat: number;
  totalNoVat: number;
} {
  const totalWithVat = items.reduce((s, r) => s + (Number.isFinite(r.price) ? r.price : 0) * r.qty, 0);
  const totalVat = (totalWithVat * 12) / 112;
  return { totalWithVat, totalVat, totalNoVat: totalWithVat - totalVat };
}

/** Построчный расчёт для таблицы спецификации (DOCX §1). */
export function itemBreakdown(r: Pick<ContractItem, "qty" | "price">): {
  total: number;
  vat: number;
  noVat: number;
  unitNoVat: number;
} {
  const total = (Number.isFinite(r.price) ? r.price : 0) * r.qty;
  const vat = (total * 12) / 112;
  const noVat = total - vat;
  return { total, vat, noVat, unitNoVat: r.qty > 0 ? noVat / r.qty : 0 };
}

/** Платёж графика рассрочки. */
export interface InstallmentRow {
  /** Номер платежа с 1. */
  n: number;
  /** Дата платежа: первый + (n−1) месяцев. */
  due: Date;
  amount: number;
  interestPart: number;
  principalPart: number;
  /** Остаток тела после платежа. */
  balance: number;
}

/**
 * Рассрочка (донор, ContractModule.tsx:409–443): ставка 0 — равные платежи,
 * иначе аннуитет. Даты — от первой даты, шаг месяц (семантика setMonth).
 */
export function installmentSchedule(input: {
  totalWithVat: number;
  prepayPct: number;
  months: number;
  annualRatePct: number;
  firstDate: Date;
}): InstallmentRow[] {
  const principal = input.totalWithVat * (1 - input.prepayPct / 100);
  const months = input.months;
  if (months <= 0) return [];
  const r = input.annualRatePct / 100 / 12;
  const monthly =
    r > 0
      ? (principal * (r * Math.pow(1 + r, months))) / (Math.pow(1 + r, months) - 1)
      : principal / months;
  const rows: InstallmentRow[] = [];
  let balance = principal;
  for (let i = 0; i < months; i += 1) {
    const interestPart = balance * r;
    const principalPart = monthly - interestPart;
    balance = Math.max(0, balance - principalPart);
    const due = new Date(input.firstDate);
    due.setMonth(due.getMonth() + i);
    rows.push({ n: i + 1, due, amount: monthly, interestPart, principalPart, balance });
  }
  return rows;
}

/** Транш частичной оплаты: доля от суммы договора. */
export function trancheAmount(totalWithVat: number, pct: number): number {
  return (totalWithVat * pct) / 100;
}

/**
 * Платёжный бейдж договора (донор, ContractModule.tsx:1256). paid и total —
 * В ОДНОЙ валюте (сумовой эквивалент): донор складывал сырые числа разных
 * валют — этот баг при переносе исправлен, сюда приходят уже приведённые суммы.
 */
export function paymentBadge(paid: number, total: number): string {
  if (total <= 0) return "—";
  if (paid <= 0) return "Не оплачен";
  if (paid >= total) return "100% оплачен";
  return `Частично (${Math.round((paid / total) * 100)}%)`;
}

/** «1 234 567,89» — формат сумм документа (округление только на отображении). */
export function fmtMoney(n: number): string {
  return n.toLocaleString("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Целое с разделителями: «100». */
export function fmtInt(n: number): string {
  return Math.round(n).toLocaleString("ru-RU");
}
