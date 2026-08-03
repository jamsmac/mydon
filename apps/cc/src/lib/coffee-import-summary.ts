/**
 * Сводка payload'а исторического импорта кофе для карточки согласования.
 *
 * Импорт из Telegram приносит одно согласование на тысячи строк — по одному
 * заголовку «Занести … N заливок» владелец не видит, ЧТО именно попадёт в
 * учёт. Здесь payload сжимается до решаемого: сколько, за какие даты, по
 * каким точкам. Считается на сервере — сам payload в браузер не едет.
 */

export interface CoffeeImportPart {
  /** «Заливки», «Возвраты наборов», «Расходники». */
  label: string;
  count: number;
  /** Диапазон дат ISO (YYYY-MM-DD); null — дат в строках не оказалось. */
  from: string | null;
  to: string | null;
  /** Короткие пояснения: топ точек, число наборов и т.п. */
  notes: string[];
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function dateRange(dates: unknown[]): { from: string | null; to: string | null } {
  const valid = dates.filter((d): d is string => typeof d === "string" && ISO_DATE.test(d)).sort();
  return { from: valid[0] ?? null, to: valid[valid.length - 1] ?? null };
}

/** Топ по частоте: «Кпп ×123 · АХ ×98 · …» (не больше limit имён). */
function topCounts(names: (string | null)[], limit: number): string[] {
  const byName = new Map<string, number>();
  for (const n of names) {
    const key = n ?? "точка не определена";
    byName.set(key, (byName.get(key) ?? 0) + 1);
  }
  return [...byName.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([name, n]) => `${name} ×${n}`);
}

/**
 * null — это не импорт кофе (обычное согласование, сводка не нужна).
 * Пустые массивы не показываем: часть «0 строк» решению не помогает.
 */
export function summarizeCoffeeImport(
  payload: unknown,
  locationName: (id: string) => string | null,
): CoffeeImportPart[] | null {
  if (typeof payload !== "object" || payload === null) return null;
  const imp = (payload as Record<string, unknown>)["coffeeImport"];
  if (typeof imp !== "object" || imp === null) return null;
  const { records, returns, consumables } = imp as Record<string, unknown>;

  const parts: CoffeeImportPart[] = [];

  if (Array.isArray(records) && records.length > 0) {
    const rows = records as Record<string, unknown>[];
    parts.push({
      label: "Заливки",
      count: rows.length,
      ...dateRange(rows.map((r) => r["enteredDate"])),
      notes: topCounts(
        rows.map((r) => (typeof r["locationId"] === "string" ? locationName(r["locationId"]) : null)),
        6,
      ),
    });
  }

  if (Array.isArray(returns) && returns.length > 0) {
    const rows = returns as Record<string, unknown>[];
    const containers = new Set(
      rows.map((r) => r["containerNumber"]).filter((n) => Number.isInteger(n)),
    );
    parts.push({
      label: "Возвраты наборов",
      count: rows.length,
      ...dateRange(rows.map((r) => r["returnedDate"])),
      notes: containers.size > 0 ? [`разных наборов: ${containers.size}`] : [],
    });
  }

  if (Array.isArray(consumables) && consumables.length > 0) {
    const rows = consumables as Record<string, unknown>[];
    parts.push({
      label: "Расходники (вода · стаканчики · крышки)",
      count: rows.length,
      ...dateRange(rows.map((r) => r["loggedDate"])),
      notes: topCounts(
        rows.map((r) => (typeof r["locationId"] === "string" ? locationName(r["locationId"]) : null)),
        6,
      ),
    });
  }

  return parts.length > 0 ? parts : null;
}
