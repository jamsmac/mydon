import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { entity, rawLink, rawReportDef, rawRow, rawSnapshot, rawSourceDef, sale } from "@mydon/db";
import {
  FISCAL_FIELDS,
  RAW_LINK_LABELS,
  RAW_ROLES,
  RAW_SOURCES,
  decodeRawValue,
  isValidFiscalValue,
  isValidSourceCode,
  mergeRegistry,
  fiscalGaps,
  normalizeSourceKey,
  roleColumnIndex,
  roleColumnName,
  type FiscalGap,
  type RawColumnRoles,
  type EffectiveReport,
  type EffectiveSource,
  type RawFreshness,
  type RawSourceOverride,
  type RawLinkKind,
  rawFreshness,
  reconcile,
  unify,
  reconcileOurVend,
  type ReconField,
  type ReconRow,
  type Reconciliation,
  type UnifiedJournal,
  type OurVendRecon,
  type OurVendBucket,
  type DailyBucket,
} from "@mydon/shared";
import { and, asc, eq, gte, lte, sql, type SQL } from "drizzle-orm";
import { DB, type Db } from "../db/db.module";
import { EventsService } from "../events/events.service";

/** Сколько строк максимум отдаём за один запрос: страница, а не вся выгрузка. */
const MAX_PAGE = 1000;
/** Потолок выгрузки для скачивания: больше владелец в браузере всё равно не унесёт. */
export const MAX_EXPORT = 20_000;
/** Разумный предел числа колонок — защита от мусорного индекса в фильтре. */
const MAX_COLUMNS = 512;
/**
 * Сколько дней без заказов делают автомат молчащим.
 *
 * Считается от последнего заказа в выгрузке, а не от сегодняшнего дня: выгрузка
 * может быть месячной давности, и тогда молчащими вышли бы все.
 */
export const PRICE_ACTIVE_DAYS = 14;

/** Снимок отчёта: что и когда сняли у источника. */
export interface RawSnapshotMeta {
  id: string;
  sourceCode: string;
  reportCode: string;
  fetchedAt: string;
  periodFrom: string | null;
  periodTo: string | null;
  account: string | null;
  /** Сколько строк показывал источник (может быть больше, чем в снимке). */
  rowsTotal: number | null;
  columns: string[];
  /** Сколько строк реально лежит у нас. */
  rows: number;
  importedBy: string | null;
  note: string | null;
}

/** Строка отчёта — ровно как пришла. */
export interface RawRowOut {
  idx: number;
  cells: string[];
}

/** Состояние отчёта для списка источников. */
export interface RawReportState {
  sourceCode: string;
  reportCode: string;
  /** Сколько выгрузок этого отчёта у нас лежит. */
  snapshots: number;
  lastFetchedAt: string | null;
  freshness: RawFreshness;
  /** Строк в последнем снимке. */
  rows: number;
  /** Сколько было у источника на момент последнего снимка. */
  rowsTotal: number | null;
  columns: number;
}

/** Что владелец видит в списке слева. */
export interface RawOverview {
  sources: {
    code: string;
    title: string;
    subtitle: string;
    url: string;
    /** Подключён = хоть одна выгрузка дошла. Не запись в конфиге, а факт. */
    connected: boolean;
    reports: (RawReportState & { title: string; ru: string; path: string })[];
  }[];
}

/**
 * Фильтр по одной колонке.
 *
 * По умолчанию — вхождение: владелец ищет «кардио» и находит все точки
 * кардиологии. Но у кодов источника вхождение врёт: `cash` находит и `cash0`,
 * а это разные каналы оплаты, и при сверке с выпиской такая подмена дорого
 * стоит. Поэтому значение, начинающееся с `=`, ищется целиком.
 */
export interface ColumnFilter {
  value: string;
  exact: boolean;
}

/** Разбор фильтров по колонкам: ключи вида `f3` → индекс колонки. */
export function parseColumnFilters(query: Record<string, unknown>): Map<number, ColumnFilter> {
  const out = new Map<number, ColumnFilter>();
  for (const [key, value] of Object.entries(query)) {
    const m = /^f(\d+)$/.exec(key);
    if (!m) continue;
    const idx = Number(m[1]);
    if (!Number.isInteger(idx) || idx < 0 || idx >= MAX_COLUMNS) continue;
    const raw = typeof value === "string" ? value.trim() : "";
    if (raw.length === 0) continue;
    const exact = raw.startsWith("=");
    const v = exact ? raw.slice(1).trim() : raw;
    // «=» без значения — это не фильтр «пусто», а мусор в адресе.
    if (v.length === 0) continue;
    out.set(idx, { value: v, exact });
  }
  return out;
}

/** Ввод запроса строк — из строки адреса, поэтому всё приходит текстом. */
export interface RawRowsQueryInput {
  q?: string;
  sort?: string;
  dir?: string;
  page?: string;
  size?: string;
  [key: string]: unknown;
}

/** Приведённый запрос: только проверенные числа, чтобы не собирать SQL из мусора. */
export interface RawRowsQuery {
  q: string;
  sort: number | null;
  dir: "asc" | "desc";
  page: number;
  size: number;
  offset: number;
  filters: Map<number, ColumnFilter>;
}

/**
 * Приведение параметров страницы к безопасным значениям.
 * Отдельной функцией — это единственное место, где числа из адреса попадают
 * в SQL, и его надо покрыть тестами.
 */
export function normalizeRowsQuery(input: RawRowsQueryInput, maxSize = MAX_PAGE): RawRowsQuery {
  const num = (v: unknown, fallback: number): number => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
  };
  const size = Math.min(num(input.size, 100), maxSize);
  const page = num(input.page, 1);
  // Пустая строка приводится к нулю, а ноль — это колонка. Без явной проверки
  // «sort=» в адресе молча сортировал бы по первой колонке вместо порядка
  // источника, а порядок источника на сыром слое — тоже факт.
  const sortRaw =
    typeof input.sort === "string" && input.sort.trim().length > 0 ? Number(input.sort) : NaN;
  const sort = Number.isInteger(sortRaw) && sortRaw >= 0 && sortRaw < MAX_COLUMNS ? sortRaw : null;
  return {
    q: typeof input.q === "string" ? input.q.trim() : "",
    sort,
    dir: input.dir === "desc" ? "desc" : "asc",
    page,
    size,
    offset: (page - 1) * size,
    filters: parseColumnFilters(input),
  };
}

