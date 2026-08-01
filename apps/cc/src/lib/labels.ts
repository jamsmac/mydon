/** Подписи направлений и типов записей — по-русски, в одном месте. */

export const DOMAIN_TITLES: Record<string, string> = {
  globerent: "GLOBERENT",
  vendhub: "VendHub",
  personal: "Личный контур",
  mydon: "MYDON",
};

export const TYPE_LABELS: Record<string, string> = {
  contractor: "контрагенты",
  counterparty: "контрагенты",
  contract: "договоры",
  machine: "автоматы",
  equipment: "техника",
  object: "объекты",
  invoice: "счета",
  product: "товары",
  ingredient: "ингредиенты",
};

/** Единственное число — для заголовка карточки. */
export const TYPE_ONE: Record<string, string> = {
  contractor: "контрагент",
  counterparty: "контрагент",
  contract: "договор",
  machine: "автомат",
  equipment: "техника",
  object: "объект",
  invoice: "счёт",
  product: "товар",
  ingredient: "ингредиент",
};

export const typeLabel = (t: string): string => TYPE_LABELS[t] ?? t;
export const typeOne = (t: string): string => TYPE_ONE[t] ?? t;

/** Поля, которые читаются как код: моноширинный шрифт, как в ПО владельца. */
export const MONO_KEYS = new Set(["ИКПУ", "штрихкод", "упаковка", "серийник", "gid", "vhm_id"]);
