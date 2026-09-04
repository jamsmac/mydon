/**
 * Остаток сырья на складе: сумма движений на чтении.
 *
 * Тот же приём, что у себестоимости рецепта: не держим мутабельное поле
 * остатка, а выводим его из ленты движений при запросе. У донора кэш остатка
 * расходился с движениями — здесь расходиться нечему.
 *
 * Движения бывают в разных единицах той же размерности (приход в «кг», расход
 * по рецепту в «г»): приводим к базовой единице ингредиента. Несводимую единицу
 * не обнуляем молча — считаем её непосчитанной, и остаток честно неполон.
 */
import { convertQty, type Unit } from "./recipe";

/** Вид движения склада. `return` — возврат остатка со снятого бункера (+), нетто по взвешиванию (R-PU-9). */
export type StockMovementKind = "intake" | "consumption" | "transfer" | "adjustment" | "return";

/** Одно движение склада для подсчёта остатка. */
export interface StockMovement {
  kind: StockMovementKind;
  /** Склад, откуда/куда движение. */
  warehouseId: string;
  /** Встречный склад перемещения (куда легло). */
  counterpartyId?: string | null;
  /**
   * Количество. У прихода/расхода/перемещения — всегда положительное, знак
   * задаёт вид. У корректировки инвентаризации (`adjustment`) — подписанная
   * дельта «стало − было»: может быть отрицательной (недостача) или
   * положительной (излишек).
   */
  qty: number;
  unit: Unit;
}

/** Остаток по одному складу (или сводный, если склад не задан). */
export interface StockBalance {
  /** Остаток в базовой единице. */
  qty: number;
  unit: Unit;
  /** Движений, которые не удалось привести к базовой единице. */
  unconvertible: number;
}

/**
 * Вклад одного движения в остаток на складе `warehouseId`.
 *
 * Приход прибавляет, расход убавляет. Перемещение убавляет со склада-источника
 * и прибавляет на встречный: если смотрим на конкретный склад — учитываем ту
 * сторону, что его касается; в сводном остатке (по всем складам) перемещение
 * само себя гасит.
 */
function signedFor(m: StockMovement, warehouseId: string | null, converted: number): number {
  if (m.kind === "intake" || m.kind === "return") {
    // Возврат остатка из бункера — тот же приход на свой склад.
    return warehouseId === null || m.warehouseId === warehouseId ? converted : 0;
  }
  if (m.kind === "consumption") {
    return warehouseId === null || m.warehouseId === warehouseId ? -converted : 0;
  }
  if (m.kind === "adjustment") {
    // Корректировка инвентаризации привязана к своему складу; `converted` уже
    // несёт знак (дельта «стало − было» могла быть отрицательной), поэтому
    // добавляем её как есть, без внешнего знака.
    return warehouseId === null || m.warehouseId === warehouseId ? converted : 0;
  }
  // transfer
  if (warehouseId === null) return 0; // в сводном остатке перемещение нейтрально
  if (m.warehouseId === warehouseId) return -converted;
  if (m.counterpartyId === warehouseId) return converted;
  return 0;
}

/**
 * Остаток ингредиента в базовой единице `base`.
 *
 * `warehouseId = null` — сводный остаток по всем складам; иначе только по
 * указанному. Единицу каждого движения приводим к `base`; несводимое —
 * непосчитано, остаток честно неполон.
 */
export function stockBalance(
  movements: readonly StockMovement[],
  base: Unit,
  warehouseId: string | null = null,
): StockBalance {
  let qty = 0;
  let unconvertible = 0;
  for (const m of movements) {
    const converted = convertQty(m.qty, m.unit, base);
    if (converted === null) {
      // Учитываем непосчитанным только если движение вообще касается этого склада.
      if (
        warehouseId === null ||
        m.warehouseId === warehouseId ||
        m.counterpartyId === warehouseId
      ) {
        unconvertible += 1;
      }
      continue;
    }
    qty += signedFor(m, warehouseId, converted);
  }
  return { qty, unit: base, unconvertible };
}
