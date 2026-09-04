/**
 * Словарь обслуживания оборудования: узлы, виды работ, результаты.
 *
 * Живёт в общем пакете, а не в боте, потому что одни и те же значения пишет
 * бот и показывает панель. Разъехавшись, они дают «bill_acceptor» на одном
 * экране и «купюроприёмник» на другом — и владелец не может понять, одно это
 * и то же или нет.
 *
 * Термины взяты те, которыми говорят техники, а не те, что в мануале
 * производителя: «купюроприёмник», а не «устройство приёма банкнот».
 */

/** Узлы автомата. Порядок задаёт раскладку кнопок — сверху то, что ломается чаще. */
export const PART_KINDS = [
  "bill_acceptor",
  "coin_acceptor",
  "brewer",
  "grinder",
  "mixer",
  "hopper",
  "water_filter",
  "pump",
  "boiler",
  "cooling_unit",
  "compressor",
  "payment_terminal",
  "display",
  "mainboard",
  "motor",
  "valve",
  "sensor",
  "lock",
  "spiral",
  "elevator",
  "other",
] as const;

export type PartKind = (typeof PART_KINDS)[number];

export const PART_LABELS: Record<PartKind, string> = {
  bill_acceptor: "Купюроприёмник",
  coin_acceptor: "Монетоприёмник",
  brewer: "Варочная группа",
  grinder: "Кофемолка",
  mixer: "Миксер",
  hopper: "Бункер",
  water_filter: "Фильтр воды",
  pump: "Помпа",
  boiler: "Бойлер",
  cooling_unit: "Холодильный блок",
  compressor: "Компрессор",
  payment_terminal: "Платёжный терминал",
  display: "Дисплей",
  mainboard: "Плата управления",
  motor: "Мотор",
  valve: "Клапан",
  sensor: "Датчик",
  lock: "Замок",
  spiral: "Спираль выдачи",
  elevator: "Лифт выдачи",
  other: "Другое",
};

/**
 * Узлы, которые реально меняют в поле, — первыми в списке замены.
 * Остальные доступны через «ещё»: показывать технику 21 кнопку значит
 * заставить его листать там, где нужны три.
 */
export const COMMON_PART_KINDS: readonly PartKind[] = [
  "bill_acceptor",
  "coin_acceptor",
  "brewer",
  "grinder",
  "mixer",
  "water_filter",
];

export const MAINTENANCE_KINDS = [
  "cleaning",
  "sanitation",
  "service",
  "part_replace",
  "inspection",
  "calibration",
  "repair",
  "other",
  "part_install",
  "part_remove",
] as const;

export type MaintenanceKind = (typeof MAINTENANCE_KINDS)[number];

export const MAINTENANCE_KIND_LABELS: Record<MaintenanceKind, string> = {
  cleaning: "Чистка",
  sanitation: "Санобработка",
  service: "Плановое ТО",
  part_replace: "Замена узла",
  inspection: "Технический осмотр",
  calibration: "Поверка",
  repair: "Ремонт",
  other: "Другое",
  part_install: "Установка узла",
  part_remove: "Снятие узла",
};

export const MAINTENANCE_OUTCOMES = ["done", "partial", "failed"] as const;
export type MaintenanceOutcome = (typeof MAINTENANCE_OUTCOMES)[number];

export const OUTCOME_LABELS: Record<MaintenanceOutcome, string> = {
  done: "Сделано",
  partial: "Сделано частично",
  failed: "Не смог",
};

export const PART_SWAP_REASONS = ["failure", "preventive", "upgrade", "warranty", "moved"] as const;
export type PartSwapReason = (typeof PART_SWAP_REASONS)[number];

export const SWAP_REASON_LABELS: Record<PartSwapReason, string> = {
  failure: "Сломался",
  preventive: "Профилактика",
  upgrade: "Замена на лучшее",
  warranty: "По гарантии",
  moved: "Переставил",
};

/**
 * Симптомы поломки — то, что техник видит, а не диагноз.
 *
 * Диагноз ставят по месту; заставлять выбирать причину до осмотра значит
 * получить в системе выдуманные причины, на которые потом кто-то сошлётся.
 */
