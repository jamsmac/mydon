/**
 * Статусная машина единицы техники GLOBERENT — перенос warehouse_vehicles
 * PROMACH (17 статусов, семантические и авто-переходы с fromStatuses).
 *
 * Чистые данные и функции без БД: сервис Core применяет переходы
 * идемпотентно (WHERE status = ANY(fromStatuses)), а тесты фиксируют
 * матрицу дословно — у донора это была дисциплина, на которой держался
 * весь конвейер «контракт → таможня → склад → продажа».
 */

/** Статусы единицы в порядке конвейера + терминальные ветки. */
export const UNIT_STATUSES = [
  "NEW_REQUEST",
  "CONTRACT_SIGNED",
  "IN_PRODUCTION",
  "READY_FOR_SHIPMENT",
  "IN_TRANSIT_TO_BORDER",
  "IN_TRANSIT_TO_UZ",
  "AT_BORDER",
  "CUSTOMS_CLEARANCE",
  "IM74",
  "IM40",
  "DELIVERED_TO_WH",
  "IN_STOCK",
  "RESERVED",
  "SOLD",
  "DELIVERED_TO_CLIENT",
  "ARCHIVED",
  "CANCELLED",
] as const;
export type UnitStatus = (typeof UNIT_STATUSES)[number];

export const UNIT_STATUS_LABELS: Record<UnitStatus, string> = {
  NEW_REQUEST: "заявка",
  CONTRACT_SIGNED: "контракт подписан",
  IN_PRODUCTION: "в производстве",
  READY_FOR_SHIPMENT: "готова к отгрузке",
  IN_TRANSIT_TO_BORDER: "в пути до границы",
  IN_TRANSIT_TO_UZ: "в пути по Узбекистану",
  AT_BORDER: "на границе",
  CUSTOMS_CLEARANCE: "растаможка",
  IM74: "ГТД ИМ-74 (врем. ввоз)",
  IM40: "ГТД ИМ-40 (св. обращение)",
  DELIVERED_TO_WH: "доставлена на склад",
  IN_STOCK: "на складе",
  RESERVED: "резерв",
  SOLD: "продана",
  DELIVERED_TO_CLIENT: "передана клиенту",
  ARCHIVED: "архив",
  CANCELLED: "отменена",
};

/**
 * Семантические переходы (кнопки логиста) — fromStatuses дословно из донора.
 * Нарушение — отказ 409, никаких тихих скачков.
 */
export const UNIT_TRANSITIONS: Record<
  string,
  { to: UnitStatus; from: readonly UnitStatus[]; label: string }
> = {
  "mark-in-production": {
    to: "IN_PRODUCTION",
    from: ["CONTRACT_SIGNED"],
    label: "в производстве",
  },
  "mark-ready-to-ship": {
    to: "READY_FOR_SHIPMENT",
    from: ["CONTRACT_SIGNED", "IN_PRODUCTION"],
    label: "готова к отгрузке",
  },
  "mark-in-transit": {
    to: "IN_TRANSIT_TO_UZ",
    from: ["CUSTOMS_CLEARANCE", "AT_BORDER", "READY_FOR_SHIPMENT", "IN_TRANSIT_TO_BORDER"],
    label: "в пути",
  },
  "mark-at-border": {
    to: "AT_BORDER",
    from: ["IN_TRANSIT_TO_BORDER", "IN_TRANSIT_TO_UZ", "READY_FOR_SHIPMENT"],
    label: "на границе",
  },
  "mark-customs-im74": {
    to: "IM74",
    from: ["IN_TRANSIT_TO_UZ", "AT_BORDER", "CUSTOMS_CLEARANCE"],
    label: "ГТД ИМ-74",
  },
  "mark-customs-im40": {
    to: "IM40",
    from: ["IN_TRANSIT_TO_UZ", "AT_BORDER", "CUSTOMS_CLEARANCE", "IM74"],
    label: "ГТД ИМ-40",
  },
  "mark-delivered": {
    to: "DELIVERED_TO_WH",
    from: ["IM74", "IM40", "IN_TRANSIT_TO_UZ", "AT_BORDER"],
    label: "доставлена на склад",
  },
  "to-stock": {
    to: "IN_STOCK",
    from: ["DELIVERED_TO_WH"],
    label: "принять на склад",
  },
  "mark-sold": {
    to: "SOLD",
    from: ["IN_STOCK", "RESERVED", "DELIVERED_TO_WH"],
    label: "продана",
  },
  "mark-handover": {
    to: "DELIVERED_TO_CLIENT",
    from: ["SOLD"],
    label: "передана клиенту",
  },
  cancel: {
    to: "CANCELLED",
    from: ["NEW_REQUEST", "CONTRACT_SIGNED", "IN_PRODUCTION"],
    label: "отменить",
  },
  archive: {
    to: "ARCHIVED",
    from: ["DELIVERED_TO_CLIENT", "CANCELLED"],
    label: "в архив",
  },
};