/** Экранирование значения для CSV: точка с запятой — разделитель Excel в ru-локали. */
export function csvCell(value: string): string {
  const v = String(value ?? "").replace(/"/g, '""');
  return /[;\n\r"]/.test(v) ? `"${v}"` : v;
}

/** Готовый CSV с BOM: без него Excel открывает кириллицу кракозябрами. */
export function toCsv(columns: string[], rows: RawRowOut[]): string {
  const head = ["#", ...columns].map(csvCell).join(";");
  const body = rows.map((r) => [String(r.idx), ...r.cells].map(csvCell).join(";"));
  // BOM записан кодом: в исходнике он невидим, а без него Excel открывает
  // кириллицу кракозябрами.
  return `\uFEFF${[head, ...body].join("\r\n")}`;
}

/** Одно значение источника и его судьба: узнали мы его или нет. */
export interface RawMappingValue {
  /** Нормализованный ключ — по нему хранится решение владельца. */
  key: string;
  /** Написание источника: владельцу показываем его, а не наш нормализованный вид. */
  label: string;
  /** В скольких строках снимка встретилось. */
  count: number;
  entityId: string | null;
  entityName: string | null;
  /** auto — совпало по точному ключу, owner — связал владелец, null — не узнано. */
  decidedBy: "auto" | "owner" | string | null;
  /** Владелец решил, что карточка не нужна (например «testShipment»). */
  dismissed: boolean;
  /**
   * Куда это значение можно записать одним нажатием.
   *
   * У адреса это карточки автоматов, которые стоят на нём по той же выгрузке:
   * незнакомая точка чинится не новой сущностью, а дозаполнением карточки.
   */
  targets?: { id: string; name: string }[];
}

/** Группа сопоставления — одна роль колонки. */
export interface RawMappingGroup {
  kind: RawLinkKind;
  label: string;
  /** Название колонки источника. null — такой колонки в выгрузке нет. */
  column: string | null;
  /** Можно ли привязывать руками. У точек пока нет своих карточек. */
  bindable: boolean;
  matched: number;
  unmatched: number;
  values: RawMappingValue[];
}

export interface RawMapping {
  snapshot: RawSnapshotMeta | null;
  groups: RawMappingGroup[];
}

/** Сколько разных значений одной роли разбираем: длинный хвост владельцу не нужен. */
const MAX_MAPPING_VALUES = 500;

/** Отрезок стоянки автомата на одной точке. */
export interface MachineStay {
  /** Адрес так, как его пишет источник. */
  point: string;
  /** Первый и последний заказ на этой точке — по ним и виден переезд. */
  from: string;
  to: string;
  orders: number;
  /**
   * Отрезок пересекается с соседним по времени.
   *
   * У переезда стыки идут подряд: последний заказ на старой точке, потом
   * первый на новой. Пересечение значит, что источник путает адреса, и
   * выдавать такое за переезд нельзя.
   */
  overlaps: boolean;
}

/** История стоянок одного автомата. */
export interface MachineStays {
  /** Серийник, как его пишет источник. */
  serial: string;
  /** Карточка автомата, если серийник узнан. */
  entityId: string | null;
  entityName: string | null;
  /** Отрезки по возрастанию времени: первый — самый старый. */
  stays: MachineStay[];
  /** Сколько раз автомат переезжал (отрезков минус один). */
  moves: number;
}

/**
 * Ведро цены: сколько заказов одного товара прошло по одной цене за один месяц.
 *
 * Месяц — не произвол, а компромисс: по одному ведру на цену за всю выгрузку
 * нельзя восстановить порядок (цена вернулась — отрезки слиплись бы в один), а
 * по дням вёдер выходит сотни тысяч. Внутри месяца порядок всё равно точный:
 * у ведра есть время первого и последнего заказа.
 */
export interface PriceBucket {
  month: string;
  price: number;
  from: string;
  to: string;
  orders: number;
}

/** Отрезок, на котором у автомата держалась одна цена товара. */
export interface PricePeriod {
  price: number;
  from: string;
  to: string;
  orders: number;
}

/** Цены одного товара на одном автомате. */
export interface MachineProductPrice {
  serial: string;
  entityId: string | null;
  entityName: string | null;
  /** Название товара так, как его пишет источник. */
  product: string;
  productEntityId: string | null;
  productEntityName: string | null;
  /** Текущая цена — цена последнего отрезка. null — отрезков не вышло. */
  price: number | null;
  periods: PricePeriod[];
  /** Сколько раз цена менялась (отрезков минус один). */
  changes: number;
  orders: number;
  /**
   * Заказы по другой цене вперемешку с основной.
   *
   * Сменой цены это не считается: у настоящей смены старая цена кончается
   * раньше, чем начинается новая. Вперемешку — признак подмены кнопки
   * (пробит один напиток, приготовлен другой), и деньги там от другого товара.
   */
  mismatched: number;
  lastOrderAt: string | null;
}

/** Один автомат в сквозном срезе по товару. */
export interface ProductPriceMachine {
  serial: string;
  entityId: string | null;
  entityName: string | null;
  price: number;
  /** С какого момента держится эта цена. */
  since: string;
  orders: number;
  lastOrderAt: string;
  /** Автомат ещё торгует — иначе это не отставание, а молчание. */
  active: boolean;
  /** Насколько ниже эталона. 0 — вровень или выше. */
  gap: number;
  /** Заказов с того момента, как эталон стал ценой большинства. */
  ordersSince: number;
  /** Недобор: разница в цене на эти заказы. */
  lost: number;
}

/** Цены одного товара по всем автоматам. */
export interface ProductPriceSpread {
  product: string;
  entityId: string | null;
  entityName: string | null;
  /** Цена большинства автоматов. null — большинства нет, эталон брать неоткуда. */
  reference: number | null;
  /** Когда эталон стал ценой большинства. От него и считается недобор. */
  referenceSince: string | null;
  machines: ProductPriceMachine[];
  /** Сколько автоматов торгует дешевле эталона. */
  behind: number;
  lost: number;
}

/** Разбор цен по всей выгрузке. */
export interface PriceReview {
  products: ProductPriceSpread[];
  /** Суммарный недобор по всем товарам. */
  lost: number;
  /** Последний заказ в выгрузке — от него, а не от «сегодня», считается «активен». */
  lastOrderAt: string | null;
  /** Заказы, у которых цена не читается числом. Молча отбрасывать их нельзя. */
  unreadable: number;
}

/**
 * Подсказка «похоже, это тот же напиток под другим именем».
 *
 * Именно подсказка: сливать названия сам код не имеет права. В панели живут
 * «Какао» и Cocoa, и решить, один это товар или два, может только владелец —
 * поэтому рядом с подсказкой всегда лежит основание, по которому она выдана.
 */
export interface ProductLookalike {
  name: string;
  /** Почему подсказали — словами и с числами, а не «похоже». */
  reason: string;
  entityId: string | null;
  entityName: string | null;
  revenue: number;
  orders: number;
}

/** Товар глазами источника: сколько принёс и можно ли по нему выбить чек. */
export interface SourceProduct {
  /** Название так, как его пишет источник. */
  name: string;
  orders: number;
  revenue: number;
  /** Заказы с нечитаемой ценой — в выручку не вошли. */
  unreadable: number;
  firstOrderAt: string;
  lastOrderAt: string;
  entityId: string | null;
  entityName: string | null;
  /**
   * Карточка утверждена владельцем. false — заведена из источника и ждёт его
   * слова: она есть, но фактом реестра ещё не стала.
   */
  approved: boolean;
  /** Владелец решил, что карточка не нужна. Не то же самое, что «не смотрел». */
  dismissed: boolean;
  decidedBy: string | null;
  /**
   * Что мешает выбить чек по карточке. Пусто — соберётся.
   * Карточки нет вовсе — здесь весь список: не собирается ничего.
   */
  gaps: FiscalGap[];
  lookalikes: ProductLookalike[];
}

/** Разбор ассортимента источника. */
export interface ProductReview {
  products: SourceProduct[];
  /** Вся выручка выгрузки (без тестовых отгрузок). */
  revenue: number;
  /** Выручка, по которой чек не собирается: нет карточки или она неполная. */
  blockedRevenue: number;
  /** Позиций без карточки. */
  noCard: number;
  /** Позиций с карточкой, но без фискальных полей. */
  incomplete: number;
  lastOrderAt: string | null;
}

/** Месяц одного канала оплаты — строка, с которой идут сверять выписку. */
export interface PaymentMonth {
  month: string;
  orders: number;
  revenue: number;
}

/** Автомат в разрезе одного канала оплаты. */
export interface PaymentMachine {
  serial: string;
  entityId: string | null;
  entityName: string | null;
  orders: number;
  revenue: number;
}

/**
 * Канал оплаты так, как его называет источник.
 *
 * Код не переводится и не переименовывается: `userDefined` остаётся
 * `userDefined`, а рядом лежит то, как его называет сама панель. Чем канал
 * окажется на деле, решит сверка с платёжными системами, а не мы.
 */
export interface PaymentChannel {
  /** Код источника. */
  code: string;
  /** Как называет его источник. null — расшифровки нет, и выдумывать её нельзя. */
  label: string | null;
  /** Смысл подтверждён. false — показывать вопросом, а не фактом. */
  confirmed: boolean;
  orders: number;
  revenue: number;
  /** Заказы с нечитаемой ценой — в сумму не вошли. */
  unreadable: number;
  firstOrderAt: string;
  lastOrderAt: string;
  months: PaymentMonth[];
  machines: PaymentMachine[];
}

/** Срез по каналам оплаты — основание для сверки с платёжными системами. */
export interface PaymentReview {
  channels: PaymentChannel[];
  orders: number;
  revenue: number;
  /** Выручка по каналам, смысл которых источник не объясняет. */
  unconfirmedRevenue: number;
  /**
   * Номер колонки канала в этой выгрузке — чтобы с экрана можно было уйти
   * в сами заказы, отфильтрованные по коду, а не верить сводке на слово.
   */
  column: number;
  lastOrderAt: string | null;
}

/**
 * Откуда взялась величина в журнале.
 *
 * Это не оформление, а суть: владелец обязан видеть, что перед ним — цифра
 * панели, наша догадка или результат сверки. Смешивать их в одну таблицу без
 * пометки значит выдавать одно за другое.
 */
export type FieldOrigin =
  /** Первоисточник: ровно то, что отдала панель. Мы это не считали. */
  | "source"
  /** Реестр MYDON: сопоставленная карточка. */
  | "registry"
  /** Наш разбор поверх сырья: цена периода, точка на момент заказа. */
  | "derived"
  /** Другой источник: то, с чем сверяем. */
  | "cross";

/** Состояние величины по отношению к сверке. */
export type FieldState =
  /** Первоисточник — сверять не с чем и не нужно. */
  | "source"
  /** Ещё не сверено с другими источниками. */
  | "unchecked"
  /** Сверено, сходится. */
  | "matched"
  /** Сверено, расходится — обе цифры показываются рядом. */
  | "mismatch"
  /** В другом источнике этого нет. */
  | "absent";

/** Куда ведёт ссылка «посмотреть первоисточник». */
export interface FieldLink {
  kind: "raw" | "prices" | "goods" | "payments" | "stays" | "card";
  /** Значение для фильтра или идентификатор карточки. */
  ref?: string;
}

/** Одна величина журнала со своей родословной. */
export interface JournalField {
  label: string;
  value: string | null;
  origin: FieldOrigin;
  state: FieldState;
  /** Пояснение словами: почему расходится, чего не хватает. */
  note?: string | null;
  link?: FieldLink | null;
}

/** Группа величин в раскрытой строке журнала. */
export interface JournalGroup {
  title: string;
  origin: FieldOrigin;
  /** Откуда группа: имя системы или слоя — владелец читает это, а не код. */
  subtitle: string;
  fields: JournalField[];
}

/** Одна продажа в журнале. */
export interface JournalOrder {
  /** Номер строки в снимке — по нему находится первоисточник. */
  idx: number;
  externalId: string;
  ts: string;
  machine: string;
  machineEntityId: string | null;
  machineName: string | null;
  product: string;
  productEntityId: string | null;
  amount: string;
  payment: string;
  paymentLabel: string | null;
  paymentConfirmed: boolean;
  status: string;
  /** Худшее состояние среди величин строки — по нему красится строка. */
  state: FieldState;
  groups: JournalGroup[];
}

/** Страница журнала продаж. */
export interface Journal {
  snapshot: RawSnapshotMeta | null;
  total: number;
  page: number;
  size: number;
  orders: JournalOrder[];
  /** Колонка № заказа в этой выгрузке — для ссылки в первоисточник. */
  externalIdColumn: number;
  /** Адрес кабинета источника: сама панель, а не наша копия. */
  sourceUrl: string;
  /** Сколько строк страницы уже сверено с другим источником. */
  checked: number;
  mismatched: number;
}

/** Что принимаем при загрузке выгрузки. */
export interface RawImportInput {
  source: string;
  report: string;
  fetchedAt: string;
  periodFrom?: string;
  periodTo?: string;
  account?: string;
  rowsTotal?: number;
  columns?: string[];
  rows: string[][];
  note?: string;
  importedBy?: string;
  /** Дописать строки к уже начатому снимку (выгрузка приходит частями). */
  append?: boolean;
  /**
   * Номер первой строки пачки в исходной выгрузке (с нуля).
   *
   * Нужен, чтобы повтор пачки после обрыва связи лёг на то же место, а не
   * добавился хвостом. Дедупликация именно по позиции, а НЕ по содержимому:
   * в самой панели три заказа задвоены, и отбрасывание одинаковых строк
   * молча выкинуло бы то, что источник действительно отдал.
   */
  offset?: number;
}

/**
 * Сырой слой источников.
 *
 * Ничего не считает и не переименовывает: принимает выгрузку как есть и отдаёт
 * её обратно постранично. Любая аналитика поверх — отдельная работа, и она не
 * имеет права править этот слой: он существует, чтобы спорную цифру можно было
 * сверить с распечаткой источника.
 */
@Injectable()
export class RawService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly events: EventsService,
  ) {}

  /**
   * Действующий справочник: код плюс правки владельца из базы.
   *
   * Всё, что спрашивает про источник или отчёт, ходит сюда, а не в RAW_SOURCES
   * напрямую: иначе система, заведённая владельцем с экрана, была бы видна на
   * одном экране и невидима на другом.
   */
  async registry(): Promise<EffectiveSource[]> {
    const [sources, reports] = await Promise.all([
      this.db.select().from(rawSourceDef),
      this.db.select().from(rawReportDef),
    ]);
    const byCode = new Map<string, RawSourceOverride>();
    for (const s of sources) {
      byCode.set(s.code, {
        code: s.code,
        title: s.title,
        subtitle: s.subtitle,
        url: s.url,
        archived: s.archivedAt !== null,
        reports: [],
      });
    }
    for (const r of reports) {
      const own =
        byCode.get(r.sourceCode) ??
        // Отчёт заведён у системы, которая целиком описана в коде: правки по
        // самой системе нет, но отчёт всё равно должен попасть в справочник.
        ({ code: r.sourceCode, title: "", subtitle: "", url: "", archived: false, reports: [] } satisfies RawSourceOverride);
      own.reports.push({
        code: r.code,
        title: r.title,
        ru: r.ru,
        path: r.path,
        roles: r.roles as RawColumnRoles,
        archived: r.archivedAt !== null,
      });
      byCode.set(r.sourceCode, own);
    }
    return mergeRegistry(RAW_SOURCES, [...byCode.values()]);
  }

  /** Система действующего справочника. undefined — код чужой. */
  async source(sourceCode: string): Promise<EffectiveSource | undefined> {
    return (await this.registry()).find((s) => s.code === sourceCode);
  }

  /** Отчёт действующего справочника. Бросает — значит такого отчёта нет. */
  async report(sourceCode: string, reportCode: string): Promise<EffectiveReport> {
    const rep = (await this.source(sourceCode))?.reports.find((r) => r.code === reportCode);
    if (!rep) throw new NotFoundException("Такого отчёта нет в справочнике источников");
    return rep;
  }

  /**
   * Завести или поправить систему-источник.
   *
   * Пустое поле НЕ затирает то, что описано в коде: владелец, заведший систему
   * одним названием, не должен нечаянно стереть адрес кабинета.
   */
  async saveSource(input: {
    code: string;
    title: string;
    subtitle?: string;
    url?: string;
    archived?: boolean;
  }): Promise<{ ok: true }> {
    if (!isValidSourceCode(input.code)) {
      throw new NotFoundException(
        "Код системы — латиница, цифры и подчёркивание, начиная с буквы: он попадает в адрес и в базу",
      );
    }
    const values = {
      code: input.code,
      title: input.title.trim(),
      subtitle: (input.subtitle ?? "").trim(),
      url: (input.url ?? "").trim(),
      archivedAt: input.archived ? new Date() : null,
      updatedAt: new Date(),
    };
    if (values.title.length === 0) throw new NotFoundException("У системы должно быть название");
    await this.db
      .insert(rawSourceDef)
      .values(values)
      .onConflictDoUpdate({ target: rawSourceDef.code, set: values });
    return { ok: true };
  }

  /**
   * Завести или поправить отчёт.
   *
   * Роли здесь не задаются: их назначают по настоящим заголовкам выгрузки
   * (setRoles), а не по памяти. Угадывать название колонки, которой не видел, —
   * то же самое, что выдумывать данные.
   */
  async saveReport(input: {
    source: string;
    code: string;
    title: string;
    ru?: string;
    path?: string;
    archived?: boolean;
  }): Promise<{ ok: true }> {
    if (!isValidSourceCode(input.code)) {
      throw new NotFoundException("Код отчёта — латиница, цифры и подчёркивание, начиная с буквы");
    }
    if (!(await this.source(input.source))) {
      throw new NotFoundException(`Системы «${input.source}» нет в справочнике`);
    }
    const title = input.title.trim();
    if (title.length === 0) throw new NotFoundException("У отчёта должно быть название");
    const values = {
      sourceCode: input.source,
      code: input.code,
      title,
      ru: (input.ru ?? "").trim(),
      path: (input.path ?? "").trim(),
      archivedAt: input.archived ? new Date() : null,
      updatedAt: new Date(),
    };
    await this.db
      .insert(rawReportDef)
      .values(values)
      .onConflictDoUpdate({
        target: [rawReportDef.sourceCode, rawReportDef.code],
        set: { ...values, roles: sql`${rawReportDef.roles}` },
      });
    return { ok: true };
  }

  /**
   * Назначить роли колонок отчёта.
   *
   * Принимаются только те названия, которые действительно есть в последней
   * выгрузке: роль, указывающая на несуществующую колонку, — это молчаливо
   * сломанный срез, а не описание отчёта.
   */
  async setRoles(
    sourceCode: string,
    reportCode: string,
    roles: Record<string, string>,
  ): Promise<{ ok: true; roles: RawColumnRoles }> {
    const snapshot = await this.latestSnapshot(sourceCode, reportCode);
    const columns = snapshot?.columns ?? [];
    const known = new Map(columns.map((c) => [normalizeSourceKey(c), c]));
    const next: Record<string, string[]> = {};
    for (const [role, column] of Object.entries(roles)) {
      if (!RAW_ROLES.includes(role as keyof RawColumnRoles)) continue;
      const value = (column ?? "").trim();
      // Пусто — осознанное «этой роли в отчёте нет». Это законное состояние.
      if (value.length === 0) continue;
      const real = known.get(normalizeSourceKey(value));
      if (!real) {
        throw new NotFoundException(
          `Колонки «${value}» нет в последней выгрузке — назначать роль на неё нельзя`,
        );
      }
      next[role] = [real];
    }
    const rep = await this.report(sourceCode, reportCode);
    const values = {
      sourceCode,
      code: reportCode,
      title: rep.title,
      ru: rep.ru,
      path: rep.path,
      roles: next,
      updatedAt: new Date(),
    };
    await this.db
      .insert(rawReportDef)
      .values(values)
      .onConflictDoUpdate({
        target: [rawReportDef.sourceCode, rawReportDef.code],
        set: { roles: next, updatedAt: values.updatedAt },
      });
    return { ok: true, roles: next as RawColumnRoles };
  }

  /** Список источников с состоянием каждого отчёта. */
  async overview(): Promise<RawOverview> {
    const snapshots = await this.db
      .select({
        id: rawSnapshot.id,
        sourceCode: rawSnapshot.sourceCode,
        reportCode: rawSnapshot.reportCode,
        fetchedAt: rawSnapshot.fetchedAt,
        rowsTotal: rawSnapshot.rowsTotal,
        columns: rawSnapshot.columns,
      })
      .from(rawSnapshot);

    const counts = await this.db
      .select({ snapshotId: rawRow.snapshotId, n: sql<number>`count(*)` })
      .from(rawRow)
      .groupBy(rawRow.snapshotId);
    const rowsBySnapshot = new Map(counts.map((c) => [c.snapshotId, Number(c.n)]));

    const now = new Date();
    const key = (s: string, r: string) => `${s}::${r}`;
    const byReport = new Map<string, typeof snapshots>();
    for (const s of snapshots) {
      const k = key(s.sourceCode, s.reportCode);
      const list = byReport.get(k);
      if (list) list.push(s);
      else byReport.set(k, [s]);
    }

    const effective = await this.registry();
    const sources = effective.map((src) => {
      const reports = src.reports.map((rep) => {
        const list = (byReport.get(key(src.code, rep.code)) ?? [])
          .slice()
          .sort((a, b) => b.fetchedAt.getTime() - a.fetchedAt.getTime());
        const last = list[0];
        return {
          sourceCode: src.code,
          reportCode: rep.code,
          title: rep.title,
          ru: rep.ru,
          path: rep.path,
          origin: rep.origin,
          roles: (rep.roles ?? {}) as Record<string, unknown>,
          snapshots: list.length,
          lastFetchedAt: last ? last.fetchedAt.toISOString() : null,
          freshness: rawFreshness(last?.fetchedAt ?? null, now),
          rows: last ? (rowsBySnapshot.get(last.id) ?? 0) : 0,
          rowsTotal: last?.rowsTotal ?? null,
          columns: last ? last.columns.length : 0,
        };
      });
      return {
        code: src.code,
        title: src.title,
        subtitle: src.subtitle,
        url: src.url,
        origin: src.origin,
        connected: reports.some((r) => r.snapshots > 0),
        reports,
      };
    });

    return { sources };
  }

  /** Последний снимок отчёта. null — отчёт ещё ни разу не выгружался. */
  async latestSnapshot(sourceCode: string, reportCode: string): Promise<RawSnapshotMeta | null> {
    const [row] = await this.db
      .select()
      .from(rawSnapshot)
      .where(
        and(eq(rawSnapshot.sourceCode, sourceCode), eq(rawSnapshot.reportCode, reportCode)),
      )
      .orderBy(sql`${rawSnapshot.fetchedAt} desc`)
      .limit(1);
    if (!row) return null;
    const [{ n }] = await this.db
      .select({ n: sql<number>`count(*)` })
      .from(rawRow)
      .where(eq(rawRow.snapshotId, row.id));
    return {
      id: row.id,
      sourceCode: row.sourceCode,
      reportCode: row.reportCode,
      fetchedAt: row.fetchedAt.toISOString(),
      periodFrom: row.periodFrom,
      periodTo: row.periodTo,
      account: row.account,
      rowsTotal: row.rowsTotal,
      columns: row.columns,
      rows: Number(n),
      importedBy: row.importedBy,
      note: row.note,
    };
  }

  /** Условия выборки строк: поиск по всем колонкам + фильтры по отдельным. */
  private conditions(snapshotId: string, query: RawRowsQuery): SQL[] {
    const conds: SQL[] = [eq(rawRow.snapshotId, snapshotId)];
    if (query.q.length > 0) {
      conds.push(sql`${rawRow.cells}::text ilike ${`%${query.q}%`}`);
    }
    for (const [idx, filter] of query.filters) {
      // Индекс колонки — только проверенное целое (normalizeRowsQuery), поэтому
      // его можно подставить в текст запроса: параметром оператор `->>` не
      // выбрать, Postgres не знает, число это или ключ объекта. Само значение
      // всегда идёт параметром.
      const cell = sql`coalesce(${rawRow.cells}->>${sql.raw(String(idx))}, '')`;
      conds.push(
        filter.exact
          ? sql`lower(btrim(${cell})) = lower(btrim(${filter.value}))`
          : sql`${cell} ilike ${`%${filter.value}%`}`,
      );
    }
    return conds;
  }

  /** Порядок строк: по умолчанию — как в источнике. */
  private order(query: RawRowsQuery): SQL[] {
    if (query.sort === null) return [asc(rawRow.idx)];
    const col = sql.raw(String(query.sort));
    const dir = sql.raw(query.dir === "desc" ? "desc" : "asc");
    // Числа сравниваем числами, остальное — текстом: «20 000» не должно
    // оказываться меньше «9», как это выходит при сравнении строк.
    const numeric = sql`case when coalesce(${rawRow.cells}->>${col}, '') ~ '^\\s*-?[0-9]+([.,][0-9]+)?\\s*$'
      then replace(btrim(${rawRow.cells}->>${col}), ',', '.')::numeric end`;
    return [
      sql`${numeric} ${dir} nulls last`,
      sql`coalesce(${rawRow.cells}->>${col}, '') ${dir}`,
      asc(rawRow.idx),
    ];
  }

  /** Страница строк снимка + сколько всего подошло под фильтры. */
  async rows(
    snapshotId: string,
    query: RawRowsQuery,
  ): Promise<{ total: number; rows: RawRowOut[] }> {
    const conds = this.conditions(snapshotId, query);
    const [{ n }] = await this.db
      .select({ n: sql<number>`count(*)` })
      .from(rawRow)
      .where(and(...conds));
    const rows = await this.db
      .select({ idx: rawRow.idx, cells: rawRow.cells })
      .from(rawRow)
      .where(and(...conds))
      .orderBy(...this.order(query))
      .limit(query.size)
      .offset(query.offset);
    return { total: Number(n), rows };
  }

  /** Строки для скачивания: та же выборка, но одним куском и с потолком. */
  async exportRows(snapshotId: string, query: RawRowsQuery): Promise<RawRowOut[]> {
    const { rows } = await this.rows(snapshotId, {
      ...query,
      page: 1,
      size: MAX_EXPORT,
      offset: 0,
    });
    return rows;
  }

  /**
   * Пары значений двух колонок снимка.
   *
   * Нужны, чтобы связать адрес с автоматом, который на нём стоит: сама выгрузка
   * это знает, и спрашивать владельца незачем.
   */
  private async distinctPairs(
    snapshotId: string,
    idxA: number,
    idxB: number,
  ): Promise<{ a: string; b: string }[]> {
    const colA = sql.raw(String(idxA));
    const colB = sql.raw(String(idxB));
    const a = sql<string>`coalesce(${rawRow.cells}->>${colA}, '')`;
    const b = sql<string>`coalesce(${rawRow.cells}->>${colB}, '')`;
    const rows = await this.db
      .selectDistinct({ a, b })
      .from(rawRow)
      .where(eq(rawRow.snapshotId, snapshotId))
      .limit(MAX_MAPPING_VALUES * 4);
    return rows;
  }

  /** Разные значения одной колонки снимка с частотой. */
  private async distinctValues(
    snapshotId: string,
    idx: number,
  ): Promise<{ label: string; count: number }[]> {
    const col = sql.raw(String(idx));
    const value = sql<string>`coalesce(${rawRow.cells}->>${col}, '')`;
    const rows = await this.db
      .select({ label: value, n: sql<number>`count(*)` })
      .from(rawRow)
      .where(eq(rawRow.snapshotId, snapshotId))
      .groupBy(value)
      .orderBy(sql`count(*) desc`)
      .limit(MAX_MAPPING_VALUES);
    return rows.map((r) => ({ label: r.label, count: Number(r.n) }));
  }

  /**
   * Сопоставление выгрузки с карточками реестра.
   *
   * Порядок разрешения: решение владельца важнее любого совпадения; если
   * решения нет — пробуем точное совпадение по ключу; если и его нет — честное
   * «не узнано», и это работа для владельца, а не повод что-то придумать.
   */
  async mapping(sourceCode: string, reportCode: string): Promise<RawMapping> {
    const report = await this.report(sourceCode, reportCode);

    const snapshot = await this.latestSnapshot(sourceCode, reportCode);
    if (!snapshot) return { snapshot: null, groups: [] };

    const [machines, products, links] = await Promise.all([
      this.db
        .select({ id: entity.id, name: entity.name, ref: entity.externalRef, attrs: entity.attrs })
        .from(entity)
        .where(eq(entity.type, "machine")),
      this.db
        .select({ id: entity.id, name: entity.name })
        .from(entity)
        .where(eq(entity.type, "product")),
      this.db.select().from(rawLink).where(eq(rawLink.sourceCode, sourceCode)),
    ]);

    // Ключ → карточка. Серийник автомата и название товара — точные ключи.
    const byMachineSerial = new Map<string, { id: string; name: string }>();
    for (const m of machines) {
      if (m.ref) byMachineSerial.set(normalizeSourceKey(m.ref), { id: m.id, name: m.name });
    }
    const byProductName = new Map<string, { id: string; name: string }>();
    for (const p of products) byProductName.set(normalizeSourceKey(p.name), { id: p.id, name: p.name });
    // Точка узнаётся по карточке автомата: отдельных карточек точек пока нет.
    const byPoint = new Map<string, { id: string; name: string }>();
    for (const m of machines) {
      const point = (m.attrs as Record<string, unknown>)["точка"];
      if (typeof point === "string" && point.trim().length > 0) {
        byPoint.set(normalizeSourceKey(point), { id: m.id, name: m.name });
      }
    }

    const linkByKey = new Map(links.map((l) => [`${l.kind}::${l.externalKey}`, l]));
    const entityNameById = new Map<string, string>([
      ...machines.map((m) => [m.id, m.name] as const),
      ...products.map((p) => [p.id, p.name] as const),
    ]);

    const plan: { kind: RawLinkKind; role: keyof RawColumnRoles; bindable: boolean }[] = [
      { kind: "machine", role: "machine", bindable: true },
      { kind: "product", role: "product", bindable: true },
      { kind: "point", role: "point", bindable: false },
    ];

    // Адрес чинится дозаполнением карточки автомата, поэтому для точек заранее
    // выясняем, какие автоматы стоят на каждом адресе по этой же выгрузке.
    const machineIdx = roleColumnIndex(snapshot.columns, report.roles, "machine");
    const pointIdx = roleColumnIndex(snapshot.columns, report.roles, "point");
    const machinesAtPoint = new Map<string, { id: string; name: string }[]>();
    if (machineIdx >= 0 && pointIdx >= 0) {
      for (const pair of await this.distinctPairs(snapshot.id, pointIdx, machineIdx)) {
        if (pair.a.trim().length === 0 || pair.b.trim().length === 0) continue;
        const card = byMachineSerial.get(normalizeSourceKey(pair.b));
        if (!card) continue;
        const key = normalizeSourceKey(pair.a);
        const list = machinesAtPoint.get(key) ?? [];
        if (!list.some((m) => m.id === card.id)) list.push(card);
        machinesAtPoint.set(key, list);
      }
    }

    const groups: RawMappingGroup[] = [];
    for (const step of plan) {
      const columnName = roleColumnName(report.roles, step.role);
      const idx = roleColumnIndex(snapshot.columns, report.roles, step.role);
      if (idx < 0) {
        groups.push({
          kind: step.kind,
          label: RAW_LINK_LABELS[step.kind],
          column: columnName,
          bindable: step.bindable,
          matched: 0,
          unmatched: 0,
          values: [],
        });
        continue;
      }

      const auto =
        step.kind === "machine" ? byMachineSerial : step.kind === "product" ? byProductName : byPoint;
      const raw = await this.distinctValues(snapshot.id, idx);

      // Разные написания одного значения схлопываем: владельцу разбирать один раз.
      const merged = new Map<string, RawMappingValue>();
      for (const { label, count } of raw) {
        if (label.trim().length === 0) continue;
        const key = normalizeSourceKey(label);
        const seen = merged.get(key);
        if (seen) {
          seen.count += count;
          continue;
        }
        const decided = linkByKey.get(`${step.kind}::${key}`);
        const hit = auto.get(key);
        merged.set(key, {
          key,
          label,
          count,
          entityId: decided ? decided.entityId : (hit?.id ?? null),
          entityName: decided
            ? decided.entityId
              ? (entityNameById.get(decided.entityId) ?? null)
              : null
            : (hit?.name ?? null),
          decidedBy: decided ? decided.decidedBy : hit ? "auto" : null,
          dismissed: decided ? decided.entityId === null : false,
          ...(step.kind === "point" ? { targets: machinesAtPoint.get(key) ?? [] } : {}),
        });
      }

      const values = [...merged.values()].sort((a, b) => b.count - a.count);
      groups.push({
        kind: step.kind,
        label: RAW_LINK_LABELS[step.kind],
        column: columnName,
        bindable: step.bindable,
        matched: values.filter((v) => v.entityId !== null || v.dismissed).length,
        unmatched: values.filter((v) => v.entityId === null && !v.dismissed).length,
        values,
      });
    }

    return { snapshot, groups };
  }

  /**
   * Построчная сверка двух источников по номеру операции.
   *
   * Существует ради вопроса «где источники расходятся», а не ради их слияния:
   * свести журнал можно только после того, как видно, где они не сходятся.
   * gjvending и vendinghub показывают одни и те же заказы (Order number =
   * orderNo), поэтому сверка построчная, а не дневная, как с OurVend.
   *
   * Сверяются роли, которые есть у ОБОИХ отчётов: чего у одного нет, тем и
   * сверять нечего. Правило слоя цело — сверка ничего не пишет.
   */
  async reconcileSources(
    aSource: string,
    aReport: string,
    bSource: string,
    bReport: string,
  ): Promise<
    Reconciliation & {
      a: { source: string; report: string; title: string };
      b: { source: string; report: string; title: string };
    }
  > {
    const input = await this.reconInputs(aSource, aReport, bSource, bReport);
    if (!input) {
      return {
        totalA: 0, totalB: 0, matched: 0, conflicts: [], onlyA: [], onlyB: [],
        onlyACount: 0, onlyBCount: 0, duplicatesA: [], duplicatesB: [], fields: [],
        ...(await this.reconMeta(aSource, aReport, bSource, bReport)),
      };
    }
    return { ...reconcile(input.rowsA, input.rowsB, input.fields), ...input.meta };
  }

  /**
   * Объединённый журнал: два источника — один список заказов по номеру операции.
   *
   * То же извлечение строк, что и у сверки, но итог иной: не «где расходятся», а
   * единый журнал без задвоения. Сверка — предшественник, объединение — цель.
   * Правило слоя цело: где источники спорят, показаны оба значения, победителя
   * не назначаем.
   */
  async unifySources(
    aSource: string,
    aReport: string,
    bSource: string,
    bReport: string,
    query: RawRowsQuery,
  ): Promise<
    UnifiedJournal & {
      a: { source: string; report: string; title: string };
      b: { source: string; report: string; title: string };
      ourvend: OurVendRecon;
    }
  > {
    const input = await this.reconInputs(aSource, aReport, bSource, bReport);
    if (!input) {
      return {
        totalA: 0, totalB: 0, union: 0, both: 0, onlyA: 0, onlyB: 0,
        conflicts: 0, duplicated: 0, page: query.page, size: query.size, orders: [],
        ourvend: reconcileOurVend([], []),
        ...(await this.reconMeta(aSource, aReport, bSource, bReport)),
      };
    }
    // daily — свёртка ВСЕГО союза до «день+автомат+товар»; сюда OurVend и
    // приходит третьей дневной дорожкой. Из ответа клиенту daily убираем: ему
    // нужен итог сверки (ourvend), а не сами корзины.
    const { daily, ...journal } = unify(input.rowsA, input.rowsB, input.fields, query.page, query.size);
    const ourvend = await this.ourvendReconciliation(daily);
    return { ...journal, ...input.meta, ourvend };
  }

  /**
   * Дневная сверка союза с дневным потоком OurVend (строки `sale`).
   *
   * Поток `sale` (синк OurVend через mydon-stock) свёрнут до дня — в нём нет ни
   * номера заказа, ни времени внутри дня, поэтому вливается он не построчно, как
   * gjvending с vendinghub, а дневным итогом. Это ограничение потока, а не
   * платформы: отчёт OurVend по времени, загруженный в сырой слой, войдёт в союз
   * построчно через тот же unifySources. Диапазон берём по дням союза:
   * спрашивать у потока больше, чем есть в союзе, незачем.
   */
  private async ourvendReconciliation(daily: DailyBucket[]): Promise<OurVendRecon> {
    if (daily.length === 0) return reconcileOurVend([], []);
    const days = daily.map((b) => b.day).sort();
    const from = days[0];
    const to = days[days.length - 1];
    const rows = await this.db
      .select({
        dt: sale.dt,
        serial: sale.machineSerial,
        product: sale.product,
        qty: sale.qty,
        amount: sale.amount,
        source: sale.source,
      })
      .from(sale)
      .where(and(gte(sale.dt, from), lte(sale.dt, to)));
    const ourvend: OurVendBucket[] = rows.map((r) => ({
      day: r.dt,
      serial: r.serial,
      product: r.product,
      revenue: Number(r.amount),
      orders: Number(r.qty),
      source: r.source,
    }));
    return reconcileOurVend(daily, ourvend);
  }

  /**
   * Объединённый журнал файлом: весь союз, чтобы разобрать спорные в Excel.
   *
   * Плоская таблица, а не карточки экрана: на каждый заказ — строка, на каждое
   * поле — две колонки, по одной на источник. Владелец видит оба значения рядом
   * и решает, какое верное. Разбивки на страницы в файле нет — забираем весь
   * союз (до MAX_EXPORT, как и выгрузка сырых строк).
   */
  async unifyExportCsv(
    aSource: string,
    aReport: string,
    bSource: string,
    bReport: string,
  ): Promise<string> {
    const input = await this.reconInputs(aSource, aReport, bSource, bReport);
    // BOM записан кодом: без него Excel открывает кириллицу кракозябрами.
    if (!input) return `\uFEFFНечего объединять: у одного из отчётов нет роли «номер операции»`;

    const { fields, rowsA, rowsB, meta } = input;
    const u = unify(rowsA, rowsB, fields, 1, MAX_EXPORT);
    const aT = meta.a.title;
    const bT = meta.b.title;

    const header = ["Номер операции", "Где", "Спорный", "Задвоен"];
    for (const f of fields) header.push(`${f.label} · ${aT}`, `${f.label} · ${bT}`);

    const lines = [header.map(csvCell).join(";")];
    for (const o of u.orders) {
      const byRole = new Map(o.fields.map((x) => [x.role, x]));
      const where =
        o.presence === "both" ? "оба" : o.presence === "onlyA" ? `только ${aT}` : `только ${bT}`;
      const cols: string[] = [o.key, where, o.conflict ? "да" : "", o.duplicated ? "да" : ""];
      for (const f of fields) {
        const v = byRole.get(f.role);
        cols.push(v?.a ?? "", v?.b ?? "");
      }
      lines.push(cols.map(csvCell).join(";"));
    }
    return `\uFEFF${lines.join("\r\n")}`;
  }

  /** Заголовки источников для шапки сверки/объединения — без строк. */
  private async reconMeta(
    aSource: string,
    aReport: string,
    bSource: string,
    bReport: string,
  ): Promise<{
    a: { source: string; report: string; title: string };
    b: { source: string; report: string; title: string };
  }> {
    const [defA, defB] = await Promise.all([
      this.report(aSource, aReport),
      this.report(bSource, bReport),
    ]);
    return {
      a: { source: aSource, report: aReport, title: defA.title },
      b: { source: bSource, report: bReport, title: defB.title },
    };
  }

  /**
   * Общая заготовка для сверки и объединения: строки обоих источников, ключом
   * которых служит externalId, плюс роли, присутствующие у ОБОИХ отчётов.
   *
   * Ключ — externalId: сопоставлять заказы по совпадению всех полей значило бы
   * выдумать связь, которой в данных нет. Нет ключа хоть у одного — сводить
   * нечем, возвращаем null.
   */
  private async reconInputs(
    aSource: string,
    aReport: string,
    bSource: string,
    bReport: string,
  ): Promise<{
    meta: {
      a: { source: string; report: string; title: string };
      b: { source: string; report: string; title: string };
    };
    fields: ReconField[];
    rowsA: ReconRow[];
    rowsB: ReconRow[];
  } | null> {
    const [defA, defB] = await Promise.all([
      this.report(aSource, aReport),
      this.report(bSource, bReport),
    ]);
    const meta = {
      a: { source: aSource, report: aReport, title: defA.title },
      b: { source: bSource, report: bReport, title: defB.title },
    };
    const [snapA, snapB] = await Promise.all([
      this.latestSnapshot(aSource, aReport),
      this.latestSnapshot(bSource, bReport),
    ]);
    if (!snapA || !snapB) return null;

    const keyA = roleColumnIndex(snapA.columns, defA.roles, "externalId");
    const keyB = roleColumnIndex(snapB.columns, defB.roles, "externalId");
    if (keyA < 0 || keyB < 0) return null;

    // Берём роли, общие для обоих отчётов, кроме самого ключа.
    const COMPARABLE: { role: keyof RawColumnRoles; label: string; compare: ReconField["compare"] }[] = [
      { role: "machine", label: "Автомат", compare: "key" },
      { role: "product", label: "Товар", compare: "key" },
      { role: "amount", label: "Сумма", compare: "number" },
      { role: "ts", label: "Время", compare: "exact" },
      { role: "payment", label: "Оплата", compare: "exact" },
      { role: "status", label: "Статус", compare: "exact" },
      { role: "kind", label: "Тип", compare: "exact" },
    ];
    const fields: ReconField[] = [];
    const idxA: Record<string, number> = {};
    const idxB: Record<string, number> = {};
    for (const c of COMPARABLE) {
      const ia = roleColumnIndex(snapA.columns, defA.roles, c.role);
      const ib = roleColumnIndex(snapB.columns, defB.roles, c.role);
      if (ia < 0 || ib < 0) continue;
      fields.push({ role: c.role, label: c.label, compare: c.compare });
      idxA[c.role] = ia;
      idxB[c.role] = ib;
    }

    const toRows = async (
      snapshotId: string,
      keyIdx: number,
      idx: Record<string, number>,
    ): Promise<ReconRow[]> => {
      const rows = await this.db
        .select({ cells: rawRow.cells })
        .from(rawRow)
        .where(eq(rawRow.snapshotId, snapshotId));
      return rows.map((r) => {
        const cells = r.cells;
        const values: Record<string, string> = {};
        for (const [role, i] of Object.entries(idx)) values[role] = cells[i] ?? "";
        return { key: cells[keyIdx] ?? "", values };
      });
    };

    const [rowsA, rowsB] = await Promise.all([
      toRows(snapA.id, keyA, idxA),
      toRows(snapB.id, keyB, idxB),
    ]);

    return { meta, fields, rowsA, rowsB };
  }

  /**
   * История стоянок автоматов, восстановленная из заказов.
   *
   * Точка автомата — не поле, а период: переставили автомат, начался новый
   * отрезок. Журнала переездов никто не вёл, но факт уже записан в каждом
   * заказе — адрес и время. Отсюда история строится задним числом за весь
   * период выгрузки и ничего не требует от владельца.
   *
   * Ничего не додумывается: если отрезки пересекаются, это не переезд, а
   * путаница в источнике, и она помечается, а не сглаживается.
   */
  async machineStays(sourceCode: string, reportCode: string): Promise<MachineStays[]> {
    const report = await this.report(sourceCode, reportCode);
    const snapshot = await this.latestSnapshot(sourceCode, reportCode);
    if (!snapshot) return [];

    const mIdx = roleColumnIndex(snapshot.columns, report.roles, "machine");
    const pIdx = roleColumnIndex(snapshot.columns, report.roles, "point");
    const tIdx = roleColumnIndex(snapshot.columns, report.roles, "ts");
    if (mIdx < 0 || pIdx < 0 || tIdx < 0) return [];

    const m = sql.raw(String(mIdx));
    const p = sql.raw(String(pIdx));
    const t = sql.raw(String(tIdx));
    const serial = sql<string>`coalesce(${rawRow.cells}->>${m}, '')`;
    const point = sql<string>`coalesce(${rawRow.cells}->>${p}, '')`;
    const rows = await this.db
      .select({
        serial,
        point,
        from: sql<string>`min(coalesce(${rawRow.cells}->>${t}, ''))`,
        to: sql<string>`max(coalesce(${rawRow.cells}->>${t}, ''))`,
        n: sql<number>`count(*)`,
      })
      .from(rawRow)
      .where(eq(rawRow.snapshotId, snapshot.id))
      .groupBy(serial, point);

    const machines = await this.db
      .select({ id: entity.id, name: entity.name, ref: entity.externalRef })
      .from(entity)
      .where(eq(entity.type, "machine"));
    const bySerial = new Map(
      machines
        .filter((x) => x.ref !== null && x.ref.length > 0)
        .map((x) => [normalizeSourceKey(x.ref!), { id: x.id, name: x.name }]),
    );

    const grouped = new Map<string, { point: string; from: string; to: string; orders: number }[]>();
    for (const r of rows) {
      if (r.serial.trim().length === 0 || r.point.trim().length === 0) continue;
      const list = grouped.get(r.serial) ?? [];
      list.push({ point: r.point, from: r.from, to: r.to, orders: Number(r.n) });
      grouped.set(r.serial, list);
    }

    const out: MachineStays[] = [];
    for (const [serialValue, list] of grouped) {
      const card = bySerial.get(normalizeSourceKey(serialValue)) ?? null;
      out.push({
        serial: serialValue,
        entityId: card?.id ?? null,
        entityName: card?.name ?? null,
        stays: markOverlaps(list),
        moves: Math.max(0, list.length - 1),
      });
    }
    // Сначала те, кто переезжал чаще: там и вопросов больше.
    out.sort((a, b) => b.moves - a.moves || a.serial.localeCompare(b.serial));
    return out;
  }

  /**
   * Вёдра цен: заказы, сгруппированные по автомату, товару, цене и месяцу.
   *
   * Здесь впервые за весь сырой слой цена приводится к числу — и это законно:
   * слой разбора имеет на это право, сырьё при этом не меняется. «15000» и
   * «15000.00» — одна цена, и считать их разными значило бы придумать смену.
   *
   * Что в расчёт не идёт и почему:
   * - тестовые отгрузки (`testShipment`) — это не продажа;
   * - нулевая цена — не цена, а отметка о выдаче без денег.
   */
  private async priceBuckets(
    snapshot: RawSnapshotMeta,
    roles: RawColumnRoles | undefined,
  ): Promise<{
    rows: { serial: string; product: string; bucket: PriceBucket }[];
    unreadable: number;
  }> {
    const mIdx = roleColumnIndex(snapshot.columns, roles, "machine");
    const pIdx = roleColumnIndex(snapshot.columns, roles, "product");
    const aIdx = roleColumnIndex(snapshot.columns, roles, "amount");
    const tIdx = roleColumnIndex(snapshot.columns, roles, "ts");
    if (mIdx < 0 || pIdx < 0 || aIdx < 0 || tIdx < 0) return { rows: [], unreadable: 0 };
    const kIdx = roleColumnIndex(snapshot.columns, roles, "kind");

    const cell = (idx: number) => sql<string>`coalesce(${rawRow.cells}->>${sql.raw(String(idx))}, '')`;
    const serial = cell(mIdx);
    const product = cell(pIdx);
    const ts = cell(tIdx);
    const amount = cell(aIdx);
    // Цена числом. Не число — не цена: такие заказы считаются отдельно и
    // показываются владельцу, а не выбрасываются молча.
    const price = sql<string>`case when ${amount} ~ '^\\s*-?[0-9]+([.,][0-9]+)?\\s*$'
      then replace(btrim(${amount}), ',', '.')::numeric end`;
    const month = sql<string>`substr(${ts}, 1, 7)`;

    // Тестовые отгрузки не продажа, поэтому не участвуют ни в расчёте, ни в
    // счётчике нечитаемых цен: иначе «не вошло в расчёт» относилось бы к
    // другому набору строк, чем сам расчёт.
    const base: SQL[] = [eq(rawRow.snapshotId, snapshot.id)];
    if (kIdx >= 0) base.push(sql`lower(btrim(${cell(kIdx)})) <> 'testshipment'`);
    const conds: SQL[] = [...base, sql`${price} > 0`];

    const rows = await this.db
      .select({
        serial,
        product,
        month,
        price,
        from: sql<string>`min(${ts})`,
        to: sql<string>`max(${ts})`,
        n: sql<number>`count(*)`,
      })
      .from(rawRow)
      .where(and(...conds))
      .groupBy(serial, product, month, price);

    const [{ n: unreadable }] = await this.db
      .select({ n: sql<number>`count(*)` })
      .from(rawRow)
      .where(and(...base, sql`${price} is null`));

    return {
      rows: rows
        .filter((r) => r.serial.trim().length > 0 && r.product.trim().length > 0)
        .map((r) => ({
          serial: r.serial,
          product: r.product,
          bucket: {
            month: r.month,
            price: Number(r.price),
            from: r.from,
            to: r.to,
            orders: Number(r.n),
          },
        })),
      unreadable: Number(unreadable),
    };
  }

  /** Карточки автоматов и товаров по ключам источника — для подписей и ссылок. */
  private async priceCards(sourceCode: string): Promise<{
    bySerial: Map<string, { id: string; name: string }>;
    byProduct: Map<string, { id: string; name: string }>;
  }> {
    const [machines, products, links] = await Promise.all([
      this.db
        .select({ id: entity.id, name: entity.name, ref: entity.externalRef })
        .from(entity)
        .where(eq(entity.type, "machine")),
      this.db.select({ id: entity.id, name: entity.name }).from(entity).where(eq(entity.type, "product")),
      this.db.select().from(rawLink).where(eq(rawLink.sourceCode, sourceCode)),
    ]);
    const bySerial = new Map<string, { id: string; name: string }>();
    for (const m of machines) {
      if (m.ref) bySerial.set(normalizeSourceKey(m.ref), { id: m.id, name: m.name });
    }
    const byProduct = new Map<string, { id: string; name: string }>();
    for (const p of products) byProduct.set(normalizeSourceKey(p.name), { id: p.id, name: p.name });
    // Решение владельца важнее совпадения по названию — как и на экране
    // сопоставления: «карточка не нужна» тоже решение и его надо уважать.
    const nameById = new Map(products.map((p) => [p.id, p.name] as const));
    for (const l of links) {
      if (l.kind !== "product") continue;
      const card = l.entityId ? nameById.get(l.entityId) : undefined;
      if (l.entityId && card) byProduct.set(l.externalKey, { id: l.entityId, name: card });
      else byProduct.delete(l.externalKey);
    }
    return { bySerial, byProduct };
  }

  /** Отрезки цен по каждой паре «автомат + товар». Основа обоих срезов. */
  private async priceTimelines(
    sourceCode: string,
    reportCode: string,
  ): Promise<{
    items: MachineProductPrice[];
    buckets: Map<string, PriceBucket[]>;
    unreadable: number;
    lastOrderAt: string | null;
  }> {
    const report = await this.report(sourceCode, reportCode);
    const snapshot = await this.latestSnapshot(sourceCode, reportCode);
    if (!snapshot) return { items: [], buckets: new Map(), unreadable: 0, lastOrderAt: null };

    const [{ rows, unreadable }, cards] = await Promise.all([
      this.priceBuckets(snapshot, report.roles),
      this.priceCards(sourceCode),
    ]);

    const buckets = new Map<string, PriceBucket[]>();
    const names = new Map<string, { serial: string; product: string }>();
    let lastOrderAt: string | null = null;
    for (const r of rows) {
      const key = timelineKey(r.serial, r.product);
      const list = buckets.get(key) ?? [];
      list.push(r.bucket);
      buckets.set(key, list);
      // Написание берём от первой встреченной строки: владельцу показывают то,
      // как пишет источник, а не наш нормализованный вид.
      if (!names.has(key)) names.set(key, { serial: r.serial, product: r.product });
      if (lastOrderAt === null || r.bucket.to > lastOrderAt) lastOrderAt = r.bucket.to;
    }

    const items: MachineProductPrice[] = [];
    for (const [key, list] of buckets) {
      const { serial, product } = names.get(key)!;
      const { periods, mismatched } = buildPricePeriods(list);
      const card = cards.bySerial.get(normalizeSourceKey(serial)) ?? null;
      const pcard = cards.byProduct.get(normalizeSourceKey(product)) ?? null;
      const last = periods[periods.length - 1];
      items.push({
        serial,
        entityId: card?.id ?? null,
        entityName: card?.name ?? null,
        product,
        productEntityId: pcard?.id ?? null,
        productEntityName: pcard?.name ?? null,
        price: last?.price ?? null,
        periods,
        changes: Math.max(0, periods.length - 1),
        orders: periods.reduce((n, p) => n + p.orders, 0),
        mismatched,
        lastOrderAt: last?.to ?? null,
      });
    }
    return { items, buckets, unreadable, lastOrderAt };
  }

  /** Ассортимент и цены одного автомата — для его карточки. */
  async machinePrices(
    sourceCode: string,
    reportCode: string,
    serial: string,
  ): Promise<MachineProductPrice[]> {
    const { items } = await this.priceTimelines(sourceCode, reportCode);
    const wanted = normalizeSourceKey(serial);
    return items
      .filter((i) => normalizeSourceKey(i.serial) === wanted)
      // Сначала то, чем торгуют сейчас и чаще: остальное — хвост истории.
      .sort((a, b) => b.orders - a.orders || a.product.localeCompare(b.product, "ru"));
  }

  /**
   * Сквозной срез по ценам: где какой товар почём и кто отстал.
   *
   * Отставание считается не «дешевле всех», а «дешевле цены большинства»:
   * один автомат, где цену подняли раньше срока, не делает остальные отставшими.
   */
  async prices(sourceCode: string, reportCode: string): Promise<PriceReview> {
    const { items, buckets, unreadable, lastOrderAt } = await this.priceTimelines(
      sourceCode,
      reportCode,
    );
    // «Активен» считается от последнего заказа в выгрузке, а не от сегодняшнего
    // дня: выгрузка может быть месячной давности, и тогда молчали бы все.
    const activeAfter = lastOrderAt === null ? null : daysBefore(lastOrderAt, PRICE_ACTIVE_DAYS);

    const byProduct = new Map<string, MachineProductPrice[]>();
    for (const i of items) {
      if (i.price === null || i.lastOrderAt === null) continue;
      const key = normalizeSourceKey(i.product);
      const list = byProduct.get(key) ?? [];
      list.push(i);
      byProduct.set(key, list);
    }

    const products: ProductPriceSpread[] = [];
    for (const list of byProduct.values()) {
      const active = list.filter(
        (i) => activeAfter === null || (i.lastOrderAt !== null && i.lastOrderAt >= activeAfter),
      );
      const reference = referencePrice(active.map((i) => i.price!));
      const since =
        reference === null ? null : referenceSince(active.map((i) => i.periods), reference);

      const machines: ProductPriceMachine[] = list.map((i) => {
        const isActive = activeAfter === null || (i.lastOrderAt !== null && i.lastOrderAt >= activeAfter);
        const gap = reference !== null && isActive && i.price! < reference ? reference - i.price! : 0;
        // Недобор считается только с того момента, как эталон стал ценой
        // большинства: до него отставания не было.
        const ordersSince =
          gap === 0 || since === null
            ? 0
            : (buckets.get(timelineKey(i.serial, i.product)) ?? [])
                .filter((b) => b.price === i.price && b.to >= since)
                .reduce((n, b) => n + b.orders, 0);
        return {
          serial: i.serial,
          entityId: i.entityId,
          entityName: i.entityName,
          price: i.price!,
          since: i.periods[i.periods.length - 1]?.from ?? "",
          orders: i.orders,
          lastOrderAt: i.lastOrderAt!,
          active: isActive,
          gap,
          ordersSince,
          lost: gap * ordersSince,
        };
      });
      machines.sort((a, b) => b.lost - a.lost || a.price - b.price || b.orders - a.orders);

      const first = list[0];
      products.push({
        product: first.product,
        entityId: first.productEntityId,
        entityName: first.productEntityName,
        reference,
        referenceSince: since,
        machines,
        behind: machines.filter((m) => m.gap > 0).length,
        lost: machines.reduce((n, m) => n + m.lost, 0),
      });
    }

    // Сверху то, где деньги уже потеряны; дальше — где просто разнобой в ценах.
    products.sort(
      (a, b) => b.lost - a.lost || b.behind - a.behind || a.product.localeCompare(b.product, "ru"),
    );

    return {
      products,
      lost: products.reduce((n, p) => n + p.lost, 0),
      lastOrderAt,
      unreadable,
    };
  }

  /**
   * Журнал продаж: каждая продажа с её родословной.
   *
   * Главное здесь не колонки, а происхождение каждой величины. Номер заказа,
   * машинный код, ресурс заказа, статус платежа, цена и время — это
   * ПЕРВОИСТОЧНИК: ровно то, что отдала панель, и мы это не считали. Рядом
   * лежат величины другого рода — сопоставленная карточка, точка на момент
   * заказа, цена периода — и они помечены иначе, потому что это уже наш вывод.
   *
   * Третий род — сверка с другим источником. Пока OurVend отдаёт только дневные
   * итоги, сверка идёт по тройке «день + автомат + товар», и так и написано:
   * выдавать дневное сравнение за построчное нельзя.
   */
  async journal(
    sourceCode: string,
    reportCode: string,
    query: RawRowsQuery,
  ): Promise<Journal> {
    const report = await this.report(sourceCode, reportCode);
    const src = await this.source(sourceCode);
    const empty: Journal = {
      snapshot: null,
      total: 0,
      page: query.page,
      size: query.size,
      orders: [],
      externalIdColumn: -1,
      sourceUrl: src?.url ?? "",
      checked: 0,
      mismatched: 0,
    };
    const snapshot = await this.latestSnapshot(sourceCode, reportCode);
    if (!snapshot) return empty;

    const at = (role: keyof RawColumnRoles) => roleColumnIndex(snapshot.columns, report.roles, role);
    const idx = {
      machine: at("machine"),
      product: at("product"),
      flavour: at("flavour"),
      amount: at("amount"),
      ts: at("ts"),
      externalId: at("externalId"),
      status: at("status"),
      kind: at("kind"),
      payment: at("payment"),
      fulfilment: at("fulfilment"),
      point: at("point"),
    };
    // Обязательно только время: без него строка не ложится ни в какой порядок.
    // Автомат и товар нужны не всякому источнику — у выписки платёжной системы
    // их нет вовсе, и требовать их значило бы объявить её непригодной.
    if (idx.ts < 0) return { ...empty, snapshot };

    const { total, rows } = await this.rows(snapshot.id, query);
    if (rows.length === 0) return { ...empty, snapshot, total };

    const cell = (r: RawRowOut, i: number) => (i < 0 ? "" : (r.cells[i] ?? ""));

    // Всё, что нужно для родословной. Стоянки и цены считаются по всей выгрузке
    // — иначе «точка на момент заказа» и «цена периода» брались бы из воздуха.
    const [cards, stays, timelines, dicts] = await Promise.all([
      this.priceCards(sourceCode),
      this.machineStays(sourceCode, reportCode),
      this.priceTimelines(sourceCode, reportCode),
      Promise.resolve(report.dicts ?? []),
    ]);
    const paymentDict = dicts.find((d) => d.role === "payment");
    const fulfilDict = dicts.find((d) => d.role === "fulfilment");

    const staysBySerial = new Map(stays.map((m) => [normalizeSourceKey(m.serial), m]));
    const priceByKey = new Map(
      timelines.items.map((i) => [timelineKey(i.serial, i.product), i]),
    );
    const productCards = await this.db
      .select({ id: entity.id, name: entity.name, attrs: entity.attrs })
      .from(entity)
      .where(eq(entity.type, "product"));
    const attrsById = new Map(productCards.map((c) => [c.id, c.attrs as Record<string, unknown>]));

    // Сверка с другим источником: OurVend отдаёт дневные итоги, поэтому берём
    // ровно те тройки «день + автомат + товар», что встретились на странице.
    // Сверка возможна только там, где есть и автомат, и товар: другой источник
    // отдаёт дневные итоги именно по этой тройке.
    const canCross = idx.machine >= 0 && idx.product >= 0;
    const triples = new Set<string>();
    for (const r of canCross ? rows : []) {
      const day = cell(r, idx.ts).slice(0, 10);
      if (day.length !== 10) continue;
      triples.add(`${day}|${normalizeSourceKey(cell(r, idx.machine))}|${normalizeSourceKey(cell(r, idx.product))}`);
    }
    const days = [...new Set([...triples].map((t) => t.split("|")[0]))].sort();
    const otherByTriple = new Map<string, { qty: number; amount: number; source: string }>();
    if (days.length > 0) {
      const other = await this.db
        .select({
          dt: sale.dt,
          serial: sale.machineSerial,
          product: sale.product,
          qty: sale.qty,
          amount: sale.amount,
          source: sale.source,
        })
        .from(sale)
        .where(and(gte(sale.dt, days[0]), lte(sale.dt, days[days.length - 1])));
      for (const o of other) {
        const key = `${o.dt}|${normalizeSourceKey(o.serial)}|${normalizeSourceKey(o.product)}`;
        const seen = otherByTriple.get(key);
        if (seen) {
          seen.qty += Number(o.qty);
          seen.amount += Number(o.amount);
        } else {
          otherByTriple.set(key, { qty: Number(o.qty), amount: Number(o.amount), source: o.source });
        }
      }
    }

    // Итог этой же выгрузки по тем же тройкам — вторая половина сверки.
    const ourByTriple = new Map<string, { qty: number; amount: number }>();
    if (canCross && idx.amount >= 0 && triples.size > 0) {
      const c = (i: number) => sql<string>`coalesce(${rawRow.cells}->>${sql.raw(String(i))}, '')`;
      const price = sql<string>`case when ${c(idx.amount)} ~ '^\\s*-?[0-9]+([.,][0-9]+)?\\s*$'
        then replace(btrim(${c(idx.amount)}), ',', '.')::numeric end`;
      const day = sql<string>`substr(${c(idx.ts)}, 1, 10)`;
      const conds: SQL[] = [
        eq(rawRow.snapshotId, snapshot.id),
        sql`${day} >= ${days[0]}`,
        sql`${day} <= ${days[days.length - 1]}`,
      ];
      if (idx.kind >= 0) conds.push(sql`lower(btrim(${c(idx.kind)})) <> 'testshipment'`);
      const agg = await this.db
        .select({
          day,
          serial: c(idx.machine),
          product: c(idx.product),
          qty: sql<number>`count(*)`,
          amount: sql<string>`coalesce(sum(${price}), 0)`,
        })
        .from(rawRow)
        .where(and(...conds))
        .groupBy(day, c(idx.machine), c(idx.product));
      for (const a of agg) {
        const key = `${a.day}|${normalizeSourceKey(a.serial)}|${normalizeSourceKey(a.product)}`;
        const seen = ourByTriple.get(key);
        if (seen) {
          seen.qty += Number(a.qty);
          seen.amount += Number(a.amount);
        } else {
          ourByTriple.set(key, { qty: Number(a.qty), amount: Number(a.amount) });
        }
      }
    }

    let checked = 0;
    let mismatched = 0;
    const orders: JournalOrder[] = rows.map((r) => {
      const machine = cell(r, idx.machine);
      const product = cell(r, idx.product);
      const ts = cell(r, idx.ts);
      const amount = cell(r, idx.amount);
      const externalId = cell(r, idx.externalId);
      const payment = cell(r, idx.payment);
      const rawLink: FieldLink = { kind: "raw", ref: externalId };

      // ── Первоисточник: то, что отдала панель, слово в слово ──
      const fromSource = (label: string, value: string): JournalField => ({
        label,
        value: value || null,
        origin: "source",
        state: "source",
        link: rawLink,
      });
      const sourceFields: JournalField[] = [
        fromSource("Номер заказа", externalId),
        fromSource("Машинный код", machine),
        fromSource("Товар", product),
        fromSource("Вкус", cell(r, idx.flavour)),
        fromSource("Цена заказа", amount),
        fromSource("Ресурс заказа", payment),
        fromSource("Статус платежа", cell(r, idx.status)),
        fromSource("Тип заказа", cell(r, idx.kind)),
        fromSource("Статус варки", cell(r, idx.fulfilment)),
        fromSource("Время создания", ts),
        fromSource("Адрес в заказе", cell(r, idx.point)),
      ].filter((f) => f.value !== null);

      // ── Расшифровки: слова панели, а не наш перевод ──
      const paymentDecoded = decodeRawValue(paymentDict, payment);
      const fulfilDecoded = decodeRawValue(fulfilDict, cell(r, idx.fulfilment));
      const decoded: JournalField[] = [];
      if (payment) {
        decoded.push({
          label: "Ресурс заказа",
          value: paymentDecoded?.label ?? null,
          origin: "source",
          state: paymentDecoded && !paymentDecoded.confirmed ? "unchecked" : "source",
          note: paymentDecoded
            ? paymentDecoded.confirmed
              ? "как называет панель"
              : "как называет панель; чем это на деле, покажет сверка с платёжной системой"
            : "источник не объясняет этот код",
          link: { kind: "payments", ref: payment },
        });
      }
      if (fulfilDecoded) {
        decoded.push({
          label: "Статус варки",
          value: fulfilDecoded.label,
          origin: "source",
          state: "source",
          note: "как называет панель",
          link: rawLink,
        });
      }

      // ── Реестр MYDON: что узнано по карточкам ──
      const mcard = cards.bySerial.get(normalizeSourceKey(machine)) ?? null;
      const pcard = cards.byProduct.get(normalizeSourceKey(product)) ?? null;
      const gaps = pcard ? fiscalGaps(attrsById.get(pcard.id)) : [];
      const registry: JournalField[] = [
        {
          label: "Карточка автомата",
          value: mcard?.name ?? null,
          origin: "registry",
          state: mcard ? "matched" : "absent",
          note: mcard ? null : "серийник не сопоставлен ни с одной карточкой",
          link: mcard ? { kind: "card", ref: mcard.id } : { kind: "raw", ref: externalId },
        },
        {
          label: "Карточка товара",
          value: pcard?.name ?? null,
          origin: "registry",
          state: pcard ? "matched" : "absent",
          note: pcard ? null : "товара нет в реестре — чек по нему не собрать",
          link: pcard ? { kind: "card", ref: pcard.id } : { kind: "goods", ref: product },
        },
        {
          label: "ИКПУ",
          value: pcard ? String(attrsById.get(pcard.id)?.["ИКПУ"] ?? "") || null : null,
          origin: "registry",
          state: pcard ? (gaps.length === 0 ? "matched" : "absent") : "absent",
          note:
            gaps.length > 0
              ? `чек не соберётся: ${gaps.map((g) => `${g.field} — ${g.why}`).join("; ")}`
              : pcard
                ? "фискальные поля заполнены"
                : "нет карточки",
          link: { kind: "goods", ref: product },
        },
      ];

      // ── Разбор: наш вывод поверх сырья, а не цифра панели ──
      const stay = staysBySerial.get(normalizeSourceKey(machine));
      const pointThen = stay?.stays.find((s) => s.from <= ts && ts <= s.to) ?? null;
      const line = priceByKey.get(timelineKey(machine, product));
      const periodPrice = line ? priceAt(line.periods, ts) : null;
      const orderPrice = Number(String(amount).replace(",", "."));
      const priceAgrees =
        periodPrice === null || !Number.isFinite(orderPrice) ? null : periodPrice === orderPrice;
      const derived: JournalField[] = [
        {
          label: "Точка на момент заказа",
          value: pointThen?.point ?? null,
          origin: "derived",
          state: pointThen ? (pointThen.overlaps ? "mismatch" : "matched") : "absent",
          note: pointThen
            ? pointThen.overlaps
              ? "периоды стоянки пересекаются — источник путает адреса"
              : "по истории переездов, восстановленной из заказов"
            : "период стоянки для этого времени не найден",
          link: { kind: "stays", ref: machine },
        },
        {
          label: "Цена периода",
          value: periodPrice === null ? null : String(periodPrice),
          origin: "derived",
          state: priceAgrees === null ? "absent" : priceAgrees ? "matched" : "mismatch",
          note:
            priceAgrees === false
              ? "цена заказа не совпадает с ценой, действовавшей тогда: возможна подмена кнопки"
              : priceAgrees
                ? "совпадает с ценой заказа"
                : "цена периода не определена",
          link: { kind: "prices", ref: product },
        },
      ];

      // ── Сверка с другим источником ──
      const day = ts.slice(0, 10);
      const tri = `${day}|${normalizeSourceKey(machine)}|${normalizeSourceKey(product)}`;
      const them = otherByTriple.get(tri);
      const us = ourByTriple.get(tri);
      const cross: JournalField[] = [];
      if (them && us) {
        const agrees = Math.round(them.amount) === Math.round(us.amount);
        checked += 1;
        if (!agrees) mismatched += 1;
        cross.push({
          label: `За день у ${them.source}`,
          value: `${them.qty.toLocaleString("ru-RU")} шт · ${Math.round(them.amount).toLocaleString("ru-RU")} сум`,
          origin: "cross",
          state: agrees ? "matched" : "mismatch",
          note: agrees
            ? `сходится с этой выгрузкой (${us.qty} шт · ${Math.round(us.amount).toLocaleString("ru-RU")} сум). Сверка дневная, не построчная: у ${them.source} нет времени внутри дня`
            : `у этой выгрузки за тот же день ${us.qty} шт · ${Math.round(us.amount).toLocaleString("ru-RU")} сум — расходится`,
          link: rawLink,
        });
      } else if (us) {
        cross.push({
          label: "Другие источники",
          value: null,
          origin: "cross",
          state: "unchecked",
          note: "за этот день по этому автомату и товару другой источник ничего не показывает — сверить не с чем",
          link: null,
        });
      }

      const order: JournalOrder = {
        idx: r.idx,
        externalId,
        ts,
        machine,
        machineEntityId: mcard?.id ?? null,
        machineName: mcard?.name ?? null,
        product,
        productEntityId: pcard?.id ?? null,
        amount,
        payment,
        paymentLabel: paymentDecoded?.label ?? null,
        paymentConfirmed: paymentDecoded?.confirmed ?? false,
        status: cell(r, idx.status),
        state: worstState([...decoded, ...registry, ...derived, ...cross]),
        groups: [
          {
            title: "Первоисточник",
            origin: "source",
            subtitle: `${src?.title ?? sourceCode} · ${report.title}`,
            fields: sourceFields,
          },
          ...(decoded.length > 0
            ? [{ title: "Как называет панель", origin: "source" as const, subtitle: "расшифровки источника", fields: decoded }]
            : []),
          { title: "Реестр MYDON", origin: "registry" as const, subtitle: "сопоставленные карточки", fields: registry },
          { title: "Разбор", origin: "derived" as const, subtitle: "наш вывод поверх сырья", fields: derived },
          ...(cross.length > 0
            ? [{ title: "Сверка с другими источниками", origin: "cross" as const, subtitle: "дневные итоги", fields: cross }]
            : []),
        ],
      };
      return order;
    });

    return {
      snapshot,
      total,
      page: query.page,
      size: query.size,
      orders,
      externalIdColumn: idx.externalId,
      sourceUrl: src?.url ?? "",
      checked,
      mismatched,
    };
  }

  /**
   * Срез по каналам оплаты: сколько денег пришло каким способом.
   *
   * Существует ради сверки. Панель называет один из своих кодов «Таможенный
   * платеж», и на нём 181,3 млн сум — название явно не про вендинг, но
   * заменять его нашей догадкой нельзя: справочник расшифровок такое же
   * сырьё, как и строки. Чем канал окажется на деле — Payme, Click, Uzum или
   * списание бонусов, — покажет сверка с этими системами, а до неё честнее
   * показать код источника со словами «не подтверждено».
   *
   * Поэтому срез разложен по месяцам и автоматам: месячная сумма — это то, с
   * чем идут к выписке платёжной системы, а не просто цифра на экране.
   *
   * Ничего не отфильтровано, включая тестовые выдачи: это срез источника
   * как он есть, и итог обязан сходиться с тем, что показывает панель.
   */
  async paymentReview(sourceCode: string, reportCode: string): Promise<PaymentReview> {
    const report = await this.report(sourceCode, reportCode);
    const empty: PaymentReview = {
      channels: [],
      orders: 0,
      revenue: 0,
      unconfirmedRevenue: 0,
      column: -1,
      lastOrderAt: null,
    };
    const snapshot = await this.latestSnapshot(sourceCode, reportCode);
    if (!snapshot) return empty;

    const cIdx = roleColumnIndex(snapshot.columns, report.roles, "payment");
    const aIdx = roleColumnIndex(snapshot.columns, report.roles, "amount");
    const tIdx = roleColumnIndex(snapshot.columns, report.roles, "ts");
    if (cIdx < 0 || aIdx < 0 || tIdx < 0) return empty;
    const mIdx = roleColumnIndex(snapshot.columns, report.roles, "machine");

    const cell = (idx: number) => sql<string>`coalesce(${rawRow.cells}->>${sql.raw(String(idx))}, '')`;
    const code = cell(cIdx);
    const ts = cell(tIdx);
    const amount = cell(aIdx);
    const price = sql<string>`case when ${amount} ~ '^\\s*-?[0-9]+([.,][0-9]+)?\\s*$'
      then replace(btrim(${amount}), ',', '.')::numeric end`;
    const month = sql<string>`substr(${ts}, 1, 7)`;

    const byMonth = await this.db
      .select({
        code,
        month,
        n: sql<number>`count(*)`,
        revenue: sql<string>`coalesce(sum(${price}), 0)`,
        unreadable: sql<number>`count(*) filter (where ${price} is null)`,
        first: sql<string>`min(${ts})`,
        last: sql<string>`max(${ts})`,
      })
      .from(rawRow)
      .where(eq(rawRow.snapshotId, snapshot.id))
      .groupBy(code, month);

    const byMachine =
      mIdx < 0
        ? []
        : await this.db
            .select({
              code,
              serial: cell(mIdx),
              n: sql<number>`count(*)`,
              revenue: sql<string>`coalesce(sum(${price}), 0)`,
            })
            .from(rawRow)
            .where(eq(rawRow.snapshotId, snapshot.id))
            .groupBy(code, cell(mIdx));

    const machines = await this.db
      .select({ id: entity.id, name: entity.name, ref: entity.externalRef })
      .from(entity)
      .where(eq(entity.type, "machine"));
    const bySerial = new Map(
      machines
        .filter((m) => m.ref !== null && m.ref.length > 0)
        .map((m) => [normalizeSourceKey(m.ref!), { id: m.id, name: m.name }]),
    );

    const dict = (report.dicts ?? []).find((d) => d.role === "payment");
    const channels = new Map<string, PaymentChannel>();
    let lastOrderAt: string | null = null;
    for (const r of byMonth) {
      // Пустой код — это тоже факт источника, а не повод пропустить строку.
      const key = r.code;
      const decoded = decodeRawValue(dict, key);
      const ch =
        channels.get(key) ??
        ({
          code: key,
          label: decoded?.label ?? null,
          confirmed: decoded?.confirmed ?? false,
          orders: 0,
          revenue: 0,
          unreadable: 0,
          firstOrderAt: r.first,
          lastOrderAt: r.last,
          months: [],
          machines: [],
        } satisfies PaymentChannel);
      ch.orders += Number(r.n);
      ch.revenue += Number(r.revenue);
      ch.unreadable += Number(r.unreadable);
      if (r.first < ch.firstOrderAt) ch.firstOrderAt = r.first;
      if (r.last > ch.lastOrderAt) ch.lastOrderAt = r.last;
      ch.months.push({ month: r.month, orders: Number(r.n), revenue: Number(r.revenue) });
      channels.set(key, ch);
      if (lastOrderAt === null || r.last > lastOrderAt) lastOrderAt = r.last;
    }

    for (const r of byMachine) {
      const ch = channels.get(r.code);
      if (!ch || r.serial.trim().length === 0) continue;
      const card = bySerial.get(normalizeSourceKey(r.serial)) ?? null;
      ch.machines.push({
        serial: r.serial,
        entityId: card?.id ?? null,
        entityName: card?.name ?? null,
        orders: Number(r.n),
        revenue: Number(r.revenue),
      });
    }

    const list = [...channels.values()];
    for (const ch of list) {
      ch.months.sort((a, b) => a.month.localeCompare(b.month));
      ch.machines.sort((a, b) => b.revenue - a.revenue || a.serial.localeCompare(b.serial));
    }
    // Сверху то, где больше денег: с этого и начинают сверку.
    list.sort((a, b) => b.revenue - a.revenue || b.orders - a.orders);

    return {
      channels: list,
      orders: list.reduce((n, c) => n + c.orders, 0),
      revenue: list.reduce((n, c) => n + c.revenue, 0),
      unconfirmedRevenue: list.filter((c) => !c.confirmed).reduce((n, c) => n + c.revenue, 0),
      column: cIdx,
      lastOrderAt,
    };
  }

  /**
   * Заготовки для заполнения фискальных полей.
   *
   * Ничего не выдумывает: и значения, и доноры берутся из карточек, которые
   * владелец УЖЕ заполнил. Кофейные напитки обычно делят ИКПУ, упаковку и
   * ставку, поэтому четырнадцатая карточка заполняется не набором семнадцати
   * цифр вручную, а выбором из того, что уже проверено.
   *
   * Живёт рядом с разбором ассортимента, потому что обслуживает тот же экран:
   * заводить ради одного метода отдельный модуль незачем.
   */
  async fiscalPresets(): Promise<{
    values: Record<string, string[]>;
    donors: { id: string; name: string; fields: Record<string, string> }[];
  }> {
    const cards = await this.db
      .select({ id: entity.id, name: entity.name, attrs: entity.attrs })
      .from(entity)
      .where(eq(entity.type, "product"));

    const values: Record<string, string[]> = {};
    const donors: { id: string; name: string; fields: Record<string, string> }[] = [];
    for (const f of FISCAL_FIELDS) values[f] = [];

    for (const c of cards) {
      const attrs = (c.attrs ?? {}) as Record<string, unknown>;
      for (const f of FISCAL_FIELDS) {
        const v = String(attrs[f] ?? "").trim();
        // В подсказки идёт только годное: предложить огрызок ИКПУ остальным
        // значило бы размножить поломку одним нажатием.
        if (isValidFiscalValue(f, v) && !values[f].includes(v)) values[f].push(v);
      }
      // Донором становится только полностью годная карточка: копировать
      // огрызок ИКПУ значило бы размножить поломку.
      if (fiscalGaps(attrs).length === 0) {
        donors.push({
          id: c.id,
          name: c.name,
          fields: Object.fromEntries(FISCAL_FIELDS.map((f) => [f, String(attrs[f] ?? "")])),
        });
      }
    }
    for (const f of FISCAL_FIELDS) values[f].sort((a, b) => a.localeCompare(b, "ru"));
    donors.sort((a, b) => a.name.localeCompare(b.name, "ru"));
    return { values, donors };
  }

  /**
   * Разбор ассортимента источника: что продаётся и по чему не собирается чек.
   *
   * Считается в деньгах, а не в строках. «Товар встречается часто» и «товар
   * приносит много» — разные вещи, и владельцу нужно второе: 14 позиций без
   * карточек дают 42% выручки месяца, а по числу строк они теряются в хвосте.
   *
   * Нет карточки и есть карточка без ИКПУ — для кассы одно и то же: чек не
   * собирается. Поэтому оба состояния считаются вместе, но называются раздельно.
   */
  async productReview(sourceCode: string, reportCode: string): Promise<ProductReview> {
    const report = await this.report(sourceCode, reportCode);
    const snapshot = await this.latestSnapshot(sourceCode, reportCode);
    if (!snapshot) {
      return { products: [], revenue: 0, blockedRevenue: 0, noCard: 0, incomplete: 0, lastOrderAt: null };
    }

    const pIdx = roleColumnIndex(snapshot.columns, report.roles, "product");
    const aIdx = roleColumnIndex(snapshot.columns, report.roles, "amount");
    const tIdx = roleColumnIndex(snapshot.columns, report.roles, "ts");
    if (pIdx < 0 || aIdx < 0 || tIdx < 0) {
      return { products: [], revenue: 0, blockedRevenue: 0, noCard: 0, incomplete: 0, lastOrderAt: null };
    }
    const fIdx = roleColumnIndex(snapshot.columns, report.roles, "flavour");
    const kIdx = roleColumnIndex(snapshot.columns, report.roles, "kind");

    const cell = (idx: number) => sql<string>`coalesce(${rawRow.cells}->>${sql.raw(String(idx))}, '')`;
    const product = cell(pIdx);
    const ts = cell(tIdx);
    const amount = cell(aIdx);
    const price = sql<string>`case when ${amount} ~ '^\\s*-?[0-9]+([.,][0-9]+)?\\s*$'
      then replace(btrim(${amount}), ',', '.')::numeric end`;

    // Тестовые отгрузки не продажа: они и в выручку не идут, и ассортиментом
    // не являются. Всё остальное — идёт, включая нулевые суммы: заказ был.
    const conds: SQL[] = [eq(rawRow.snapshotId, snapshot.id)];
    if (kIdx >= 0) conds.push(sql`lower(btrim(${cell(kIdx)})) <> 'testshipment'`);

    const rows = await this.db
      .select({
        name: product,
        n: sql<number>`count(*)`,
        revenue: sql<string>`coalesce(sum(${price}), 0)`,
        unreadable: sql<number>`count(*) filter (where ${price} is null)`,
        first: sql<string>`min(${ts})`,
        last: sql<string>`max(${ts})`,
      })
      .from(rawRow)
      .where(and(...conds))
      .groupBy(product);

    const flavourRows =
      fIdx < 0
        ? []
        : await this.db
            .select({ product, flavour: cell(fIdx), n: sql<number>`count(*)` })
            .from(rawRow)
            .where(and(...conds))
            .groupBy(product, cell(fIdx));

    const [cards, links] = await Promise.all([
      this.db
        .select({
          id: entity.id,
          name: entity.name,
          attrs: entity.attrs,
          approvedAt: entity.approvedAt,
        })
        .from(entity)
        .where(eq(entity.type, "product")),
      this.db
        .select()
        .from(rawLink)
        .where(and(eq(rawLink.sourceCode, sourceCode), eq(rawLink.kind, "product"))),
    ]);
    const cardById = new Map(cards.map((c) => [c.id, c]));
    const cardByName = new Map(cards.map((c) => [normalizeSourceKey(c.name), c]));
    const linkByKey = new Map(links.map((l) => [l.externalKey, l]));

    // Разные написания одного значения схлопываются так же, как на экране
    // сопоставления: владельцу разбирать один раз, а не по разу на регистр.
    const merged = new Map<string, SourceProduct>();
    let lastOrderAt: string | null = null;
    for (const r of rows) {
      if (r.name.trim().length === 0) continue;
      // Последний заказ считается до схлопывания написаний: иначе самый свежий
      // заказ, пришедший вторым написанием уже знакомого товара, потеряется.
      if (lastOrderAt === null || r.last > lastOrderAt) lastOrderAt = r.last;
      const key = normalizeSourceKey(r.name);
      const seen = merged.get(key);
      if (seen) {
        seen.orders += Number(r.n);
        seen.revenue += Number(r.revenue);
        seen.unreadable += Number(r.unreadable);
        if (r.first < seen.firstOrderAt) seen.firstOrderAt = r.first;
        if (r.last > seen.lastOrderAt) seen.lastOrderAt = r.last;
        continue;
      }
      const decided = linkByKey.get(key);
      const card = decided
        ? decided.entityId
          ? (cardById.get(decided.entityId) ?? null)
          : null
        : (cardByName.get(key) ?? null);
      const dismissed = decided !== undefined && decided.entityId === null;
      merged.set(key, {
        name: r.name,
        orders: Number(r.n),
        revenue: Number(r.revenue),
        unreadable: Number(r.unreadable),
        firstOrderAt: r.first,
        lastOrderAt: r.last,
        entityId: card?.id ?? null,
        entityName: card?.name ?? null,
        approved: card ? card.approvedAt !== null : false,
        dismissed,
        decidedBy: decided ? decided.decidedBy : card ? "auto" : null,
        lookalikes: [],
        // Нет карточки — не собирается ничего: пустой список значил бы «всё
        // заполнено», а заполнять тут нечего. Разные вещи, и путать их нельзя.
        gaps: card
          ? fiscalGaps(card.attrs as Record<string, unknown>)
          : dismissed
            ? []
            : FISCAL_FIELDS.map((field) => ({ field, flaw: "нет" as const, why: "карточки нет" })),
      });
    }

    const products = [...merged.values()];
    const hints = findLookalikes(
      products.map((p) => ({ name: p.name, orders: p.orders, revenue: p.revenue })),
      flavourRows.map((f) => ({ product: f.product, flavour: f.flavour, orders: Number(f.n) })),
    );
    const byKey = new Map(products.map((p) => [normalizeSourceKey(p.name), p]));
    for (const p of products) {
      p.lookalikes = (hints.get(normalizeSourceKey(p.name)) ?? []).map((h) => {
        const other = byKey.get(normalizeSourceKey(h.name));
        return {
          name: h.name,
          reason: h.reason,
          entityId: other?.entityId ?? null,
          entityName: other?.entityName ?? null,
          revenue: other?.revenue ?? 0,
          orders: other?.orders ?? 0,
        };
      });
    }

    // Сверху то, где больше денег: разбирать хвост из одного стакана незачем,
    // пока наверху висит позиция на десятки миллионов.
    products.sort((a, b) => b.revenue - a.revenue || a.name.localeCompare(b.name, "ru"));

    const blocked = products.filter((p) => p.gaps.length > 0);
    return {
      products,
      revenue: products.reduce((n, p) => n + p.revenue, 0),
      blockedRevenue: blocked.reduce((n, p) => n + p.revenue, 0),
      noCard: products.filter((p) => p.entityId === null && !p.dismissed).length,
      incomplete: products.filter((p) => p.entityId !== null && p.gaps.length > 0).length,
      lastOrderAt,
    };
  }

  /**
   * Решение владельца по одному значению источника.
   * `entityId: null` — осознанное «карточка не нужна» (тестовые отгрузки и т.п.):
   * значение перестаёт числиться неразобранным, но и в реестр не попадает.
   */
  async setLink(input: {
    sourceCode: string;
    kind: RawLinkKind;
    label: string;
    entityId: string | null;
    decidedBy?: string;
    note?: string;
  }): Promise<{ ok: true }> {
    const key = normalizeSourceKey(input.label);
    if (key.length === 0) throw new NotFoundException("Пустое значение связывать не с чем");
    const values = {
      sourceCode: input.sourceCode,
      kind: input.kind,
      externalKey: key,
      externalLabel: input.label,
      entityId: input.entityId,
      decidedBy: input.decidedBy ?? "owner",
      note: input.note ?? null,
      updatedAt: new Date(),
    };
    await this.db
      .insert(rawLink)
      .values(values)
      .onConflictDoUpdate({
        target: [rawLink.sourceCode, rawLink.kind, rawLink.externalKey],
        set: {
          entityId: values.entityId,
          externalLabel: values.externalLabel,
          decidedBy: values.decidedBy,
          note: values.note,
          updatedAt: values.updatedAt,
        },
      });
    return { ok: true };
  }

  /**
   * Приём выгрузки.
   *
   * Повторная отправка того же снимка (те же источник, отчёт и время съёма)
   * заменяет строки, а не плодит дубли. Части большой выгрузки шлются с
   * `append: true` — тело запроса ограничено мегабайтом, и делить её нормально.
   */
  async import(input: RawImportInput): Promise<{ snapshotId: string; rows: number; total: number }> {
    // Отчёт обязан быть в действующем справочнике: принимать выгрузку под
    // незнакомым кодом нельзя — её потом не с чем связать.
    if (!(await this.source(input.source))) {
      throw new NotFoundException(`Источника «${input.source}» нет в справочнике`);
    }
    await this.report(input.source, input.report);
    const fetchedAt = new Date(input.fetchedAt);
    if (Number.isNaN(fetchedAt.getTime())) {
      throw new NotFoundException("Время съёма выгрузки нечитаемо");
    }

    const [existing] = await this.db
      .select({ id: rawSnapshot.id })
      .from(rawSnapshot)
      .where(
        and(
          eq(rawSnapshot.sourceCode, input.source),
          eq(rawSnapshot.reportCode, input.report),
          eq(rawSnapshot.fetchedAt, fetchedAt),
        ),
      )
      .limit(1);

    const meta = {
      sourceCode: input.source,
      reportCode: input.report,
      fetchedAt,
      periodFrom: input.periodFrom ?? null,
      periodTo: input.periodTo ?? null,
      account: input.account ?? null,
      rowsTotal: input.rowsTotal ?? null,
      columns: input.columns ?? [],
      note: input.note ?? null,
      importedBy: input.importedBy ?? "owner",
    };

    let snapshotId: string;
    if (existing) {
      snapshotId = existing.id;
      if (!input.append) {
        // Полная перезаливка снимка: старые строки уходят вместе с ним.
        await this.db.delete(rawRow).where(eq(rawRow.snapshotId, snapshotId));
        await this.db.update(rawSnapshot).set(meta).where(eq(rawSnapshot.id, snapshotId));
      }
    } else {
      const [created] = await this.db.insert(rawSnapshot).values(meta).returning({ id: rawSnapshot.id });
      snapshotId = created.id;
    }

    // Позиция первой строки пачки. Отправитель называет её сам — тогда повтор
    // пачки после обрыва ляжет на своё место. Не назвал — считаем от того, что
    // уже лежит (порядок источника сохраняется в любом случае).
    let start: number;
    if (typeof input.offset === "number" && Number.isInteger(input.offset) && input.offset >= 0) {
      start = input.offset;
    } else {
      const [{ n: already }] = await this.db
        .select({ n: sql<number>`count(*)` })
        .from(rawRow)
        .where(eq(rawRow.snapshotId, snapshotId));
      start = Number(already);
    }

    const values = input.rows.map((cells, i) => ({
      snapshotId,
      idx: start + i + 1,
      cells: cells.map((c) => (c === null || c === undefined ? "" : String(c))),
    }));
    for (let i = 0; i < values.length; i += 500) {
      // Конфликт по (снимок, номер строки) — это повтор той же пачки.
      // Перезаписываем: свежая отправка вернее прежней попытки.
      await this.db
        .insert(rawRow)
        .values(values.slice(i, i + 500))
        .onConflictDoUpdate({
          target: [rawRow.snapshotId, rawRow.idx],
          set: { cells: sql`excluded.cells` },
        });
    }

    const [{ n: total }] = await this.db
      .select({ n: sql<number>`count(*)` })
      .from(rawRow)
      .where(eq(rawRow.snapshotId, snapshotId));

    await this.events.record({
      source: `raw:${input.source}`,
      type: "raw.snapshot.imported",
      payload: {
        source: input.source,
        report: input.report,
        rows: values.length,
        append: input.append === true,
      },
      occurredAt: fetchedAt,
    });

    return { snapshotId, rows: values.length, total: Number(total) };
  }

  /**
   * Изменился ли состав колонок между двумя последними выгрузками.
   *
   * Источник вправе переименовать или переставить колонку, и загрузку это не
   * ломает — новый снимок ложится со своим составом. Но роли колонок после
   * такого могут перестать находиться, поэтому владельцу об этом говорят
   * словами, а не оставляют выяснять по пустому экрану сопоставления.
   */
  async columnDrift(
    sourceCode: string,
    reportCode: string,
  ): Promise<{ prevFetchedAt: string; added: string[]; removed: string[]; reordered: boolean } | null> {
    const rows = await this.db
      .select({ fetchedAt: rawSnapshot.fetchedAt, columns: rawSnapshot.columns })
      .from(rawSnapshot)
      .where(and(eq(rawSnapshot.sourceCode, sourceCode), eq(rawSnapshot.reportCode, reportCode)))
      .orderBy(sql`${rawSnapshot.fetchedAt} desc`)
      .limit(2);
    if (rows.length < 2) return null;

    const [now, prev] = rows;
    const drift = compareColumns(prev.columns, now.columns);
    if (!drift.added.length && !drift.removed.length && !drift.reordered) return null;
    return { prevFetchedAt: prev.fetchedAt.toISOString(), ...drift };
  }
}

