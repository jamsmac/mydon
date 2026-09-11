import type { MachineKind } from "./catalog-kinds";
import { INVENTORY_NO_PATTERN, normalizeInventoryNo } from "./parts";

/**
 * Инвентарный номер автомата (волна 3, М-6…М-8, М-12).
 *
 * У автомата два номера, и они разные по смыслу (М-6): серийник — заводской,
 * чужой, по нему сходится выгрузка Ourvend; инвентарный — наш, с буквой вида.
 * Приём — тот же, что у узлов (`parts.ts`, М-6а): нормализация, формат серии,
 * следующий свободный. Отличается только словарь серий.
 *
 * Серии (М-8): `K-001` кофейный, `S-001` снек, `D-001` напитки, `C-001` комбо;
 * вид «прочее» номера не получает. Одна латинская буква — как у узлов. С
 * сериями узлов не сталкивается — это держит тест; ради этого узловые `S`
 * (датчик) и `D` (дисплей) переименованы в `SR` и `DP`, пока их никто не
 * наклеил.
 *
 * Латинские K и C похожи на кириллические К и С. Кириллицу
 * `INVENTORY_NO_PATTERN` (только A–Z и цифры) отвергает с ошибкой, а не
 * принимает молча: громкий отказ дешевле нечитаемой буквы на наклейке.
 */
export const MACHINE_SERIES: Partial<Record<MachineKind, string>> = {
  coffee: "K",
  snack: "S",
  drink: "D",
  combo: "C",
};

/** Ширина числа: `K-001`…`K-999`, дальше — `K-1000` (как у узлов). */
const SERIES_WIDTH = 3;

export function machineSeriesOf(kind: string | null | undefined): string | null {
  return (MACHINE_SERIES as Record<string, string | undefined>)[kind ?? ""] ?? null;
}

export function formatMachineNo(kind: MachineKind, n: number): string | null {
  const series = machineSeriesOf(kind);
  return series ? `${series}-${String(n).padStart(SERIES_WIDTH, "0")}` : null;
}

/** Порядковый номер в серии вида (`K-014` → 14); не своя серия — null. */
export function machineSeriesNumber(kind: string, no: string): number | null {
  const series = machineSeriesOf(kind);
  const norm = normalizeInventoryNo(no);
  if (!series || !norm) return null;
  const m = new RegExp(`^${series}-(\\d{1,6})$`).exec(norm);
  return m ? Number(m[1]) : null;
}

/**
 * Проверка номера, который вписал человек: латиница, цифры, дефис — и серия
 * своего вида. «S-003» у кофейного автомата — ошибка, а не другой номер.
 */
export function machineNoProblem(kind: string, raw: string): string | null {
  const norm = normalizeInventoryNo(raw);
  if (!norm || !INVENTORY_NO_PATTERN.test(norm)) {
    return "Номер — латиница, цифры и дефис, например K-014 (кириллические К и С не подходят)";
  }
  const series = machineSeriesOf(kind);
  if (!series) return "Автомату вида «прочее» номер не присваивается";
  if (machineSeriesNumber(kind, norm) === null) return `Номер этого вида — серии ${series}: ${series}-001, ${series}-002…`;
  return null;
}

/**
 * Каноническая форма номера: `k-14` → `K-014`. У узлов «M-77» допустим как есть
 * (наклейки на деталях существовали раньше системы), у автоматов наклеек до
 * системы нет — и «K-14» рядом с «K-014» были бы двумя строками с одним
 * смыслом: уникальный индекс их не поймал бы, а у двух автоматов оказался бы
 * «номер 14». Поэтому номер автомата всегда хранится в одной форме.
 */
export function canonicalMachineNo(kind: string, raw: string): string | null {
  const series = machineSeriesOf(kind);
  const n = machineSeriesNumber(kind, raw);
  return series && n !== null ? `${series}-${String(n).padStart(SERIES_WIDTH, "0")}` : null;
}

/** Следующий свободный: максимум занятых + 1, дыры не переиспользуем (наклейка могла остаться). */
export function suggestMachineNo(kind: MachineKind, taken: readonly string[]): string | null {
  let max = 0;
  for (const t of taken) {
    const n = machineSeriesNumber(kind, t);
    if (n !== null && n > max) max = n;
  }
  return formatMachineNo(kind, max + 1);
}

export interface NumberingMachine {
  id: string;
  kind: string | null;
  /** Когда заведена карточка — первый ключ порядка (М-12). */
  createdAt: string;
  /** Серийник — второй ключ, при совпадении даты. */
  serial: string | null;
  inventoryNo: string | null;
}

/**
 * Первоначальное присвоение (М-12): всем без номера, по виду; порядок — по
 * дате заведения карточки, при совпадении — по серийнику. Уже занятые номера
 * не трогаем и продолжаем после них: номер, который человек подтвердил на
 * наклейке, важнее красоты подряд идущей серии.
 */
export function planMachineNumbers(machines: readonly NumberingMachine[]): { id: string; inventoryNo: string }[] {
  const taken = new Map<string, string[]>();
  for (const m of machines) {
    if (m.inventoryNo && m.kind) taken.set(m.kind, [...(taken.get(m.kind) ?? []), m.inventoryNo]);
  }
  const pending = machines
    .filter((m) => m.inventoryNo === null && machineSeriesOf(m.kind) !== null)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || (a.serial ?? "").localeCompare(b.serial ?? "") || a.id.localeCompare(b.id));
  const out: { id: string; inventoryNo: string }[] = [];
  for (const m of pending) {
    const kind = m.kind as MachineKind;
    const no = suggestMachineNo(kind, taken.get(kind) ?? []);
    if (!no) continue;
    out.push({ id: m.id, inventoryNo: no });
    taken.set(kind, [...(taken.get(kind) ?? []), no]);
  }
  return out;
}

/**
 * Имя автомата на показ (М-12): `K-014 · CardioLife`, вторая часть — место из
 * «Где стоит», обновляется при переезде. Имя карточки не переписывается: оно
 * уже врёт (автомат «KARDIO Life» с 08.09 стоит на точке CardioLife). Нет
 * номера — имя карточки, как было; нет места — только номер.
 */
export function machineDisplayName(m: { name: string; inventoryNo: string | null }, placeName: string | null): string {
  if (!m.inventoryNo) return m.name;
  return placeName ? `${m.inventoryNo} · ${placeName}` : m.inventoryNo;
}
