/**
 * Структура рабочего места направления.
 *
 * Перенесена из готового проекта владельца (mydon-command-center,
 * src/lib/vendhub/nav.ts) — там она уже была продумана и обкатана.
 * Здесь лист = вкладка с записями реестра определённого типа: где данные
 * собраны — живая, где нет — честная заглушка «появится после сбора».
 */

export interface NavLeaf {
  label: string;
  /** Тип записей реестра, который показывает лист (null = данных ещё не собираем). */
  type: string | null;
}
export interface NavGroup {
  key: string;
  label: string;
  leaves: NavLeaf[];
}

/** Группы VendHub — как в ПО владельца (VHM24) и его command-center. */
export const VENDHUB_GROUPS: NavGroup[] = [
  {
    key: "catalog",
    label: "Каталог",
    leaves: [
      { label: "Товары", type: "product" },
      // «Аппараты» здесь больше нет: автоматы и аппараты — одно и то же,
      // их единое место — верхняя вкладка «Автоматы» (карточки + живой дефицит).
      { label: "Компоненты", type: "component" },
      { label: "Ингредиенты", type: "ingredient" },
      { label: "Рецепты", type: "recipe" },
      { label: "Расходники (тара)", type: "consumable" },
      { label: "Склады", type: "warehouse" },
      { label: "Приход", type: "purchase" },
      { label: "Остатки в автоматах", type: "machine_stock" },
    ],
  },
  {
    key: "reference",
    label: "Справочники",
    leaves: [
      { label: "Классификатор", type: "classifier" },
      { label: "НДС", type: "vat" },
      { label: "ИКПУ", type: "ikpu" },
      { label: "Упаковка", type: "package" },
      { label: "Штрих-коды", type: "barcode" },
      { label: "Поставщики", type: "supplier" },
    ],
  },
  {
    key: "reports",
    label: "Отчёты",
    leaves: [
      // Витрина по источникам — основной вид отчётов (источник → отчёт → срез).
      { label: "По источникам", type: "sources" },
      { label: "Журнал продаж", type: "sale" },
      { label: "Расход сырья", type: "consumption" },
      { label: "Инкассация", type: "collection" },
      { label: "Сроки годности", type: null },
      { label: "Себестоимость", type: null },
    ],
  },
];

/**
 * GLOBERENT — дистрибуция погрузчиков HELI. Состав из описи данных владельца
 * (docs/LEGACY_DATA.md): контрагенты, договоры, счета-фактуры, техника.
 * Документы отделены от каталога: договор живёт сроком, счёт — суммой,
 * им нужны свои колонки, а не общий список «название — код».
 */
export const GLOBERENT_GROUPS: NavGroup[] = [
  {
    key: "catalog",
    label: "Каталог",
    leaves: [
      // Модели каталога (HELI CPD30…) отдельно от физических единиц с VIN.
      { label: "Модели", type: "equipment_model" },
      { label: "Техника", type: "equipment" },
      { label: "Контрагенты", type: "contractor" },
      { label: "Объекты", type: "object" },
    ],
  },
  {
    key: "docs",
    label: "Документы",
    leaves: [
      { label: "Договоры", type: "contract" },
      { label: "Счета", type: "invoice" },
    ],
  },
  {
    key: "refs",
    label: "Справочники",
    leaves: [
      // Живая таблица ставок растаможки (tnved_rate + brv_value, перенос PROMACH).
      { label: "Растаможка", type: "customs_rates" },
      { label: "Таможенные посты", type: "customs_post" },
    ],
  },
];

/** Прочие направления: без вендинговой специфики — типы берутся из данных. */
export const GENERIC_GROUPS: NavGroup[] = [
  {
    key: "catalog",
    label: "Каталог",
    leaves: [
      { label: "Контрагенты", type: "contractor" },
      { label: "Договоры", type: "contract" },
      { label: "Техника", type: "equipment" },
      { label: "Объекты", type: "object" },
      { label: "Счета", type: "invoice" },
    ],
  },
];

/**
 * Личный контур владельца (CLAUDE.md: недвижимость, транспорт, накопления;
 * только владелец). Каркас: вкладки готовы принимать записи, данные появятся
 * из документов/выгрузок владельца — тем же путём, что и в VendHub.
 */
export const PERSONAL_GROUPS: NavGroup[] = [
  {
    key: "catalog",
    label: "Каталог",
    leaves: [
      { label: "Недвижимость", type: "property" },
      { label: "Транспорт", type: "vehicle" },
      { label: "Накопления", type: "saving" },
      { label: "Договоры", type: "contract" },
      { label: "Счета", type: "invoice" },
    ],
  },
];

export function groupsFor(domain: string): NavGroup[] {
  if (domain === "vendhub") return VENDHUB_GROUPS;
  if (domain === "personal") return PERSONAL_GROUPS;
  if (domain === "globerent") return GLOBERENT_GROUPS;
  return GENERIC_GROUPS;
}