/**
 * Упорядочить отрезки по времени и отметить пересечения.
 *
 * Отдельной функцией — правило «пересеклись, значит не переезд» должно быть
 * закреплено тестом, а не жить внутри запроса. Времена сравниваются строками:
 * источник отдаёт их в формате «ГГГГ-ММ-ДД ЧЧ:ММ:СС», где порядок строк
 * совпадает с порядком дат, и приводить их к датам на сыром слое незачем.
 */
export function markOverlaps(
  list: { point: string; from: string; to: string; orders: number }[],
): MachineStay[] {
  const sorted = [...list].sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
  return sorted.map((cur, i) => {
    const prev = sorted[i - 1];
    const next = sorted[i + 1];
    const overlaps =
      (prev !== undefined && cur.from <= prev.to) || (next !== undefined && next.from <= cur.to);
    return { ...cur, overlaps };
  });
}

/**
 * Сколько заказов должно быть в отрезке, чтобы он считался сменой цены.
 *
 * Один-два заказа между двумя отрезками одной цены — не смена и не возврат к
 * прежней цене, а сбой источника. Правило срабатывает только когда соседи
 * согласны между собой: если слева и справа цены разные, отрезок остаётся, даже
 * будь он из одного заказа.
 */
export const MIN_PERIOD_ORDERS = 3;

