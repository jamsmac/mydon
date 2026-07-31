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

/**
 * Поля карточки товара, без которых чек по нему не собирается.
 *
 * Это не «желательно заполнить», а условие фискализации: нет ИКПУ, упаковки
 * или ставки НДС — чек не примут, и продажа пройдёт мимо кассы, даже если
 * деньги получены. Список живёт здесь, а не в экране: по нему считают и Core,
 * и оболочка, и расходиться они не имеют права.
 */
export const FISCAL_FIELDS = ["ИКПУ", "упаковка", "НДС"] as const;
export type FiscalField = (typeof FISCAL_FIELDS)[number];

/**
 * Длина кода ИКПУ.
 *
 * Перенесено из рабочих систем владельца, где правило одно и то же:
 * `validate_fiscal` в mydon-stock («ИКПУ должен быть 17 цифр или пусто») и
 * `IKPU_CODE_REGEX = /^\d{17}$/` в VendHub-OS. Своего правила не выдумываем:
 * чек принимает касса, а не мы.
 */
export const IKPU_DIGITS = 17;

/** Чем именно плохо поле: его нет или оно заполнено неверно. */
export type FiscalFlaw = "нет" | "неверно";

export interface FiscalGap {
  field: FiscalField;
  flaw: FiscalFlaw;
  /** Что не так — словами, чтобы владелец чинил, а не гадал. */
  why: string;
}

