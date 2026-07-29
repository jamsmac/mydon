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
      { label: "Аппараты", type: "machine" },
      { label: "Компоненты", type: "component" },
      { label: "Ингредиенты", type: "ingredient" },
      { label: "Рецепты", type: "recipe" },
      { label: "Расходники (тара)", type: "consumable" },
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
      { label: "Журнал продаж", type: "sale" },
      { label: "Инкассация", type: "collection" },
      { label: "Сроки годности", type: null },
      { label: "Себестоимость", type: null },
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

export function groupsFor(domain: string): NavGroup[] {
  return domain === "vendhub" ? VENDHUB_GROUPS : GENERIC_GROUPS;
}
