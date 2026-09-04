/**
 * Роли сотрудников и права.
 *
 * Живёт в общем пакете: одну и ту же матрицу читает бот (фильтруя меню) и
 * Core (проверяя мутации). Разъехавшись, они дают пункт, спрятанный кнопкой,
 * но доступный запросом, — и вся модель прав становится косметикой.
 *
 * Честно о масштабе: полевых сотрудников сейчас двое, и оба делают всю
 * работу, поэтому матрица почти ничего не режет. Она нужна не сегодня,
 * а в день появления третьего человека с урезанным доступом: тогда это одна
 * строка здесь, а не переделка меню и хендлеров бота.
 */

export const STAFF_ROLES = [
  "operator", // оператор-заправщик: бункеры, расходники
  "technician", // техник: ремонт, замена узлов, осмотры
  "collector", // инкассатор: снятие выручки
  "storekeeper", // кладовщик: приход, инвентаризация
  "manager", // менеджер: видит всё по своему направлению
  "owner", // владелец: всё, включая настройки
] as const;

export type StaffRole = (typeof STAFF_ROLES)[number];

export const ROLE_LABELS: Record<StaffRole, string> = {
  operator: "Оператор",
  technician: "Техник",
  collector: "Инкассатор",
  storekeeper: "Кладовщик",
  manager: "Менеджер",
  owner: "Владелец",
};

/**
 * Права. Именуются «объект.действие» — по ним же названы пункты меню,
 * чтобы связь кнопки и права читалась без словаря.
 */
export const PERMISSIONS = [
  "tasks.own", // свои задачи: смотреть, брать, закрывать
  // Два права П7 (R-P7-3). Ровно два: третье право без третьего сотрудника
  // стало бы косметикой, и матрица снова начала бы врать.
  "tasks.assign", // назначать задачи другим и переназначать
  "tasks.confirm", // принимать выполненное и возвращать в работу
  "maintenance.view", // графики и осмотры
  "parts.replace", // замена узлов
  // Узлы с инвентарными номерами (спека vendhub-parts, R-PU-12).
  "parts.number", // наклеить/подтвердить/исправить номер узла
  "parts.move", // снять на мойку/ремонт, помыть, вернуть на склад
  "parts.count", // инвентаризация узлов с фото
  "coffee.wash", // мойка бункеров и чистка автоматов
  "coffee.refill", // заливка бункеров
  "coffee.consumable", // расходники точки
  "cash.collect", // инкассация
  "stock.intake", // приход на склад
  "stock.count", // инвентаризация
  "refill.create", // заливка снек/дринк-автомата (кофе — отдельное право выше)
  "registry.propose", // предложить карточку в реестр
  "system.admin", // настройки, приглашения, отзыв доступа
] as const;

export type Permission = (typeof PERMISSIONS)[number];

/**
 * Базовые права любого подключённого сотрудника.
 *
 * Пустой список ролей НЕ должен запирать человека: карточка заведена,
 * Telegram привязан, а роли владелец проставить не успел — бот обязан
 * работать, иначе первый же новый сотрудник упрётся в молчание.
 */
export const BASELINE: readonly Permission[] = ["tasks.own"];

export const ROLE_PERMISSIONS: Record<StaffRole, readonly Permission[]> = {
  operator: [
    "tasks.own",
    "coffee.refill",
    "coffee.wash",
    "coffee.consumable",
    "refill.create",
    "registry.propose",
    // Оператор меняет миксеры и бункеры на точке — номера и движения узлов его.
    "parts.number",
    "parts.move",
  ],
  technician: [
    "tasks.own",
    "maintenance.view",
    "parts.replace",
    "parts.number",
    "parts.move",
    "parts.count",
    "coffee.wash",
    "refill.create",
    "registry.propose",
  ],
  collector: ["tasks.own", "cash.collect"],
  storekeeper: ["tasks.own", "stock.intake", "stock.count", "registry.propose", "parts.number", "parts.count"],
  manager: [
    "tasks.own",
    "tasks.assign",
    "tasks.confirm",
    "maintenance.view",
    "parts.replace",
    "parts.number",
    "parts.move",
    "parts.count",
    "coffee.wash",
    "coffee.refill",
    "coffee.consumable",
    "cash.collect",
    "stock.intake",
    "stock.count",
    "refill.create",
    "registry.propose",
  ],
  owner: [...PERMISSIONS],
};

/** Есть ли у набора ролей это право. Роли складываются, а не вытесняют. */
export function can(roles: readonly string[] | null | undefined, perm: Permission): boolean {
  if (BASELINE.includes(perm)) return true;
  if (!roles || roles.length === 0) return false;
  return roles.some((r) => (ROLE_PERMISSIONS[r as StaffRole] ?? []).includes(perm));
}

/** Все права набора ролей — для показа в карточке сотрудника. */
export function permissionsOf(roles: readonly string[] | null | undefined): Permission[] {
  const out = new Set<Permission>(BASELINE);
  for (const r of roles ?? []) {
    for (const p of ROLE_PERMISSIONS[r as StaffRole] ?? []) out.add(p);
  }
  return [...out];
}

/**
 * Очистка списка ролей от мусора.
 *
 * Неизвестное значение выбрасывается, а не сохраняется «на всякий случай»:
 * роль, которой нет в матрице, не даёт прав, но создаёт вид, что доступ
 * настроен.
 */
export function normalizeRoles(input: unknown): StaffRole[] {
  if (!Array.isArray(input)) return [];
  const known = new Set<string>(STAFF_ROLES);
  return [...new Set(input.filter((r): r is StaffRole => typeof r === "string" && known.has(r)))];
}

/** Русские подписи набора ролей — через запятую, как в карточке. */
export function rolesLabel(roles: readonly string[] | null | undefined): string {
  const known = normalizeRoles(roles ?? []);
  return known.length > 0 ? known.map((r) => ROLE_LABELS[r]).join(", ") : "роли не заданы";
}

/**
 * Легаси-поле `person.role` — свободный текст, которым владельца пометили ДО
 * появления массива `roles`. На проде (25.08.2026) ролей owner/manager нет ни
 * у кого, а владелец помечен ровно так: `role='владелец'`. Требовать один
 * `roles` значило бы не дать право подтверждения НИКОМУ.
 *
 * Живёт в общем пакете, а не в боте: по этой карте теперь считает и Core, а
 * разошедшиеся ответы на вопрос «кто менеджер» дали бы кнопку, которую Core
 * отвергает 403-м.
 */
export const LEGACY_ROLE_MAP: ReadonlyMap<string, StaffRole> = new Map<string, StaffRole>([
  ["владелец", "owner"],
  ["собственник", "owner"],
  ["owner", "owner"],
  ["менеджер", "manager"],
  ["manager", "manager"],
]);

/** Роли карточки: массив `roles` плюс легаси-текст `role`. */
export function effectiveRoles(p: {
  roles?: readonly string[] | null;
  role?: string | null;
}): StaffRole[] {
  const known = normalizeRoles(p.roles ?? []);
  const legacy = LEGACY_ROLE_MAP.get((p.role ?? "").trim().toLowerCase());
  return legacy && !known.includes(legacy) ? [...known, legacy] : known;
}
