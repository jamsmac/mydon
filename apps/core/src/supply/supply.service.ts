import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationShutdown,
  OnModuleInit,
} from "@nestjs/common";
import { entity, event, machineStock, ourvendStockSnapshot, purchase } from "@mydon/db";
import { MACHINE_SERIAL_SQL_REGEX, machineSerialKeys, normalizeMachineSerial, strictNumber } from "@mydon/shared";
import { desc, eq, gte, sql } from "drizzle-orm";
import { Cron } from "croner";
import { DB, type Db } from "../db/db.module";
import { accountingSource, type AccountingSource } from "../sales/accounting-source";
import { todayLocal } from "../sales/sales.service";
import { VendingService } from "../vending/vending.service";
import { openStockDb } from "./stock-db";

type PurchaseRow = typeof purchase.$inferSelect;

/** Строки источника (mydon-stock). */
export interface StockPurchaseRow {
  id: number | string;
  dt: string;
  product: string;
  unit: string | null;
  qty: string | number;
  unit_price: string | number | null;
  total: string | number | null;
  note: string | null;
  expiry_date: string | null;
}
/** Автомат в источнике: тип и координаты — ими дозаполняем свои карточки. */
export interface StockMachineRow {
  serial: string | null;
  name: string;
  kind: string | null;
  location: string | null;
}

export interface StockLevelRow {
  dt: string;
  machine_serial: string;
  ourvend_name: string;
  qty: string | number;
  fetched_at: string | Date;
}

/** Строка снабжения, не прошедшая проверку чисел, — в карантин, не в упсерт. */
export interface QuarantinedSupply {
  key: string;
  product: string;
  field: "qty" | "unit_price" | "total";
  value: unknown;
}

/**
 * exported для тестов: превращение строк источника в наши.
 *
 * Числа проверяем строго: qty обязано быть числом; цена/сумма — либо пусто
 * (нет цены), либо число. Непарсимое не вливаем нулём (это занизило бы приход и
 * себестоимость) — откладываем в карантин с причиной.
 */
export function buildPurchaseUpserts(rows: StockPurchaseRow[]): {
  values: (typeof purchase.$inferInsert)[];
  quarantined: QuarantinedSupply[];
} {
  const values: (typeof purchase.$inferInsert)[] = [];
  const quarantined: QuarantinedSupply[] = [];
  for (const r of rows) {
    if (!(r.product && r.dt)) continue;
    const product = String(r.product).slice(0, 512);
    const key = String(r.id);
    const qty = strictNumber(r.qty);
    if (qty === null) {
      quarantined.push({ key, product, field: "qty", value: r.qty });
      continue;
    }
    // Пусто — законно «цены нет»; непусто, но не число — брак.
    const unitPrice = r.unit_price === null ? null : strictNumber(r.unit_price);
    if (r.unit_price !== null && unitPrice === null) {
      quarantined.push({ key, product, field: "unit_price", value: r.unit_price });
      continue;
    }
    const total = r.total === null ? null : strictNumber(r.total);
    if (r.total !== null && total === null) {
      quarantined.push({ key, product, field: "total", value: r.total });
      continue;
    }
    values.push({
      extId: key,
      dt: String(r.dt).slice(0, 10),
      product,
      unit: r.unit ? String(r.unit) : null,
      qty: String(qty),
      unitPrice: unitPrice === null ? null : String(unitPrice),
      total: total === null ? null : String(total),
      note: r.note ? String(r.note).slice(0, 1000) : null,
      expiryDate: r.expiry_date ? String(r.expiry_date).slice(0, 10) : null,
      source: "stock",
    });
  }
  return { values, quarantined };
}

