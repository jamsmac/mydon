/**
 * Справочник источников VendHub — систем, из которых приходят цифры.
 *
 * Это конфигурация, а не данные: коды, адреса кабинетов и путь до отчёта
 * внутри чужого интерфейса. Сами строки живут в raw_snapshot / raw_row.
 *
 * Правило слоя: строки хранятся так, как пришли из системы — те же колонки,
 * тот же порядок, значения строками. Поэтому справочник НЕ описывает поля
 * отчёта: их состав диктует источник, а не мы. Мы записываем то, что он отдал.
 */

/**
 * Названия колонки, под которыми роль встречается у источника.
 *
 * Их бывает несколько: один и тот же отчёт панели gjvending отдаёт «Machine
 * Code» при выгрузке файлом и `machine_code` при чтении через /api/order/list.
 * Это один отчёт с двумя словарями, а не два разных.
 */
export type RoleNames = string | readonly string[];

/**
 * Роли колонок — договор о том, как отчёт связан с реестром MYDON.
 *
 * Ключ роли → название колонки у источника (или несколько названий). Название,
 * а не номер: порядок колонок источник однажды поменяет, а заголовок держится
 * годами. Роль, которой нет в отчёте, просто не указывается — выдумывать нельзя.
 */
export interface RawColumnRoles {
  /** Серийник автомата: сопоставляется с entity.externalRef карточки автомата. */
  machine?: RoleNames;
  /** Точка (адрес) — сверяется с attrs «точка» карточки автомата. */
  point?: RoleNames;
  /** Товар: сопоставляется с карточкой товара (entity type=product). */
  product?: RoleNames;
  /** Вкус/вариант товара — уточнение к товару, отдельной карточкой не является. */
  flavour?: RoleNames;
  /** Сумма операции. Приводить к числу можно только на слое разбора. */
  amount?: RoleNames;
  /** Время операции у источника (локальное, Asia/Tashkent). */
  ts?: RoleNames;
  /** Идентификатор операции у источника — ключ от двойного учёта. */
  externalId?: RoleNames;
  /** Статус оплаты. */
  status?: RoleNames;
  /** Тип операции: обычная продажа или тестовая отгрузка (в выручку не идёт). */
  kind?: RoleNames;
  /** Способ оплаты: мост к инкассации (наличные) и к money_flow (Payme, Click). */
  payment?: RoleNames;
  /** Чем закончилась выдача: доставлено, сбой, не доставлено. */
  fulfilment?: RoleNames;
}

/** Отчёт внутри системы-источника. */
export interface RawReportDef {
  /** Код отчёта: латиницей, стабилен — по нему связаны снимки. */
  code: string;
  /** Как отчёт называется в самой системе (обычно по-английски). */
  title: string;
  /** Что это по-русски — владелец читает эту строку, а не английский заголовок. */
  ru: string;
  /** Где его нажать в чужом интерфейсе: «Report Query → Order Query». */
  path: string;
  /**
   * Роли колонок. Пусто — состав отчёта ещё не видели, и это честное состояние:
   * связать с карточками нечего, пока не пришла первая выгрузка.
   */
  roles?: RawColumnRoles;
  /** Расшифровки кодов источника: «cash» → «наличные». */
  dicts?: readonly RawValueDict[];
}

/**
 * Расшифровка кодов одной колонки.
 *
 * Сырьё остаётся сырьём: в базе лежит «userDefined», а расшифровка живёт
 * рядом и показывается подсказкой. Заменять код переводом нельзя — тогда
 * выгрузку не сверить с источником.
 */
export interface RawValueDict {
  role: keyof RawColumnRoles;
  values: Readonly<Record<string, string>>;
  /**
   * Коды, смысл которых НЕ подтверждён. Показываются со знаком вопроса:
   * догадка, выданная за факт, хуже отсутствия расшифровки.
   */
  unconfirmed?: readonly string[];
}

/** Расшифровка значения. `confirmed: false` — смысл не подтверждён. */
export interface RawDecoded {
  label: string;
  confirmed: boolean;
}