// Порядок = раскладка клавиатуры по два в ряд: пары смысловые (питание/экран,
// платежи, температура, вода/выдача), а не исторические — оператор ищет
// симптом глазами по соседству.
export const PROBLEM_SYMPTOMS = [
  "dead",
  "err",
  "bill",
  "coin",
  "heat",
  "cool",
  "leak",
  "jam",
  "noise",
  "other",
] as const;

export type ProblemSymptom = (typeof PROBLEM_SYMPTOMS)[number];

export const SYMPTOM_LABELS: Record<ProblemSymptom, string> = {
  dead: "Не включается",
  // «Купюры не берёт» вместо «Не принимает купюры»: 15 знаков против 19 —
  // при двух кнопках в ряд длинная подпись на узком экране идёт впритык.
  bill: "Купюры не берёт",
  coin: "Монеты не берёт",
  leak: "Течёт вода",
  heat: "Не греет",
  cool: "Не холодит",
  jam: "Не выдаёт товар",
  err: "Ошибка на экране",
  noise: "Шумит, стучит",
  other: "Другое",
};

/** Срочность заявки. Определяет приоритет созданной задачи. */
export const PROBLEM_URGENCIES = ["1", "2", "3"] as const;
export type ProblemUrgency = (typeof PROBLEM_URGENCIES)[number];

export const URGENCY_LABELS: Record<ProblemUrgency, string> = {
  "1": "🔴 Стоит совсем",
  "2": "🟡 Работает частично",
  "3": "🟢 Мелочь, не горит",
};

/** Приоритет задачи по срочности заявки. */
export const URGENCY_PRIORITY: Record<ProblemUrgency, "urgent" | "high" | "normal"> = {
  "1": "urgent",
  "2": "high",
  "3": "normal",
};

/** Виды технического осмотра — разные регуляторы, разная периодичность. */
export const INSPECTION_TYPES = ["plan", "elec", "sani", "metr"] as const;
export type InspectionType = (typeof INSPECTION_TYPES)[number];

export const INSPECTION_LABELS: Record<InspectionType, string> = {
  plan: "Плановое ТО",
  elec: "Электробезопасность",
  sani: "Санитарный",
  metr: "Поверка платёжных устройств",
};

/**
 * Вид работы, под которым осмотр ложится в журнал. Плановое ТО — это
 * `service`, поверка — `calibration`, остальное — `inspection`: иначе сроки
 * трёх разных обязанностей считались бы как одна.
 */
export const INSPECTION_KIND: Record<InspectionType, MaintenanceKind> = {
  plan: "service",
  elec: "inspection",
  sani: "inspection",
  metr: "calibration",
};

/**
 * Где узел, когда он не на автомате. `machine` в списках выбора не участвует:
 * «поставить на автомат» — это отдельная операция установки, а не смена места.
 */
export const PART_LOCATIONS = ["machine", "warehouse", "washing", "drying", "repair", "unknown"] as const;
export type PartLocation = (typeof PART_LOCATIONS)[number];

export const PART_LOCATION_LABELS: Record<PartLocation, string> = {
  machine: "На автомате",
  warehouse: "Склад",
  washing: "Мойка",
  drying: "Сушка",
  repair: "Ремонт",
  // Узел не найден при инвентаризации (R-PU-7): карточка есть, места нет.
  unknown: "Местонахождение неизвестно",
};

/** Куда можно СНЯТЬ узел — все места, кроме автомата. */
export const PART_OFF_LOCATIONS: readonly PartLocation[] = ["washing", "warehouse", "drying", "repair"];

export const partLabel = (k: string): string => PART_LABELS[k as PartKind] ?? k;
export const maintenanceKindLabel = (k: string): string =>
  MAINTENANCE_KIND_LABELS[k as MaintenanceKind] ?? k;
export const partLocationLabel = (k: string): string =>
  PART_LOCATION_LABELS[k as PartLocation] ?? k;
