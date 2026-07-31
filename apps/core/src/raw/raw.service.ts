import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { entity, rawLink, rawRow, rawSnapshot } from "@mydon/db";
import {
  RAW_LINK_LABELS,
  RAW_SOURCES,
  findRawReport,
  normalizeSourceKey,
  roleColumnIndex,
  roleColumnName,
  type RawColumnRoles,
  type RawFreshness,
  type RawLinkKind,
  rawFreshness,
} from "@mydon/shared";
import { and, asc, eq, sql, type SQL } from "drizzle-orm";
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

/** Разбор фильтров по колонкам: ключи вида `f3` → индекс колонки. */
export function parseColumnFilters(query: Record<string, unknown>): Map<number, string> {
  const out = new Map<number, string>();
  for (const [key, value] of Object.entries(query)) {
    const m = /^f(\d+)$/.exec(key);
    if (!m) continue;
    const idx = Number(m[1]);
    if (!Number.isInteger(idx) || idx < 0 || idx >= MAX_COLUMNS) continue;
    const v = typeof value === "string" ? value.trim() : "";
    if (v.length > 0) out.set(idx, v);
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
  filters: Map<number, string>;
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

    const sources = RAW_SOURCES.map((src) => {
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
    for (const [idx, value] of query.filters) {
      // Индекс колонки — только проверенное целое (normalizeRowsQuery), поэтому
      // его можно подставить в текст запроса: параметром оператор `->>` не
      // выбрать, Postgres не знает, число это или ключ объекта.
      conds.push(
        sql`coalesce(${rawRow.cells}->>${sql.raw(String(idx))}, '') ilike ${`%${value}%`}`,
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
    const report = findRawReport(sourceCode, reportCode);
    if (!report) throw new NotFoundException("Такого отчёта нет в справочнике источников");

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
    const report = findRawReport(sourceCode, reportCode);
    if (!report) throw new NotFoundException("Такого отчёта нет в справочнике источников");
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

    const conds: SQL[] = [eq(rawRow.snapshotId, snapshot.id), sql`${price} > 0`];
    if (kIdx >= 0) conds.push(sql`lower(btrim(${cell(kIdx)})) <> 'testshipment'`);

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
      .where(and(eq(rawRow.snapshotId, snapshot.id), sql`${price} is null`));

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
    const report = findRawReport(sourceCode, reportCode);
    if (!report) throw new NotFoundException("Такого отчёта нет в справочнике источников");
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
      const key = `${r.serial} ${r.product}`;
      const list = buckets.get(key) ?? [];
      list.push(r.bucket);
      buckets.set(key, list);
      names.set(key, { serial: r.serial, product: r.product });
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
            : (buckets.get(`${i.serial} ${i.product}`) ?? [])
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
    const report = findRawReport(input.source, input.report);
    if (!report) {
      throw new NotFoundException(
        `Источник «${input.source}» или отчёт «${input.report}» не значится в справочнике`,
      );
    }
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
  const byMonth = new Map<string, PriceBucket[]>();
  for (const b of buckets) {
    const list = byMonth.get(b.month) ?? [];
    list.push(b);
    byMonth.set(b.month, list);
  }

  let mismatched = 0;
  const segments: PriceBucket[] = [];
  for (const month of [...byMonth.keys()].sort()) {
    // Внутри месяца сначала берём цену, по которой прошло больше заказов: она
    // и есть цена месяца. Остальные попадают в отрезки, только если легли
    // строго врозь с уже принятыми — то есть выглядят сменой, а не примесью.
    const list = [...(byMonth.get(month) ?? [])].sort(
      (a, b) => b.orders - a.orders || (a.from < b.from ? -1 : a.from > b.from ? 1 : 0),
    );
    const kept: PriceBucket[] = [];
    for (const cand of list) {
      if (kept.some((k) => !(cand.to < k.from || cand.from > k.to))) {
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

/** Цена товара на автомате в указанный момент. null — тогда он им не торговал. */
export function priceAt(periods: readonly PricePeriod[], at: string): number | null {
  for (const p of periods) {
    if (p.from <= at && at <= p.to) return p.price;
  }
  return null;
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