/** Число из значения поля: «12», «12%», «12 %», «12,5» — одно и то же. */
function asRate(value: unknown): number | null {
  // Неразрывные пробелы записаны кодами: в исходнике их не отличить от обычных.
  const s = String(value)
    .replace(/[\s\u00A0\u202F%]/g, "")
    .replace(",", ".");
  if (s.length === 0) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * Что мешает выбить чек по карточке. Пусто — соберётся.
 *
 * Различаются два состояния, и смешивать их нельзя: поля нет — его не
 * выясняли; поле есть, но короче 17 цифр — кто-то вписал огрызок, карточка
 * выглядит заполненной, а чек всё равно не пройдёт. Второе опаснее первого
 * именно тем, что незаметно.
 *
 * Ставка НДС 0 — законное значение (льготные позиции), и незаполненным оно не
 * считается: в Узбекистане ноль записывается явно, а пустое поле значит «не
 * выясняли». Выдавать одно за другое нельзя.
 */
export function fiscalGaps(attrs: Record<string, unknown> | null | undefined): FiscalGap[] {
  const a = attrs ?? {};
  const gaps: FiscalGap[] = [];
  const empty = (v: unknown) => v === null || v === undefined || String(v).trim().length === 0;

  const ikpu = a["ИКПУ"];
  if (empty(ikpu)) gaps.push({ field: "ИКПУ", flaw: "нет", why: "код не выяснен" });
  else {
    const digits = String(ikpu).replace(/[\s\u00A0\u202F-]/g, "");
    if (!new RegExp(`^\\d{${IKPU_DIGITS}}$`).test(digits)) {
      gaps.push({
        field: "ИКПУ",
        flaw: "неверно",
        why: `должно быть ${IKPU_DIGITS} цифр, а тут ${digits.length}`,
      });
    }
  }

  if (empty(a["упаковка"])) gaps.push({ field: "упаковка", flaw: "нет", why: "единица не выбрана" });

  const vat = a["НДС"];
  if (empty(vat)) gaps.push({ field: "НДС", flaw: "нет", why: "ставка не выяснена" });
  else {
    const rate = asRate(vat);
    if (rate === null || rate < 0 || rate > 100) {
      gaps.push({ field: "НДС", flaw: "неверно", why: "ставка читается не как процент" });
    }
  }

  return gaps;
}

/**
 * Все роли колонок и как они называются по-русски.
 *
 * Нужен списком, а не только типом: экран назначения ролей перебирает его,
 * чтобы владелец видел все роли сразу, включая те, которых в отчёте нет.
 */
export const RAW_ROLES = [
  "machine",
  "point",
  "product",
  "flavour",
  "amount",
  "ts",
  "externalId",
  "status",
  "kind",
  "payment",
  "fulfilment",
] as const satisfies readonly (keyof RawColumnRoles)[];

/** Что роль значит — владелец читает это, а не английский ключ. */
export const RAW_ROLE_LABELS: Record<keyof RawColumnRoles, string> = {
  machine: "Автомат (серийник)",
  point: "Точка (адрес)",
  product: "Товар",
  flavour: "Вкус",
  amount: "Сумма",
  ts: "Время операции",
  externalId: "Номер операции",
  status: "Статус оплаты",
  kind: "Тип операции",
  payment: "Способ оплаты",
  fulfilment: "Чем закончилась выдача",
};

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
            // Расшифровки сняты с форматтеров панели, и это её слова, а не наши.
            //
            // «userDefined» интерфейс панели называет «Таможенный платеж».
            // Название явно не про вендинг, но заменять его своей догадкой
            // нельзя: справочник расшифровок — тоже сырьё, он передаёт то, как
            // источник сам называет свой код. Свой перевод здесь был бы такой
            // же подменой, как правка строки в raw_row.
            //
            // Поэтому код помечен неподтверждённым, а не переименован: на нём
            // 181,3 млн сум, и чем это на самом деле окажется — Payme, Click,
            // Uzum или списание бонусов, — покажет сверка с этими системами,
            // когда они появятся среди источников. Не раньше.
            values: {
              cash: "наличные",
              cash0: "наличные с нулевой суммой",
              userDefined: "Таможенный платеж",
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
    // Системы владельца, названные в ТЗ и в отчёте по данным. Адреса кабинетов
    // намеренно пусты: их вписывает владелец с экрана. Выдумать правдоподобный
    // адрес — та же подмена факта догадкой, что и выдумать колонку отчёта.
    code: "click",
    title: "Click",
    subtitle: "Платежи · кабинет мерчанта",
    url: "",
    reports: [{ code: "reports", title: "Отчёты", ru: "состав уточняется", path: "после первого входа" }],
  },
  {
    code: "uzum",
    title: "Uzum",
    subtitle: "Платежи · кабинет мерчанта",
    url: "",
    reports: [{ code: "reports", title: "Отчёты", ru: "состав уточняется", path: "после первого входа" }],
  },
  {
    code: "multikassa",
    title: "Multikassa",
    subtitle: "Фискализация чеков",
    url: "",
    reports: [{ code: "reports", title: "Отчёты", ru: "состав уточняется", path: "после первого входа" }],
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

/**
 * Правка или дополнение справочника, сделанные владельцем.
 *
 * Приходит из базы. Отличается от `RawSourceDef` тем, что отчёты могут быть
 * заданы частично: владелец завёл систему, а отчёты добавит позже.
 */
export interface RawSourceOverride {
  code: string;
  title: string;
  subtitle: string;
  url: string;
  archived: boolean;
  reports: RawReportOverride[];
}

export interface RawReportOverride {
  code: string;
  title: string;
  ru: string;
  path: string;
  /** Роли, назначенные владельцем по настоящим заголовкам выгрузки. */
  roles: RawColumnRoles;
  archived: boolean;
}

/** Откуда взялась запись справочника — владельцу это видно на экране. */
export type RegistryOrigin = "code" | "owner";

/** Отчёт действующего справочника: определение плюс его происхождение. */
export type EffectiveReport = RawReportDef & { origin: RegistryOrigin };
/** Система действующего справочника. */
export type EffectiveSource = Omit<RawSourceDef, "reports"> & {
  origin: RegistryOrigin;
  reports: EffectiveReport[];
};

/** Пусто ли назначение ролей: ни одной роли не задано. */
function noRoles(roles: RawColumnRoles | undefined): boolean {
  return roles === undefined || Object.keys(roles).length === 0;
}

/**
 * Действующий справочник: код плюс правки владельца.
 *
 * Правило разрешения одно и простое: **запись владельца важнее записи в коде**
 * с тем же кодом, а записи, которых в коде нет, добавляются. Код при этом
 * остаётся основой — выложенное однажды знание об источнике не теряется, даже
 * если базу вычистят.
 *
 * Исключение ровно одно: пустое поле правки не затирает заполненное в коде.
 * Владелец, заведший систему одним названием, не должен нечаянно стереть адрес
 * кабинета, который уже был описан.
 *
 * Отдельной функцией — здесь решается, чьё слово главнее, и такое место обязано
 * быть закреплено тестом.
 */
export function mergeRegistry(
  seed: readonly RawSourceDef[],
  overrides: readonly RawSourceOverride[],
): EffectiveSource[] {
  const byCode = new Map<string, RawSourceOverride>(overrides.map((o) => [o.code, o]));
  const out: EffectiveSource[] = [];

  for (const src of seed) {
    const own = byCode.get(src.code);
    byCode.delete(src.code);
    if (own?.archived) continue;
    const reportOverrides = new Map((own?.reports ?? []).map((r) => [r.code, r]));
    const reports: EffectiveReport[] = [];
    for (const rep of src.reports) {
      const ro = reportOverrides.get(rep.code);
      reportOverrides.delete(rep.code);
      if (ro?.archived) continue;
      reports.push({
        ...rep,
        title: ro?.title || rep.title,
        ru: ro?.ru || rep.ru,
        path: ro?.path || rep.path,
        // Роли — целиком чьи-то одни: смешивать назначения владельца с
        // описанием в коде значило бы собрать отчёт, которого нет ни у кого.
        ...(ro && !noRoles(ro.roles) ? { roles: ro.roles } : {}),
        origin: ro ? "owner" : "code",
      });
    }
    for (const ro of reportOverrides.values()) {
      if (ro.archived) continue;
      reports.push({
        code: ro.code,
        title: ro.title,
        ru: ro.ru,
        path: ro.path,
        ...(noRoles(ro.roles) ? {} : { roles: ro.roles }),
        origin: "owner",
      });
    }
    out.push({
      code: src.code,
      title: own?.title || src.title,
      subtitle: own?.subtitle || src.subtitle,
      url: own?.url || src.url,
      origin: own ? "owner" : "code",
      reports,
    });
  }

  for (const own of byCode.values()) {
    if (own.archived) continue;
    out.push({
      code: own.code,
      title: own.title,
      subtitle: own.subtitle,
      url: own.url,
      origin: "owner",
      reports: own.reports
        .filter((r) => !r.archived)
        .map((r) => ({
          code: r.code,
          title: r.title,
          ru: r.ru,
          path: r.path,
          ...(noRoles(r.roles) ? {} : { roles: r.roles }),
          origin: "owner" as const,
        })),
    });
  }

  return out;
}

/** Код источника: латиница, цифры и подчёркивание. Он попадает в адреса и в базу. */
export function isValidSourceCode(code: string): boolean {
  return /^[a-z][a-z0-9_]{1,63}$/.test(code);
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
