/**
 * Место и его контрагент, слияние карточек мест (волна 2б, М-1…М-3, М-9…М-11).
 */

/** Виды карточек, которые могут быть «владельцем помещения» (М-2, М-11). */
export const PLACE_OWNER_TYPES = ["contractor", "own_company"] as const;

export function isPlaceOwnerType(type: string | null | undefined): boolean {
  return (PLACE_OWNER_TYPES as readonly string[]).includes(type ?? "");
}

/**
 * Полное имя места на показ (М-3): имя места короткое в пределах контрагента
 * («4 корпус»), полное собирается — «Центр кардиологии · 4 корпус». Без
 * контрагента — просто имя: пустота значит «не знаем, чьё помещение», и
 * выдумывать владельца на показ нельзя.
 */
export function placeFullName(placeName: string, contractorName: string | null | undefined): string {
  const c = (contractorName ?? "").trim();
  return c.length > 0 ? `${c} · ${placeName}` : placeName;
}

/**
 * Пометки слитой карточки в attrs (М-9: вторая карточка закрывается с пометкой
 * «слита в …»). «выключена» — существующий признак закрытой кофе-точки: бот и
 * вкладка кофе уже прячут такие места, новый признак пришлось бы учить всех.
 */
export const MERGE_ATTR = {
  mergedInto: "слита в",
  mergedOn: "слита",
  disabled: "выключена",
} as const;

/** Карточка места слита в другую — её не показывают в выборе мест и на карте. */
export function isMergedPlace(attrs: Record<string, unknown> | null | undefined): boolean {
  const v = attrs?.[MERGE_ATTR.mergedInto];
  return typeof v === "string" && v.length > 0;
}

/**
 * Основание слияния (М-9, М-10). Сливать можно только по ПОДТВЕРЖДЁННОМУ
 * совпадению самого места. Совпадение адреса основанием НЕ является: у KIUT
 * четыре места по одному адресу — наивное «один адрес — одно место» схлопнуло
 * бы их в одно. Поэтому «адреса» в списке нет вовсе.
 */
export const MERGE_BASES = ["serial", "field_check", "owner_word"] as const;
export type MergeBasis = (typeof MERGE_BASES)[number];

export const MERGE_BASIS_LABELS: Record<MergeBasis, string> = {
  serial: "один и тот же автомат (серийник)",
  field_check: "полевая проверка",
  owner_word: "слово владельца",
};

export function isMergeBasis(v: unknown): v is MergeBasis {
  return typeof v === "string" && (MERGE_BASES as readonly string[]).includes(v);
}

/** Минимум причины словами: «кардиология 4 корпус = 4 корпус кардиология, слово владельца 10.09». */
export const MERGE_REASON_MIN = 10;

/** Проверка запроса на слияние до похода в базу; `null` — годится. */
export function mergeRequestProblem(input: { sourceId: string; targetId: string; basis: unknown; reason: unknown }): string | null {
  if (input.sourceId === input.targetId) return "Карточку нельзя слить саму с собой";
  if (!isMergeBasis(input.basis)) {
    return "Нужно основание: один автомат, полевая проверка или слово владельца. Совпадение адреса основанием не является (М-10)";
  }
  const reason = typeof input.reason === "string" ? input.reason.trim() : "";
  if (reason.length < MERGE_REASON_MIN) return `Опишите основание словами — не короче ${MERGE_REASON_MIN} знаков`;
  return null;
}