/**
 * Строки снапшота → строки `machine_stock`.
 *
 * `notInService` — канонические серийники автоматов, про которые карточка ПРЯМО
 * говорит `status ≠ in_service` (тот же реестр, что у паритета и плана закупа).
 * Аргумент не задан — фильтра нет вовсе: это режим `stock`, где остатки
 * приезжают зеркалом mydon-stock, а зеркало таких строк не даёт.
 *
 * ПОЧЕМУ ОТБРОШЕННАЯ СТРОКА НЕ ИДЁТ В КАРАНТИН (R-P8b-4). Карантин — про БРАК
 * ДАННЫХ: нечисловое `qty`, которое нельзя влить нулём, не занизив остаток. А
 * складской автомат — законные данные, просто не для этой таблицы: SKLAD 4S
 * (`2508160360`, `status='warehouse'`) каждые сутки отдаёт 34 строки на 7028
 * «единиц» заглушки 199. Положи их в карантин — и владелец получал бы событие
 * `supply.quarantine` каждые десять минут о том, что склад работает нормально.
 * Поэтому по фильтру идёт СЧЁТЧИК, а не тревога.
 *
 * ПОЧЕМУ ФИЛЬТР СТОИТ НА ЗАПИСИ, А НЕ НА ЧТЕНИИ СНАПШОТА. Снапшот обязан
 * остаться ПОЛНЫМ: по нему сверяется паритет (он режет «не в строю» сам, своим
 * гейтом) и по нему же живёт кабинетный отчёт — обрежь мы выборку, и сверка
 * молча потеряла бы половину сравниваемых пар, а расхождение выглядело бы как
 * «сходится».
 */
export function buildStockUpserts(
  rows: StockLevelRow[],
  serialToEntity: Map<string, string>,
  notInService?: ReadonlySet<string>,
): {
  values: (typeof machineStock.$inferInsert)[];
  quarantined: QuarantinedSupply[];
  skippedNotInService: number;
  /**
   * КАКИЕ ИМЕННО автоматы отброшены — канонические серийники, отсортированы
   * (R-FW-S2). Одного счётчика мало: множество «не в строю» берётся из карточек,
   * где «первая карточка выигрывает целиком», и забытый дубль со
   * `status ≠ in_service` уводит ЖИВОЙ автомат из `machine_stock` в режиме
   * `own`. Наружу при этом уходило число — то есть ровно тот тихий стоп, против
   * которого весь срез.
   */
  skippedSerials: string[];
} {
  const values: (typeof machineStock.$inferInsert)[] = [];
  const quarantined: QuarantinedSupply[] = [];
  let skippedNotInService = 0;
  const пропущенные = new Set<string>();
  for (const r of rows) {
    if (!(r.machine_serial && r.ourvend_name && r.dt)) continue;
    // Канон в ключе — по той же причине, что в buildUpserts (см. sales.service).
    const machineSerial = normalizeMachineSerial(String(r.machine_serial));
    // Проверка «наш ли это автомат» стоит ПЕРЕД проверкой чисел: иначе
    // заглушка складского автомата с нечисловым qty падала бы в карантин, то
    // есть чужая строка будила бы владельца ровно тем событием, от которого её
    // и отделяют.
    if (notInService?.has(machineSerial)) {
      skippedNotInService += 1;
      пропущенные.add(machineSerial);
      continue;
    }
    const product = String(r.ourvend_name).slice(0, 512);
    const qty = strictNumber(r.qty);
    if (qty === null) {
      quarantined.push({ key: `${machineSerial}|${r.dt}`, product, field: "qty", value: r.qty });
      continue;
    }
    values.push({
      dt: String(r.dt).slice(0, 10),
      machineSerial,
      machineId: serialToEntity.get(machineSerial) ?? null,
      product,
      qty: String(qty),
      fetchedAt: new Date(r.fetched_at),
    });
  }
  return { values, quarantined, skippedNotInService, skippedSerials: [...пропущенные].sort() };
}

/**
 * Чем дозаполнить карточку автомата из источника.
 *
 * Правило: трогаем ТОЛЬКО пустые поля. Если владелец что-то заполнил руками —
 * его значение важнее любого источника. Возвращает патч или null, если
 * дозаполнять нечего. exported для тестов.
 */
