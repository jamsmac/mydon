/**
 * Словарь GLOBERENT — типы записей реестра и справочные константы.
 *
 * Единое место имён (решение сверки переноса PROMACH, 2026-08-04):
 * разведка донора дала четыре имени для модели техники и три — для
 * контрагента; здесь зафиксировано по одному, и код обязан брать имена
 * отсюда, а не изобретать свои.
 */

/** Типы записей реестра GLOBERENT (entity.type). */
export const GR_ENTITY_TYPES = {
  /** Контрагент — ЕДИНСТВЕННЫЙ тип для клиента/поставщика/агента (роли в attrs.roles). */
  contractor: "contractor",
  /**
   * Своя компания — реквизиты продавца для договоров и КП (замена
   * SELLER-хардкода донора). Обычно одна карточка на направление;
   * ContractsService.renderDocx без неё честно отказывает.
   */
  ownCompany: "own_company",
  /** Договор (карточка в реестре; операционный контур — отдельно). */
  contract: "contract",
  /** Счёт-фактура. */
  invoice: "invoice",
  /** Единица техники (физическая, с VIN). */
  equipment: "equipment",
  /** Модель техники каталога (HELI CPD30 и т.п.). */
  equipmentModel: "equipment_model",
  /** Группа каталога (вилочные ДВС, электро, ричтраки…). */
  equipmentGroup: "equipment_group",
  /** Подгруппа каталога. */
  equipmentSubgroup: "equipment_subgroup",
  /** Таможенный пост РУз. */
  customsPost: "customs_post",
  /** Объект (площадка, склад). */
  object: "object",
} as const;

/**
 * Роли контрагента. У донора клиент, поставщик и агент жили тремя таблицами —
 * здесь одна карточка с ролями, иначе завод HELI заведётся трижды
 * (клиентом по продажам запчастей, поставщиком по импорту, агентом).
 */
export const CONTRACTOR_ROLES = ["client", "supplier", "agent"] as const;
export type ContractorRole = (typeof CONTRACTOR_ROLES)[number];

export const CONTRACTOR_ROLE_LABELS: Record<ContractorRole, string> = {
  client: "клиент",
  supplier: "поставщик",
  agent: "агент",
};

/** Тип контрагента: юр.лицо или физлицо (реквизитный блок — только юр.лицам). */
export const CLIENT_TYPES = ["legal", "individual"] as const;
export type ClientType = (typeof CLIENT_TYPES)[number];

/** Источники лида — справочник формы клиента (донор: фронт-константа). */
export const LEAD_SOURCES = [
  "Сайт",
  "Тендер",
  "Личный контакт",
  "Реклама",
  "Холодные звонки",
  "Рекомендация",
  "Другое",
] as const;

/** Типы клиентских документов (донор: document_type, миграция 041). */
export const CLIENT_DOC_TYPES: Record<string, string> = {
  charter: "Устав",
  registration_certificate: "Свидетельство о госрегистрации",
  inn_certificate: "Свидетельство ИНН",
  power_of_attorney: "Доверенность на подписанта",
  bank_card: "Карточка с образцами подписей и печати",
};

/** Контактное лицо контрагента — один из трёх слотов карточки. */
export interface ContractorContact {
  fullName: string;
  position?: string;
  phone?: string;
  email?: string;
  notes?: string;
}

/** Три фиксированных слота контактов (донор: client_contacts UNIQUE(client_id, role)). */
export interface ContractorContacts {
  director?: ContractorContact;
  accountant?: ContractorContact;
  contact?: ContractorContact;
}

/**
 * Категории движения денег — ЕДИНЫЙ словарь для всех контуров
 * (у донора четыре платёжных контура несли каждый свой словарь; здесь один,
 * дополнительная семантика — в meta записи, не новыми категориями).
 */
export const MONEY_CATEGORIES = [
  "sale", // продажа техники/услуг клиенту
  "service", // сервис и запчасти
  "supplier", // оплата заводу/поставщику
  "logistics",
  "customs",
  "certification",
  "tax",
  "rent",
  "commission", // комиссия агента/менеджера
  "other",
] as const;
export type MoneyCategory = (typeof MONEY_CATEGORIES)[number];

export const MONEY_CATEGORY_LABELS: Record<MoneyCategory, string> = {
  sale: "продажа техники",
  service: "сервис и запчасти",
  supplier: "оплата поставщику",
  logistics: "логистика",
  customs: "таможня",
  certification: "сертификация",
  tax: "налоги",
  rent: "аренда",
  commission: "комиссия",
  other: "прочее",
};
