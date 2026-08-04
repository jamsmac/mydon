/**
 * Предзаказы — перенос preorders PROMACH: 8 статусов, ALLOWED_TRANSITIONS
 * дословно. «Скип» промежуточных шагов разрешён сознательно
 * (requested → ordered, in_procurement → in_transit).
 */

export const PREORDER_STATUSES = [
  "draft",
  "requested",
  "in_procurement",
  "ordered",
  "in_transit",
  "delivered",
  "closed",
  "cancelled",
] as const;
export type PreorderStatus = (typeof PREORDER_STATUSES)[number];

export const PREORDER_STATUS_LABELS: Record<PreorderStatus, string> = {
  draft: "черновик",
  requested: "запрошен",
  in_procurement: "в проработке ВЭД",
  ordered: "заказан заводу",
  in_transit: "в пути",
  delivered: "доставлен",
  closed: "закрыт",
  cancelled: "отменён",
};

/** Матрица донора дословно. Терминальные closed/cancelled — пустые. */
export const PREORDER_ALLOWED: Record<PreorderStatus, readonly PreorderStatus[]> = {
  draft: ["requested", "cancelled"],
  requested: ["in_procurement", "ordered", "cancelled"],
  in_procurement: ["ordered", "in_transit", "cancelled"],
  ordered: ["in_transit", "cancelled"],
  in_transit: ["delivered", "cancelled"],
  delivered: ["closed", "cancelled"],
  closed: [],
  cancelled: [],
};

/** Действия-эндпоинты донора с их fromStatuses. */
export const PREORDER_ACTIONS: Record<
  string,
  { to: PreorderStatus; from: readonly PreorderStatus[]; label: string }
> = {
  submit: { to: "requested", from: ["draft"], label: "запросить" },
  "start-procurement": { to: "in_procurement", from: ["requested"], label: "в проработку" },
  order: { to: "ordered", from: ["in_procurement", "requested"], label: "заказан заводу" },
  "mark-in-transit": { to: "in_transit", from: ["ordered", "in_procurement"], label: "в пути" },
  "mark-delivered": { to: "delivered", from: ["in_transit"], label: "доставлен" },
  close: { to: "closed", from: ["delivered"], label: "закрыть" },
};

/** null — переход разрешён; строка — причина отказа словами. */
export function preorderActionError(action: string, current: string): string | null {
  if (current === "closed" || current === "cancelled") {
    return "Предзаказ в терминальном статусе — менять нечего";
  }
  const t = PREORDER_ACTIONS[action];
  if (t === undefined) return `Неизвестное действие «${action}»`;
  if (!t.from.includes(current as PreorderStatus)) {
    const label = PREORDER_STATUS_LABELS[current as PreorderStatus] ?? current;
    return `«${t.label}» невозможно из статуса «${label}»`;
  }
  return null;
}