/** Проверка перехода: null — можно, строка — почему нельзя (словами владельцу). */
export function unitTransitionError(action: string, current: string): string | null {
  const t = UNIT_TRANSITIONS[action];
  if (t === undefined) return `Неизвестное действие «${action}»`;
  if (!(UNIT_STATUSES as readonly string[]).includes(current)) {
    return `Неизвестный статус «${current}»`;
  }
  if (!t.from.includes(current as UnitStatus)) {
    const label = UNIT_STATUS_LABELS[current as UnitStatus];
    return `Переход «${t.label}» невозможен из статуса «${label}» (разрешено из: ${t.from
      .map((s) => UNIT_STATUS_LABELS[s])
      .join(", ")})`;
  }
  return null;
}

/**
 * Откат VIN (reject инвойса) разрешён ТОЛЬКО из этих статусов: машины,
 * с которыми логист уже работал физически (граница, таможня, склад),
 * не трогаются — донор возвращал их числом skipped_advanced.
 */
export const VIN_UNBIND_ALLOWED: readonly UnitStatus[] = ["IN_TRANSIT_TO_UZ", "CONTRACT_SIGNED"];

/** Резерв ставится только со склада. */
export const RESERVE_ALLOWED: readonly UnitStatus[] = ["IN_STOCK", "DELIVERED_TO_WH"];

/** Старт продажи (sales_stage) разрешён только из этих статусов склада. */
export const SALE_START_ALLOWED: readonly UnitStatus[] = ["IN_STOCK", "DELIVERED_TO_WH", "RESERVED"];

/** Групповые вкладки списка — фильтры UI донора. */
export const UNIT_GROUPS: { key: string; label: string; statuses: readonly UnitStatus[] }[] = [
  { key: "zayavka", label: "Заявки", statuses: ["NEW_REQUEST", "CONTRACT_SIGNED"] },
  { key: "production", label: "Производство", statuses: ["IN_PRODUCTION", "READY_FOR_SHIPMENT"] },
  { key: "transit", label: "В пути", statuses: ["IN_TRANSIT_TO_BORDER", "IN_TRANSIT_TO_UZ"] },
  { key: "border", label: "Граница", statuses: ["AT_BORDER"] },
  { key: "im74", label: "ИМ-74", statuses: ["CUSTOMS_CLEARANCE", "IM74"] },
  { key: "im40", label: "ИМ-40", statuses: ["IM40"] },
  {
    key: "stock",
    label: "Склад и продажа",
    statuses: ["DELIVERED_TO_WH", "IN_STOCK", "RESERVED", "SOLD", "DELIVERED_TO_CLIENT"],
  },
  { key: "closed", label: "Архив", statuses: ["ARCHIVED", "CANCELLED"] },
];

/** Стадии продажи (надстройка над складом). LOST — отдельная ветка с причиной. */
export const SALES_STAGES = [
  "NEW_LEAD",
  "NEGOTIATION",
  "PRICE_OFFER",
  "WAITING_CONTRACT",
  "WAITING_ADVANCE",
  "ADVANCE_PAID",
  "WAITING_FINAL",
  "FULLY_PAID",
  "READY_TO_SHIP",
  "DELIVERED",
  "CLOSED",
  "LOST",
] as const;
export type SalesStage = (typeof SALES_STAGES)[number];

export const SALES_STAGE_LABELS: Record<SalesStage, string> = {
  NEW_LEAD: "новый интерес",
  NEGOTIATION: "переговоры",
  PRICE_OFFER: "выставлено КП",
  WAITING_CONTRACT: "ждём договор",
  WAITING_ADVANCE: "ждём предоплату",
  ADVANCE_PAID: "предоплата получена",
  WAITING_FINAL: "ждём остаток",
  FULLY_PAID: "оплачено полностью",
  READY_TO_SHIP: "к выдаче",
  DELIVERED: "выдана",
  CLOSED: "сделка закрыта",
  LOST: "потеряна",
};

/** Стадии, требующие заполненной цены продажи (guard донора). */
export const STAGES_REQUIRE_PRICE: readonly SalesStage[] = [
  "WAITING_ADVANCE",
  "WAITING_FINAL",
  "READY_TO_SHIP",
];
