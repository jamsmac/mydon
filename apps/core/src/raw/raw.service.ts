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