/**
 * Отрезки цены одного товара на одном автомате — из вёдер по месяцам.
 *
 * Цена, как и точка, не поле, а период: пока её не поменяли, она держится.
 * Отсюда и правило смены: старая цена кончается раньше, чем начинается новая.
 * Если же две цены идут вперемешку, это не смена — по одной кнопке пробивают
 * разные напитки, и вторая цена принадлежит не этому товару.
 *
 * Отдельной функцией — потому что здесь решается, чему верить, а такое место
 * должно быть закреплено тестом, а не спрятано внутри запроса.
 */
export function buildPricePeriods(buckets: readonly PriceBucket[]): {
  periods: PricePeriod[];
  mismatched: number;
} {
  // Одна цена в одном месяце — одно ведро, даже если пришла несколькими
  // строками: у товара бывает два написания, и это не две разные цены,
  // соперничающие за месяц, а одна и та же.
  const byMonth = new Map<string, Map<number, PriceBucket>>();
  for (const b of buckets) {
    const month = byMonth.get(b.month) ?? new Map<number, PriceBucket>();
    const seen = month.get(b.price);
    if (seen) {
      seen.orders += b.orders;
      if (b.from < seen.from) seen.from = b.from;
      if (b.to > seen.to) seen.to = b.to;
    } else {
      month.set(b.price, { ...b });
    }
    byMonth.set(b.month, month);
  }

  let mismatched = 0;
  const segments: PriceBucket[] = [];
  for (const month of [...byMonth.keys()].sort()) {
    // Внутри месяца сначала берём цену, по которой прошло больше заказов: она
    // и есть цена месяца. Остальные попадают в отрезки, только если легли
    // строго врозь с уже принятыми — то есть выглядят сменой, а не примесью.
    const list = [...(byMonth.get(month)?.values() ?? [])].sort(
      (a, b) => b.orders - a.orders || (a.from < b.from ? -1 : a.from > b.from ? 1 : 0),
    );
    const kept: PriceBucket[] = [];
    for (const cand of list) {
      if (kept.some((k) => interleaved(cand, k))) {
        mismatched += cand.orders;
        continue;
      }
      kept.push(cand);
    }
    kept.sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
    segments.push(...kept);
  }

  const periods = mergeAdjacent(segments);
  // Короткий отрезок между двумя одинаковыми ценами — сбой, а не смена.
  const cleaned: PricePeriod[] = [];
  for (let i = 0; i < periods.length; i += 1) {
    const cur = periods[i];
    const prev = cleaned[cleaned.length - 1];
    const next = periods[i + 1];
    if (
      prev !== undefined &&
      next !== undefined &&
      prev.price === next.price &&
      cur.orders < MIN_PERIOD_ORDERS
    ) {
      mismatched += cur.orders;
      continue;
    }
    cleaned.push({ ...cur });
  }

  return { periods: mergeAdjacent(cleaned), mismatched };
}