/** Расшифровать код источника. null — расшифровки нет, и выдумывать её нельзя. */
export function decodeRawValue(
  dict: RawValueDict | undefined,
  value: string,
): RawDecoded | null {
  if (!dict) return null;
  const key = value.trim();
  const label = dict.values[key];
  if (label === undefined) return null;
  return { label, confirmed: !(dict.unconfirmed ?? []).includes(key) };
}

/** Что сопоставляется с карточками реестра. */
export const RAW_LINK_KINDS = ["machine", "product", "point"] as const;
export type RawLinkKind = (typeof RAW_LINK_KINDS)[number];

/** Русские названия видов связи — для экрана сопоставления. */
export const RAW_LINK_LABELS: Record<RawLinkKind, string> = {
  machine: "Автоматы",
  product: "Товары",
  point: "Точки",
};

/**
 * Нормализация значения источника перед сравнением.
 *
 * Регистр, «ё», неразрывные пробелы и двойные пробелы — мусор, из-за которого
 * «Ice Lemon Tea» и «ice lemon  tea» считались бы разными товарами. Всё
 * остальное (знаки, цифры, порядок слов) сохраняем: это уже смысл, а не мусор.
 */
export function normalizeSourceKey(value: string): string {
  return value
    // Неразрывные пробелы записаны кодами: в исходнике их не отличить от обычных.
    .replace(/[\u00A0\u202F]/g, " ")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase()
    .replace(/ё/g, "е");
}

/** Система-источник: кабинет, из которого выгружаются отчёты. */
export interface RawSourceDef {
  code: string;
  title: string;
  /** Чем эта система является в хозяйстве владельца. */
  subtitle: string;
  /** Адрес кабинета — чтобы можно было пойти и снять выгрузку. */
  url: string;
  reports: RawReportDef[];
}

/**
 * Источники VendHub.
 *
 * Признака «подключён» здесь намеренно нет: подключённость — это факт наличия
 * выгрузок в базе, а не запись в конфиге. Конфиг не должен обещать данные,
 * которых нет.
 */
export const RAW_SOURCES: readonly RawSourceDef[] = [
  {
    code: "gjvending",
    title: "gjvending",
    subtitle: "Панель автоматов · Ningbo Happy Workers",
    url: "https://www.gjvending.net",
    reports: [
      {
        code: "order_query",
        title: "Order Query",
        ru: "Запрос заказов",
        path: "Report Query → Order Query",
        // Роли выверены по выгрузке от 30.07.2026: «Machine Code» отдаёт тот же
        // серийник, что уже лежит в карточках автоматов (6620191f0000), поэтому
        // автоматы связываются точно, без догадок.
        //
        // Второе название в каждой паре — поле /api/order/list: панель отдаёт
        // один и тот же отчёт двумя словарями, и оба должны узнаваться.
        roles: {
          machine: ["Machine Code", "machine_code"],
          point: ["Address", "address"],
          product: ["Goods name", "operate_goods_name"],
          flavour: ["Flavour name", "taste_name"],
          amount: ["Order price", "orderPrice"],
          ts: ["Creation time", "gmt_create"],
          externalId: ["Order number", "order_no"],
          status: ["Order status", "payment_status"],
          kind: ["Order type", "order_type"],
          payment: ["Order resource", "order_source"],
          fulfilment: ["Brew status", "brewing_status"],
        },
        dicts: [
          {
            role: "payment",
            // Расшифровки сняты с форматтеров панели. «userDefined» интерфейс
            // переводит как «Таможенный платеж» — это ошибка перевода
            // китайского «пользовательский способ». Что за канал на самом деле,
            // не подтверждено, а на нём 181 млн сум: показываем вопросом.
            values: {
              cash: "наличные",
              cash0: "наличные с нулевой суммой",
              userDefined: "пользовательский способ",
              vip: "VIP-карта",
              credit: "карта",
              testShipment: "тестовая выдача",
              send: "выдача вручную",
            },
            unconfirmed: ["userDefined"],
          },
          {
            role: "fulfilment",
            values: {
              "0": "не доставлено",
              "1": "в процессе выдачи",
              "2": "доставлен",
              "10": "доставка подтверждена",
              "11": "сбой доставки",
            },
          },
        ],
      },
      {
        code: "goods_sale",
        title: "Goods Sale Statistics",
        ru: "Статистика продаж товаров",
        path: "Report Query → Goods Sale Statistics",
      },
      {
        code: "presale_goods",
        title: "Presale Goods Statistic",
        ru: "Статистика предпродаж",
        path: "Report Query → Presale Goods Statistic",
      },
      {
        code: "machine_sale",
        title: "Machine Sale Statistic",
        ru: "Продажи по автоматам",
        path: "Report Query → Machine Sale Statistic",
      },
      {
        code: "machine_cash",
        title: "Machine Cash Record",
        ru: "Касса автоматов",
        path: "Report Query → Machine Cash Record",
      },
    ],
  },
  {
    code: "ourvend",
    title: "OurVend",
    subtitle: "Вторая вендинговая платформа",
    url: "https://os.ourvend.com/Account/Login",
    reports: [
      {
        code: "reports",
        title: "Отчёты",
        ru: "состав уточняется",
        path: "после первого входа",
      },
    ],
  },
  {
    code: "payme",
    title: "Payme для бизнеса",
    subtitle: "Платежи и выплаты",
    url: "https://merchant.payme.uz/business",
    reports: [
      {
        code: "reports",
        title: "Отчёты",
        ru: "состав уточняется",
        path: "после первого входа",
      },
    ],
  },
  {
    code: "vendinghub",
    title: "VendHub office",
    subtitle: "Наш кабинет",
    url: "https://vendinghub.uz/office/",
    reports: [
      {
        code: "operating",
        title: "Operating report",
        ru: "состав уточняется",
        path: "office/operatingReport",
      },
    ],
  },
] as const;