export function fillFromStock(
  attrs: Record<string, unknown>,
  src: { kind: string | null; location: string | null },
): Record<string, unknown> | null {
  const patch: Record<string, unknown> = {};
  const empty = (v: unknown) => v === undefined || v === null || v === "";

  if (empty(attrs["категория"]) && src.kind) {
    // Словарь источника: coffee → кофейные (10), snack → прохладительные (11).
    // Незнакомое значение не переводим — лучше «не указан», чем догадка.
    if (src.kind === "coffee") patch["категория"] = 10;
    else if (src.kind === "snack") patch["категория"] = 11;
  }
  if (empty(attrs["точка"]) && src.location) patch["точка"] = src.location;

  return Object.keys(patch).length > 0 ? patch : null;
}

/**
 * Снабжение (этап 2 плана миграции): приход и остатки в автоматах.
 *
 * Источник тот же, что у продаж, — mydon-stock, пользователь только-чтение.
 * Остатки — дневные снапшоты OurVend: свежий день на автомат = «что внутри
 * сейчас», нули — пустые спирали, которые пора везти пополнять.
 */
@Injectable()
export class SupplyService implements OnModuleInit, OnApplicationShutdown {
  private readonly log = new Logger(SupplyService.name);
  private cron: Cron | null = null;
  /**
   * Состав «не в строю» прошлого прогона (канон, через запятую). `null` — этот
   * прогон первый: сравнивать не с чем, и предупреждать не о чем.
   */
  private прошлыйПропуск: string | null = null;

  constructor(
    @Inject(DB) private readonly db: Db,
    /** Реестр автоматов — тот же источник правды о «не в строю», что у паритета (R-P8b-4). */
    private readonly vending: VendingService,
  ) {}

  // async: источник учёта читается из настроек (R-P8b-3); Nest дожидается промиса.
  async onModuleInit(): Promise<void> {
    // «Синк снабжения выключен» больше не бывает: без `STOCK_DATABASE_URL`
    // источник учёта равен `own` ПО ОПРЕДЕЛЕНИЮ (`resolveAccountingSource`), и
    // прежнее условие `!URL && источник !== "own"` стало недостижимым — то есть
    // ветка «выключен» тихо умерла, а лог о ней врал бы про состояние. Реальная
    // разница теперь одна: читаем ли мы ещё зеркало.
    if (!process.env.STOCK_DATABASE_URL) {
      this.log.log(
        "Снабжение: зеркало mydon-stock погашено — приход и дозаполнение карточек пропускаем, " +
          "остатки берём из собственного снапшота.",
      );
    }
    this.cron = new Cron("3-59/10 * * * *", { timezone: "Asia/Tashkent" }, () => {
      void this.sync().catch((e: unknown) =>
        this.log.warn(`Синк снабжения не удался: ${e instanceof Error ? e.message : String(e)}`),
      );
    });
    void this.sync().catch((e: unknown) =>
      this.log.warn(`Первый синк снабжения не удался: ${e instanceof Error ? e.message : String(e)}`),
    );
  }

  onApplicationShutdown(): void {
    this.cron?.stop();
    this.cron = null;
  }