/**
 * Насколько цены должны перекрываться по времени, чтобы это считалось примесью.
 *
 * Касание хвостами — не примесь. У настоящей смены цены старая держится до
 * последнего своего заказа, а новая уже началась, и хвосты налезают друг на
 * друга на несколько дней: достаточно одного позднего заказа по старой цене,
 * чтобы границы пересеклись. Примесь выглядит иначе — чужая цена рассыпана по
 * всему отрезку основной, а не жмётся к его краю.
 */
const INTERLEAVE_SHARE = 0.5;

/** Время источника («ГГГГ-ММ-ДД ЧЧ:ММ:СС») в миллисекунды. */
function ms(ts: string): number {
  // Часовой пояс подставляется один и тот же для всех значений, поэтому
  // разности точны, а от зоны машины результат не зависит.
  const t = Date.parse(`${ts.replace(" ", "T")}Z`);
  return Number.isFinite(t) ? t : 0;
}

/**
 * Идут ли две цены вперемешку — то есть примесь это, а не смена.
 *
 * Раньше здесь стояла проверка «границы вообще пересеклись», и она путала два
 * разных случая: один поздний заказ по старой цене выбрасывал весь отрезок
 * новой вместе с сотнями заказов, а автомат, который цену как раз поднял,
 * попадал в отставшие с выдуманным недобором.
 *
 * Различает их доля перекрытия: у смены цены она мала (хвост), у примеси —
 * почти вся длина более короткого отрезка. Мгновение (один заказ) считается
 * примесью, если попало внутрь чужого отрезка.
 */