/**
 * Номер колонки, играющей роль, в конкретной выгрузке.
 *
 * −1 значит «в этой выгрузке такой колонки нет»: источник переименовал её или
 * отчёт другой. Это не ошибка, а факт, который экран обязан показать словами,
 * а не молча взять соседнюю колонку.
 */
export function roleColumnIndex(
  columns: readonly string[],
  roles: RawColumnRoles | undefined,
  role: keyof RawColumnRoles,
): number {
  const names = roles?.[role];
  if (!names) return -1;
  const wanted = (typeof names === "string" ? [names] : names).map(normalizeSourceKey);
  return columns.findIndex((c) => wanted.includes(normalizeSourceKey(c)));
}

/** Как роль называется у источника — для показа владельцу («колонка …»). */
export function roleColumnName(
  roles: RawColumnRoles | undefined,
  role: keyof RawColumnRoles,
): string | null {
  const names = roles?.[role];
  if (!names) return null;
  return typeof names === "string" ? names : (names[0] ?? null);
}

/** Система по коду. undefined — код чужой, принимать выгрузку нельзя. */
export function findRawSource(sourceCode: string): RawSourceDef | undefined {
  return RAW_SOURCES.find((s) => s.code === sourceCode);
}

/** Отчёт по паре кодов. undefined — такого отчёта в справочнике нет. */
export function findRawReport(sourceCode: string, reportCode: string): RawReportDef | undefined {
  return findRawSource(sourceCode)?.reports.find((r) => r.code === reportCode);
}

/**
 * Состояние отчёта — три РАЗНЫХ вещи, которые нельзя смешивать:
 * - `never` — выгрузок не было ни разу (не «ноль продаж», а «мы не смотрели»);
 * - `stale` — выгрузки были, но последняя старше порога свежести;
 * - `fresh` — есть свежая выгрузка.
 */
export type RawFreshness = "never" | "stale" | "fresh";

/** Сколько дней выгрузка считается свежей. Ручной сбор — раз в неделю нормально. */
export const RAW_FRESH_DAYS = 7;

/** Свежесть по времени последнего снимка. Без снимков — честное «never». */
export function rawFreshness(
  lastFetchedAt: string | Date | null | undefined,
  now: Date = new Date(),
  freshDays: number = RAW_FRESH_DAYS,
): RawFreshness {
  if (!lastFetchedAt) return "never";
  const ts = new Date(lastFetchedAt).getTime();
  if (!Number.isFinite(ts)) return "never";
  const ageDays = (now.getTime() - ts) / 86_400_000;
  return ageDays <= freshDays ? "fresh" : "stale";
}