  async sync(now = new Date()): Promise<{ purchases: number; stock: number }> {
    const url = process.env.STOCK_DATABASE_URL;
    // `now` — параметр: кеш источника учёта ключуется временем, и прогон обязан
    // спрашивать настройку тем же моментом, каким считает всё остальное.
    const ownStock = (await accountingSource(this.db, now)) === "own";

    // Подключение к БД mydon-stock нужно только пока жив stock-источник:
    // приход (purchases, до среза П3) и — при source=stock — остатки.
    // Параметры подключения — общие с остальными читателями донора
    // (`stock-db.ts`), чтобы сверка паритета ходила к нему на тех же условиях.
    const stock = url ? await openStockDb(url) : null;
    try {
      // Приход: имя товара и единица разворачиваются сразу — у нас плоская строка.
      const [{ np }] = await this.db.select({ np: sql<number>`count(*)` }).from(purchase);
      const pRows = stock
        ? ((await (Number(np) === 0
            ? stock`
                select p.id, p.dt::text, pr.name as product, pr.unit, p.qty, p.unit_price, p.total,
                       p.note, p.expiry_date::text
                from purchases p join products pr on pr.id = p.product_id`
            : stock`
                select p.id, p.dt::text, pr.name as product, pr.unit, p.qty, p.unit_price, p.total,
                       p.note, p.expiry_date::text
                from purchases p join products pr on pr.id = p.product_id
                where p.created_at > now() - interval '3 days'`)) as unknown as StockPurchaseRow[])
        : [];

      const [{ ns }] = await this.db.select({ ns: sql<number>`count(*)` }).from(machineStock);
      const firstStockRun = Number(ns) === 0;
      let sRows: StockLevelRow[];
      if (ownStock) {
        sRows = (await this.db
          .select({
            dt: sql<string>`${ourvendStockSnapshot.dt}::text`,
            machine_serial: ourvendStockSnapshot.machineSerial,
            ourvend_name: ourvendStockSnapshot.product,
            qty: ourvendStockSnapshot.qty,
            fetched_at: ourvendStockSnapshot.fetchedAt,
          })
          .from(ourvendStockSnapshot)
          .where(
            firstStockRun ? sql`true` : sql`${ourvendStockSnapshot.fetchedAt} > now() - interval '3 days'`,
          )) as unknown as StockLevelRow[];
      } else if (stock) {
        sRows = (await (firstStockRun
          ? stock`
              select dt::text, machine_serial, ourvend_name, qty, fetched_at
              from ourvend_machine_stock`
          : stock`
              select dt::text, machine_serial, ourvend_name, qty, fetched_at
              from ourvend_machine_stock
              where fetched_at > now() - interval '3 days'`)) as unknown as StockLevelRow[];
      } else {
        sRows = [];
      }

      const machines = await this.db
        .select({ id: entity.id, ref: entity.externalRef })
        .from(entity)
        .where(eq(entity.type, "machine"));
      // Обе формы написания серийника ведут к одной карточке (см. sales.service).
      const serialToEntity = new Map<string, string>();
      for (const m of machines) {
        for (const key of machineSerialKeys(m.ref)) {
          if (!serialToEntity.has(key)) serialToEntity.set(key, m.id);
        }
      }

      // Реестр «не в строю» спрашиваем ТОЛЬКО в режиме `own`: в режиме `stock`
      // остатки приезжают зеркалом, оно складских строк не отдаёт, и лишние два
      // запроса каждые десять минут платились бы ни за что. Множество — тем же
      // приёмом, что у паритета (`ourvend-parity.service`): ключи реестра уже
      // канонические.
      const неВСтрою = ownStock ? new Set((await this.vending.machineRegistry()).notInService.keys()) : undefined;

      const { values: pValues, quarantined: pBad } = buildPurchaseUpserts(pRows);
      const {
        values: sValues,
        quarantined: sBad,
        skippedNotInService,
        skippedSerials,
      } = buildStockUpserts(sRows, serialToEntity, неВСтрою);
      // Мусорные числа не вливаем нулём — откладываем в событие, чтобы приход и
      // остатки не занижались тихо.
      const bad = [...pBad.map((q) => ({ ...q, of: "purchase" })), ...sBad.map((q) => ({ ...q, of: "stock" }))];
      if (bad.length > 0) {
        await this.db.insert(event).values({
          source: "supply-sync",
          type: "supply.quarantine",
          payload: { count: bad.length, rows: bad.slice(0, 50) },
        });
        this.log.warn(`Снабжение: карантин ${bad.length} строк с нечисловыми значениями — не влиты.`);
      }
      for (let i = 0; i < pValues.length; i += 500) {
        await this.db
          .insert(purchase)
          .values(pValues.slice(i, i + 500))
          .onConflictDoUpdate({
            target: [purchase.source, purchase.extId],
            set: {
              qty: sql`excluded.qty`,
              unitPrice: sql`excluded.unit_price`,
              total: sql`excluded.total`,
              note: sql`excluded.note`,
              expiryDate: sql`excluded.expiry_date`,
            },
          });
      }

      for (let i = 0; i < sValues.length; i += 500) {
        await this.db
          .insert(machineStock)
          .values(sValues.slice(i, i + 500))
          .onConflictDoUpdate({
            target: [machineStock.dt, machineStock.machineSerial, machineStock.product],
            set: {
              qty: sql`excluded.qty`,
              fetchedAt: sql`excluded.fetched_at`,
              machineId: sql`excluded.machine_id`,
            },
          });
      }

      // Одна строка на прогон, и только когда есть что сказать: молчание тут
      // означало бы, что строки исчезают между снапшотом и `machine_stock` без
      // единого следа. СЕРИЙНИКИ В СТРОКЕ (R-FW-S2): «пропущено 34» не отвечает
      // на единственный важный вопрос — чей это автомат.
      if (skippedNotInService > 0) {
        this.log.log(
          `Остатки: пропущено ${skippedNotInService} строк по автоматам не в строю: ${skippedSerials.join(", ")}.`,
        );
      }
      // ИЗМЕНЕНИЕ МНОЖЕСТВА — предупреждением. Состав «не в строю» меняется
      // редко и осознанно (автомат уехал на склад). Внезапно появившийся там
      // серийник — это либо забытый дубль карточки, либо чужая правка статуса,
      // и в режиме `own` он молча уносит живой автомат из учёта остатков.
      const прежние = this.прошлыйПропуск;
      const состав = skippedSerials.join(",");
      if (прежние !== null && прежние !== состав) {
        this.log.warn(
          `Остатки: множество автоматов «не в строю» изменилось: ` +
            `[${прежние || "пусто"}] → [${состав || "пусто"}]. Проверьте карточки: дубль со статусом ` +
            `не in_service уводит живой автомат из machine_stock.`,
        );
      }
      this.прошлыйПропуск = состав;

      // Дозаполнение карточек автоматов из источника: тип (кофе/снеки) и точка.
      // Ревизия 2026-07-30: у 11 из 26 автоматов тип был не указан — панель
      // честно писала «не указан», но пустоту надо закрывать, а не только
      // показывать. Заполняем лишь пустые поля. Живёт, пока жив stock (до П8).
      const stockMachines = stock
        ? ((await stock`
            select serial, name, kind, location from machines where serial is not null
          `) as unknown as StockMachineRow[])
        : [];
      const bySerial = new Map(
        stockMachines
          .filter((m) => m.serial)
          .map((m) => [m.serial!.toLowerCase(), m]),
      );
      const ours = await this.db
        .select({ id: entity.id, ref: entity.externalRef, attrs: entity.attrs })
        .from(entity)
        .where(eq(entity.type, "machine"));
      let filled = 0;
      for (const row of ours) {
        if (!row.ref) continue;
        const src = bySerial.get(row.ref.toLowerCase());
        if (!src) continue;
        const patch = fillFromStock((row.attrs ?? {}) as Record<string, unknown>, src);
        if (patch === null) continue;
        await this.db
          .update(entity)
          .set({ attrs: sql`${entity.attrs} || ${JSON.stringify(patch)}::jsonb` })
          .where(eq(entity.id, row.id));
        filled += 1;
      }
      if (filled > 0) this.log.log(`Карточек автоматов дозаполнено из источника: ${filled}.`);

      // Остатки, пришедшие до появления карточки автомата, тоже привязываем.
      // Канон вместо написания — то же правило, что в sales.service.
      const linked = await this.db.execute(sql`
        update ${machineStock} set machine_id = e.id
        from ${entity} e
        where ${machineStock.machineId} is null
          and e.type = 'machine'
          and regexp_replace(lower(coalesce(e.external_ref, '')), ${MACHINE_SERIAL_SQL_REGEX}, '\\1')
            = regexp_replace(lower(coalesce(${machineStock.machineSerial}, '')), ${MACHINE_SERIAL_SQL_REGEX}, '\\1')
          and coalesce(e.external_ref, '') <> ''
      `);
      const linkedCount = Number((linked as unknown as { count?: number }).count ?? 0);
      if (linkedCount > 0) {
        this.log.log(`Остатки привязаны к автоматам задним числом: ${linkedCount} строк.`);
      }

      if (pValues.length + sValues.length > 0) {
        await this.db.insert(event).values({
          source: "supply-sync",
          type: "supply.sync",
          payload: {
            приход: pValues.length,
            остатки: sValues.length,
            // Пропуск — В ЖУРНАЛ, а не только в лог: журнал переживает ротацию
            // контейнера, а вопрос «куда делись строки автомата» задают через
            // недели.
            skippedNotInService: skippedSerials,
          },
        });
      }
      this.log.log(
        `Снабжение: приход ${pValues.length}, остатки ${sValues.length}` +
          (stock ? "" : " (зеркало погашено: приход и дозаполнение карточек пропущены)") +
          ".",
      );
      return { purchases: pValues.length, stock: sValues.length };
    } finally {
      if (stock) await stock.end({ timeout: 5 });
    }
  }