export function interleaved(a: PriceBucket, b: PriceBucket): boolean {
  const from = Math.max(ms(a.from), ms(b.from));
  const to = Math.min(ms(a.to), ms(b.to));
  if (to < from) return false;
  const shorter = Math.min(ms(a.to) - ms(a.from), ms(b.to) - ms(b.from));
  if (shorter <= 0) return true;
  return (to - from) / shorter > INTERLEAVE_SHARE;
}

/**
 * Ключ пары «автомат + товар» для истории цен.
 *
 * Нормализованный: «Ice Lemon Tea» и «ice lemon  tea» — один товар, и в срезе по
 * нему автомат обязан встретиться один раз. По сырому тексту он попадал в
 * список дважды, и большинство при выборе эталона считалось по нему дважды же —
 * эталон мог перевернуться из-за разницы в пробелах.
 *
 * Разделитель — символ, которого не бывает в данных: иначе серийник с пробелом
 * на конце склеился бы с чужим названием товара.
 */
export function timelineKey(serial: string, product: string): string {
  return `${normalizeSourceKey(serial)}\u0000${normalizeSourceKey(product)}`;
}

/**
 * Худшее состояние среди величин строки — им и красится строка журнала.
 *
 * Порядок именно такой: расхождение важнее отсутствия, отсутствие важнее
 * «не сверено». Строка должна кричать о самом плохом, что в ней есть, а не
 * о среднем по ней.
 */
