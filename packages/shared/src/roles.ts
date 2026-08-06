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
  "maintenance.view", // графики и осмотры
  "parts.replace", // замена узлов
  "coffee.wash", // мойка бункеров и чистка автоматов
  "coffee.refill", // заливка бункеров
  "coffee.consumable", // расходники точки
  "cash.collect", // инкассация
  "stock.intake", // приход на склад
  "stock.count", // инвентаризация
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
  operator: ["tasks.own", "coffee.refill", "coffee.wash", "coffee.consumable", "registry.propose"],
  technician: [
    "tasks.own",
    "maintenance.view",
    "parts.replace",
    "coffee.wash",
    "registry.propose",
  ],
  collector: ["tasks.own", "cash.collect"],
  storekeeper: ["tasks.own", "stock.intake", "stock.count", "registry.propose"],
  manager: [
    "tasks.own",
    "maintenance.view",
    "parts.replace",
    "coffee.wash",
    "coffee.refill",
    "coffee.consumable",
    "cash.collect",
    "stock.intake",
    "stock.count",
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