  /** Журнал прихода. */
  async purchases(days = 30, limit = 300): Promise<PurchaseRow[]> {
    const since = new Date();
    since.setDate(since.getDate() - days);
    return this.db
      .select()
      .from(purchase)
      .where(gte(purchase.dt, todayLocal(since)))
      .orderBy(desc(purchase.dt), desc(purchase.importedAt))
      .limit(limit);
  }

  /** Свежие остатки: последний снапшот по каждому автомату. */
  async machineLevels(): Promise<
    { machineSerial: string; machineId: string | null; machineName: string | null; dt: string; product: string; qty: number }[]
  > {
    const rows = await this.db
      .select({
        machineSerial: machineStock.machineSerial,
        machineId: machineStock.machineId,
        machineName: entity.name,
        dt: sql<string>`${machineStock.dt}::text`,
        product: machineStock.product,
        qty: machineStock.qty,
      })
      .from(machineStock)
      .leftJoin(entity, eq(entity.id, machineStock.machineId))
      .where(
        sql`(${machineStock.machineSerial}, ${machineStock.dt}) in
            (select machine_serial, max(dt) from machine_stock group by machine_serial)`,
      )
      .orderBy(machineStock.machineSerial, machineStock.product);
    return rows.map((r) => ({ ...r, qty: Number(r.qty) }));
  }

