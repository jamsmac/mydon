/**
 * Деньги в автоматах — сумма наличных продаж строго после последней принятой инкассации.
 *
 * ЗАЧЕМ ОТДЕЛЬНЫМ МОДУЛЕМ. Остаток средств в аппаратах и в хранилище — две
 * стороны одной транзакции. На дашборде они идут в разные коробки, но считаются
 * по одному правилу: инкассация разделяет хронологию на «было собрано» и «накоплено
 * после сбора». Если правило разойтётся — статистика и действительность перестанут
 * совпадать, и разобраться, какая из цифр верна, станет невозможно.
 *
 * ОКНО ВРЕМЕНИ. По каждому автомату: если инкассации были, берём ПОСЛЕДНЮЮ; если нет,
 * окно открывается от первой продажи (since: null). Не-наличные продажи не считаются.
 */

export interface CashSale {
  machineId: string;
  ts: string;
  amount: number;
  cash: boolean;
}

export interface ReceivedCollection {
  machineId: string;
  receivedAt: string;
}

export interface MachineCash {
  machineId: string;
  amount: number;
  since: string | null;
}

export function cashInMachines(
  sales: readonly CashSale[],
  received: readonly ReceivedCollection[],
): { total: number; perMachine: MachineCash[] } {
  const посл = new Map<string, string>();
  for (const c of received) {
    const прежняя = посл.get(c.machineId);
    if (!прежняя || c.receivedAt > прежняя) посл.set(c.machineId, c.receivedAt);
  }
  const сумма = new Map<string, number>();
  for (const s of sales) {
    if (!s.cash) continue;
    const с = посл.get(s.machineId);
    if (с && s.ts <= с) continue;
    сумма.set(s.machineId, (сумма.get(s.machineId) ?? 0) + s.amount);
  }
  const perMachine = [...сумма.entries()]
    .map(([machineId, amount]) => ({ machineId, amount, since: посл.get(machineId) ?? null }))
    .sort((a, b) => b.amount - a.amount);
  return { total: perMachine.reduce((t, m) => t + m.amount, 0), perMachine };
}