export function worstState(fields: readonly { state: FieldState }[]): FieldState {
  const rank: Record<FieldState, number> = {
    mismatch: 0,
    absent: 1,
    unchecked: 2,
    matched: 3,
    source: 4,
  };
  let worst: FieldState = "source";
  for (const f of fields) if (rank[f.state] < rank[worst]) worst = f.state;
  return worst;
}

/** Склеить соседние отрезки с одинаковой ценой: смены цены между ними нет. */
function mergeAdjacent(list: readonly PricePeriod[]): PricePeriod[] {
  const out: PricePeriod[] = [];
  for (const s of list) {
    const last = out[out.length - 1];
    if (last && last.price === s.price) {
      if (s.to > last.to) last.to = s.to;
      last.orders += s.orders;
      continue;
    }
    out.push({ price: s.price, from: s.from, to: s.to, orders: s.orders });
  }
  return out;
}

/**
 * Последняя известная цена товара на автомате к этому моменту.
 *
 * Именно «последняя известная», а не «цена в момент заказа». Отрезок кончается
 * последним заказом, но цена на этом не кончается: пока её не поменяли, она
 * держится, даже если товар неделю никто не покупал.
 *
 * Разница не косметическая. Считать «после последнего заказа цены нет» значит
 * уравнять «автомат не торговал» с «данных нет», и тогда при подсчёте
 * большинства один торгующий отставший автомат перевешивает любое число
 * эталонных, просто не продавших товар в тот день.
 *
 * null остаётся только до самого первого заказа: до него цены действительно
 * не было.
 */