  /**
   * Сводка снабжения для плиток.
   *
   * `source` — откуда взяты остатки автоматов: `stock` (чтение БД mydon-stock)
   * или `own` (собственный снапшот). Без него плитка «остатки на такое-то
   * число» одинаково выглядит в обоих режимах, и после переключения источника
   * владельцу нечем отличить «мы уже считаем сами» от «мы всё ещё читаем чужую
   * базу» — а именно этот вопрос он задаёт в дни поглощения.
   */
  async summary(now = new Date()): Promise<{
    purchases30: { count: number; total: number };
    emptyPositions: number;
    lowPositions: number;
    lastStockDt: string | null;
    source: AccountingSource;
  }> {
    const d30 = new Date();
    d30.setDate(d30.getDate() - 30);
    const [p] = await this.db
      .select({
        count: sql<number>`count(*)`,
        total: sql<string>`coalesce(sum(${purchase.total}), 0)`,
      })
      .from(purchase)
      .where(gte(purchase.dt, todayLocal(d30)));

    const levels = await this.machineLevels();
    const emptyPositions = levels.filter((l) => l.qty === 0).length;
    const lowPositions = levels.filter((l) => l.qty > 0 && l.qty <= 2).length;
    const lastStockDt = levels.reduce<string | null>(
      (acc, l) => (acc === null || l.dt > acc ? l.dt : acc),
      null,
    );

    return {
      purchases30: { count: Number(p?.count ?? 0), total: Number(p?.total ?? 0) },
      emptyPositions,
      lowPositions,
      lastStockDt,
      source: await accountingSource(this.db, now),
    };
  }
}
