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
    key: "settings",
    label: "Настройки",
    // Финальная структура владельца (20.08.2026): всё реестровое хозяйство —
    // внутри Настроек. Профиль направления первым; реестр аппаратов — здесь же
    // (оперативный взгляд на парк остаётся на дашборде и в Обслуживании).
    leaves: [
      { label: "Профиль", type: "own_company" },
      { label: "Товары", type: "product" },
      { label: "Компоненты", type: "component" },
      { label: "Ингредиенты", type: "ingredient" },
      // Контрагенты в «Каталоге», как в GLOBERENT: поставщик — не строка
      // справочника, а карточка с историей закупок, ценами и документами.
      { label: "Контрагенты", type: "contractor" },
      { label: "Автоматы", type: "machine" },
      { label: "Рецепты", type: "recipe" },
      { label: "Расходники (тара)", type: "consumable" },
      { label: "Склады", type: "warehouse" },
      { label: "Приход", type: "purchase" },
      // Task 4 (срез D): мастер разового импорта реестра закупок в партии
      // (файл → предпросмотр с предложением карточек → запись). Соседствует
      // с «Приходом»: тот показывает уже свершившийся факт, этот — инструмент
      // разового переноса истории. Кладём в «Настройки», а не в «Отчёты»:
      // это не витрина данных, а административное действие («что сделать»),
      // как и остальной справочный инструментарий вкладки.
      { label: "Импорт закупок", type: "purchase_import" },
      { label: "Остатки в автоматах", type: "machine_stock" },
      // «Поставщики» (плоский type=supplier) убраны: карточек этого типа не
      // существовало ни одной, метки для него в labels.ts тоже не было — лист
      // показывал сырой код. Поставщик теперь contractor с ролью «поставщик»:
      // одно юрлицо — одна карточка, ИНН уникален на уровне БД.
      { label: "Классификатор", type: "classifier" },
      { label: "НДС", type: "vat" },
      { label: "ИКПУ", type: "ikpu" },
      { label: "Упаковка", type: "package" },
      { label: "Штрих-коды", type: "barcode" },
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
      // Task 5: партии сырья/товара — своя таблица (stock_batch), не entity —
      // как «Инкассация» выше и остальные TABLE_BACKED_LEAVES ниже.
      { label: "Сроки годности", type: "expiry" },
      // Срез К, задача 6: автомат → касса → счёт (R-K9) — сверка по автоматам
      // (R-K11) и сверка изъято/сдано в банк (R-K6) на одном листе.
      { label: "Сверка кассы", type: "cash_reconcile" },
      // Срез К, задача 6: реестр пробелов (Task 5) — что нельзя посчитать
      // сейчас, почему и что сделать; вычисляется на каждом чтении (R-K4).
      { label: "Пробелы", type: "gaps" },
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
      // Реквизиты продавца для договорного DOCX и КП (замена SELLER-хардкода донора).
      { label: "Моя компания", type: "own_company" },
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

/**
 * Листы, данные которых живут в СВОИХ таблицах, а не карточками реестра:
 * продажи, инкассация, приход, остатки в автоматах, расход сырья, курсы.
 *
 * Считать их по `entity` бессмысленно — счёт всегда нулевой, а экран при этом
 * полон данных (на 20.08.2026 «Остатки в автоматах» показывали «появится после
 * сбора» при 2380 строках остатков). Поэтому такие листы не затемняем и не
 * подписываем счётчиком — ведём на экран.
 */
export const TABLE_BACKED_LEAVES = [
  "sources",
  "collection",
  "sale",
  "purchase",
  // Task 4: мастер импорта не считается по entity вовсе (своих карточек не
  // заводит) — счёт всегда был бы 0, и вкладка гасла бы, как будто там нечего
  // делать, хотя это всегда доступный инструмент.
  "purchase_import",
  "machine_stock",
  "consumption",
  "customs_rates",
  // Партии (Task 5): stock_batch, не entity — счёт по byType всегда был бы 0.
  "expiry",
  // Срез К, задача 6: сверка кассы и реестр пробелов считаются на чтении
  // (собственные эндпоинты), не entity — счёт по byType всегда был бы 0.
  "cash_reconcile",
  "gaps",
] as const;

export const isTableBackedLeaf = (type: string | null | undefined): boolean =>
  type !== null && type !== undefined && (TABLE_BACKED_LEAVES as readonly string[]).includes(type);

export function groupsFor(domain: string): NavGroup[] {
  if (domain === "vendhub") return VENDHUB_GROUPS;
  if (domain === "personal") return PERSONAL_GROUPS;
  if (domain === "globerent") return GLOBERENT_GROUPS;
  return GENERIC_GROUPS;
}