export function priceAt(periods: readonly PricePeriod[], at: string): number | null {
  let price: number | null = null;
  for (const p of periods) {
    if (p.from <= at) price = p.price;
  }
  return price;
}

/**
 * С какого момента эталонная цена стала ценой большинства.
 *
 * Недобор нельзя считать с того дня, когда первый автомат поднял цену: пока
 * большинство торгует по-старому, отставших нет — есть один опередивший.
 * Поэтому ищется начало последнего непрерывного отрезка, на котором эталон
 * держит большинство и не теряет его до конца.
 *
 * null — большинство так и не сложилось, и требовать с кого-то недобор не за что.
 */
export function referenceSince(
  timelines: readonly (readonly PricePeriod[])[],
  reference: number,
): string | null {
  const dates = [...new Set(timelines.flatMap((t) => t.map((p) => p.from)))].sort();
  let since: string | null = null;
  for (const at of dates) {
    let ref = 0;
    let other = 0;
    for (const t of timelines) {
      const p = priceAt(t, at);
      if (p === null) continue;
      if (p === reference) ref += 1;
      else other += 1;
    }
    if (ref > other) {
      if (since === null) since = at;
    } else {
      since = null;
    }
  }
  return since;
}

/**
 * Цена большинства. null — большинства нет: либо цен поровну, либо считать не с чего.
 *
 * Ничью не разрешаем в пользу большей цены: «половина торгует дороже» — это
 * разнобой, а не эталон, и назначать его самим значит выдумать факт.
 */
export function referencePrice(prices: readonly number[]): number | null {
  if (prices.length === 0) return null;
  const count = new Map<number, number>();
  for (const p of prices) count.set(p, (count.get(p) ?? 0) + 1);
  const ranked = [...count.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  if (ranked.length > 1 && ranked[0][1] === ranked[1][1]) return null;
  return ranked[0][0];
}

/** Дата на N дней раньше времени источника («ГГГГ-ММ-ДД ЧЧ:ММ:СС»). */
export function daysBefore(ts: string, days: number): string {
  const d = new Date(`${ts.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return ts;
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

/** Сколько подсказок «тот же напиток» показываем: длинный список никто не читает. */
const MAX_LOOKALIKES = 3;
/**
 * Насколько вкус должен покрывать заказы товара, чтобы стать основанием.
 *
 * Один заказ с чужим вкусом — не признак того, что это тот же напиток, а шум.
 */
const LOOKALIKE_SHARE = 0.2;
/**
 * Со сколькими товарами вкус перестаёт что-либо значить.
 *
 * «Без сахара» встречается у половины ассортимента и потому не связывает
 * ничего. Основанием остаются только вкусы, привязанные к немногим товарам.
 */
const GENERIC_FLAVOUR_PRODUCTS = 5;

/** Товар для поиска двойников. */
export interface LookalikeInput {
  name: string;
  orders: number;
  revenue: number;
}

/** Название без пробелов и знаков: «MacCoffee 3in1» и «MacCoffee 3 in 1» — одно. */
export function tightKey(name: string): string {
  return normalizeSourceKey(name).replace(/[^\p{L}\p{N}]/gu, "");
}

/**
 * Двойники товара: одно и то же под разными именами.
 *
 * В панели живут «Какао» и Cocoa — один напиток, две записи, и оттого 137
 * наименований против 34 карточек. Слить их сам код не имеет права: решает
 * владелец. Задача здесь — не решить за него, а показать основание.
 *
 * Оснований ровно два, и оба взяты из данных, а не из словаря переводов:
 *
 * 1. **То же название без пробелов и знаков.** Чисто механическая разница.
 * 2. **Общий вкус.** Названия напитков переводят, а вкусы в панели остаются
 *    как есть, поэтому «Какао» и Cocoa приходят с одним `Flavour name`.
 *
 * Второе основание умеет ошибаться, и ошибка эта полезная: если по кнопке
 * одного напитка пробивают другой, вкусы у них тоже общие. Поэтому в
 * основании стоят числа — по ним видно, двойник это или подмена кнопки.
 */
export function findLookalikes(
  products: readonly LookalikeInput[],
  flavours: readonly { product: string; flavour: string; orders: number }[],
): Map<string, { name: string; reason: string }[]> {
  const out = new Map<string, { name: string; reason: string; weight: number }[]>();
  const add = (from: string, to: string, reason: string, weight: number) => {
    const key = normalizeSourceKey(from);
    const list = out.get(key) ?? [];
    if (list.some((x) => normalizeSourceKey(x.name) === normalizeSourceKey(to))) return;
    list.push({ name: to, reason, weight });
    out.set(key, list);
  };

  // 1. Механически то же название.
  const byTight = new Map<string, LookalikeInput[]>();
  for (const p of products) {
    const k = tightKey(p.name);
    if (k.length === 0) continue;
    byTight.set(k, [...(byTight.get(k) ?? []), p]);
  }
  for (const group of byTight.values()) {
    if (group.length < 2) continue;
    for (const a of group) {
      for (const b of group) {
        if (normalizeSourceKey(a.name) === normalizeSourceKey(b.name)) continue;
        add(a.name, b.name, "то же название без пробелов и знаков", b.revenue);
      }
    }
  }

  // 2. Общий вкус — с числами, по которым видно, двойник это или подмена кнопки.
  const ordersOf = new Map(products.map((p) => [normalizeSourceKey(p.name), p.orders]));
  const revenueOf = new Map(products.map((p) => [normalizeSourceKey(p.name), p.revenue]));
  const byFlavour = new Map<string, { label: string; users: { product: string; orders: number }[] }>();
  for (const f of flavours) {
    if (f.flavour.trim().length === 0 || f.product.trim().length === 0) continue;
    const k = normalizeSourceKey(f.flavour);
    const bucket = byFlavour.get(k) ?? { label: f.flavour, users: [] };
    bucket.users.push({ product: f.product, orders: f.orders });
    byFlavour.set(k, bucket);
  }
  for (const { label, users } of byFlavour.values()) {
    // Схлопываем написания товара, иначе один товар «связывается» сам с собой.
    const per = new Map<string, { name: string; orders: number }>();
    for (const u of users) {
      const k = normalizeSourceKey(u.product);
      const seen = per.get(k);
      if (seen) seen.orders += u.orders;
      else per.set(k, { name: u.product, orders: u.orders });
    }
    const list = [...per.values()];
    if (list.length < 2 || list.length > GENERIC_FLAVOUR_PRODUCTS) continue;
    // Доля проверяется у ОБОИХ товаров пары, а не только у того, на чьей строке
    // встанет подсказка. Иначе три случайных заказа Cappuccino с чужим вкусом
    // рождали подсказку на строке Latte, и владелец читал в основании «4000 из
    // 4000» — числа Latte при трёх заказах доказательства. Один клик по такой
    // подсказке вешал всю выручку Latte на чужую карточку.
    const shareOf = (x: { name: string; orders: number }) => {
      const total = ordersOf.get(normalizeSourceKey(x.name)) ?? x.orders;
      return total === 0 ? 0 : x.orders / total;
    };
    for (const a of list) {
      if (shareOf(a) < LOOKALIKE_SHARE) continue;
      const total = ordersOf.get(normalizeSourceKey(a.name)) ?? a.orders;
      for (const b of list) {
        if (normalizeSourceKey(a.name) === normalizeSourceKey(b.name)) continue;
        if (shareOf(b) < LOOKALIKE_SHARE) continue;
        const totalB = ordersOf.get(normalizeSourceKey(b.name)) ?? b.orders;
        add(
          a.name,
          b.name,
          `общий вкус «${label}» — ${a.orders} из ${total} заказов здесь и ${b.orders} из ${totalB} там`,
          revenueOf.get(normalizeSourceKey(b.name)) ?? 0,
        );
      }
    }
  }

  const result = new Map<string, { name: string; reason: string }[]>();
  for (const [key, list] of out) {
    result.set(
      key,
      list
        .sort((a, b) => b.weight - a.weight)
        .slice(0, MAX_LOOKALIKES)
        .map(({ name, reason }) => ({ name, reason })),
    );
  }
  return result;
}

/**
 * Сравнение состава колонок двух выгрузок. Отдельной функцией — чтобы поведение
 * на переименовании и перестановке было закреплено тестом, а не догадкой.
 */
export function compareColumns(
  prev: readonly string[],
  next: readonly string[],
): { added: string[]; removed: string[]; reordered: boolean } {
  const key = (c: string) => normalizeSourceKey(c);
  const prevKeys = prev.map(key);
  const nextKeys = next.map(key);
  const added = next.filter((c) => !prevKeys.includes(key(c)));
  const removed = prev.filter((c) => !nextKeys.includes(key(c)));
  // Перестановка считается только когда состав тот же: иначе о ней сообщать
  // бессмысленно — владельцу важнее, что колонка появилась или пропала.
  const reordered =
    added.length === 0 &&
    removed.length === 0 &&
    prevKeys.some((c, i) => c !== nextKeys[i]);
  return { added, removed, reordered };
}
