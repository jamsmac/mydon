import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  type OnApplicationShutdown,
  OnModuleInit,
} from "@nestjs/common";
import { auditLog, entity, event, ourvendSaleSnapshot, productNameAlias, sale } from "@mydon/db";
import {
  MACHINE_SERIAL_SQL_REGEX,
  machineSerialKeys,
  normalizeMachineSerial,
  strictNumber,
  tashkentDay,
  tashkentDayStartOf,
} from "@mydon/shared";
import { and, asc, desc, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import { Cron } from "croner";
import { DB, type Db } from "../db/db.module";
import { lastSnapshotAt, snapshotIsStale, snapshotStaleThreshold } from "../ourvend/sync-runs";
import { openStockDb } from "../supply/stock-db";
import { accountingSource, type AccountingSource } from "./accounting-source";

type SaleRow = typeof sale.$inferSelect;

/** Строка источника (mydon-stock, таблица ourvend_sales). */
export interface StockSaleRow {
  dt: string;
  machine_serial: string;
  ourvend_name: string;
  qty: string | number;
  amount: string | number;
  fetched_at: string | Date;
}

/** Строка, не прошедшая проверку чисел, — в карантин, а не в упсерт. */
export interface QuarantinedSale {
  dt: string;
  machineSerial: string;
  product: string;
  field: "qty" | "amount";
  value: unknown;
}

/**
 * Разобрать строки источника: годные — в упсерт, с нечисловыми qty/amount — в
 * карантин. exported для тестов — это сердце синка. Раньше `Number(x) || 0`
 * превращал мусор в ноль и тихо занижал выручку; теперь такое не вливается.
 */
export function buildUpserts(
  rows: StockSaleRow[],
  serialToEntity: Map<string, string>,
): { values: (typeof sale.$inferInsert)[]; quarantined: QuarantinedSale[] } {
  const values: (typeof sale.$inferInsert)[] = [];
  const quarantined: QuarantinedSale[] = [];
  for (const r of rows) {
    // Неполные ключи молча пропускаем как раньше — их нечем ни записать, ни
    // осмысленно посадить в карантин.
    if (!(r.machine_serial && r.ourvend_name && r.dt)) continue;
    const dt = String(r.dt).slice(0, 10);
    // КАНОН в ключе записи, не только в маппинге: серийник входит в уникальный
    // ключ sale, а источники пишут разные формы («c…» у stock-дорожки, голая у
    // собственного снапшота) — без канона переключение источника двоило бы
    // строки. История приведена миграцией 0064.
    const machineSerial = normalizeMachineSerial(String(r.machine_serial));
    const product = String(r.ourvend_name).slice(0, 512);
    const qty = strictNumber(r.qty);
    const amount = strictNumber(r.amount);
    if (qty === null || amount === null) {
      quarantined.push({
        dt,
        machineSerial,
        product,
        field: qty === null ? "qty" : "amount",
        value: qty === null ? r.qty : r.amount,
      });
      continue;
    }
    values.push({
      dt,
      machineSerial,
      machineId: serialToEntity.get(machineSerial) ?? null,
      product,
      qty: String(qty),
      amount: String(amount),
      source: "ourvend",
      fetchedAt: new Date(r.fetched_at),
    });
  }
  return { values, quarantined };
}

/** Сутки в миллисекундах: у Ташкента нет перехода на летнее время. */
const DAY_MS = 86_400_000;

/**
 * Сегодняшняя дата ТАШКЕНТСКИМИ сутками — зоной из кода, а не часами процесса.
 *
 * `getFullYear`/`getMonth`/`getDate` читали момент часами ПРОЦЕССА: правильность
 * держалась на переменной `TZ` в контейнере, а не на коде. Внешний Postgres, cron
 * в UTC, локальный прогон разработчика — и «сегодня» витрины продаж уезжало на
 * сутки в окне 00:00–05:00 Ташкента. Зона зашита в `@mydon/shared`
 * (`tashkent-time.ts`) ровно затем, чтобы второй её копии в коде не было.
 */
export function todayLocal(now = new Date()): string {
  return tashkentDay(now);
}

/**
 * Граница «N календарных дат назад, включая сегодня» — today−(N−1), не
 * today−N: иначе `>=` этой границы захватывает N+1 дату вместо N (найдено
 * внешним аудитом, P2: «30 дней» на деле считали 31 дату).
 *
 * Правило окна прежнее, изменился только счёт суток: отсчёт идёт от НАЧАЛА
 * ташкентских суток момента — той же конвенцией, что у отчётов вендинга
 * (`since = tashkentDayStartOf(now) − (N−1) × сутки`).
 */
export function daysAgoLocal(days: number, now = new Date()): string {
  return tashkentDay(new Date(tashkentDayStartOf(now).getTime() - (days - 1) * DAY_MS));
}

/**
 * Продажи автоматов (этап 1 плана миграции).
 *
 * Источник — mydon-stock: он уже сам забирает дневные сводки из OurVend.
 * Мы читаем его базу отдельным пользователем только-чтение и складываем
 * копию себе: дашборд не зависит от чужого контейнера, история не теряется.
 *
 * Не задан STOCK_DATABASE_URL — модуль молчит, панель показывает
 * «появится после сбора». Ничего не падает.
 */
@Injectable()
export class SalesService implements OnModuleInit, OnApplicationShutdown {
  private readonly log = new Logger(SalesService.name);
  private cron: Cron | null = null;

  constructor(@Inject(DB) private readonly db: Db) {}

  // async: источник учёта читается из настроек (R-P8b-3), а Nest ждёт
  // возвращённый промис.
  async onModuleInit(): Promise<void> {
    // Момент старта — ОДИН на весь хук: `accountingSource` кеширует по времени,
    // и два `new Date()` внутри одного хука были бы двумя разными «сейчас».
    const now = new Date();
    // ЧТЕНИЕ НАСТРОЙКИ — ПОД СВОИМ `catch`, И ЭТО НЕ ПЕРЕСТРАХОВКА.
    // `accountingSource` идёт в `system_config`, то есть в базу. Отклонённый
    // `onModuleInit` прерывает bootstrap Nest целиком: не стартует НИЧЕГО — ни
    // `/ourvend/health`, ни бот, ни кроны, — и всё это ради ОДНОЙ СТРОКИ ЛОГА
    // (сам `sync()` читает источник заново). База на старте недоступна не
    // теоретически: `DATABASE_URL` может смотреть на внешний Postgres, где
    // `depends_on: service_healthy` из compose не работает вовсе. Раньше сбой
    // БД на старте стоил одну строку `warn` из `.catch` первого синка — так и
    // оставляем.
    let source: AccountingSource | null = null;
    try {
      source = await accountingSource(this.db, now);
    } catch (e: unknown) {
      this.log.warn(
        `Источник продаж: не удалось прочитать настройку — ${e instanceof Error ? e.message : String(e)}. ` +
          `Синк разберётся сам на первом прогоне.`,
      );
    }
    const url = process.env.STOCK_DATABASE_URL;
    // «Синк продаж выключен» больше не бывает, и прежняя ветка этого условия
    // была недостижимой: `stock` без `STOCK_DATABASE_URL` невозможен по
    // определению (`resolveAccountingSource` в такой ситуации отвечает `own`).
    // Оставь её — и лог обещал бы состояние, в которое код не попадает, а
    // читатель искал бы «выключенный синк» в проде, где он всегда включён.
    if (source === "own") {
      this.log.log(
        url
          ? "Источник продаж: собственный снапшот OurVend (ourvend_sale_snapshot); зеркало ещё живо, но не читается."
          : "Источник продаж: собственный снапшот OurVend (ourvend_sale_snapshot); зеркало погашено.",
      );
    }
    // Раз в 10 минут + сразу на старте. Ошибка синка не роняет Core.
    this.cron = new Cron("*/10 * * * *", { timezone: "Asia/Tashkent" }, () => {
      void this.sync().catch((e: unknown) =>
        this.log.warn(`Синк продаж не удался: ${e instanceof Error ? e.message : String(e)}`),
      );
    });
    void this.sync().catch((e: unknown) =>
      this.log.warn(`Первый синк продаж не удался: ${e instanceof Error ? e.message : String(e)}`),
    );
  }

  onApplicationShutdown(): void {
    this.cron?.stop();
    this.cron = null;
  }

  /**
   * Прочитать строки источника: свежее за 3 дня, а при пустой своей `sale` —
   * всё целиком. Источник — либо БД mydon-stock, либо собственный снапшот
   * (форма строк одинаковая, дальше их не различить — и это цель П2).
   */
  private async fetchSourceRows(now: Date): Promise<StockSaleRow[] | null> {
    const [{ n }] = await this.db.select({ n: sql<number>`count(*)` }).from(sale);
    const firstRun = Number(n) === 0;

    if ((await accountingSource(this.db, now)) === "own") {
      const rows = await this.db
        .select({
          dt: sql<string>`${ourvendSaleSnapshot.dt}::text`,
          machine_serial: ourvendSaleSnapshot.machineSerial,
          ourvend_name: ourvendSaleSnapshot.product,
          qty: ourvendSaleSnapshot.qty,
          amount: ourvendSaleSnapshot.amount,
          fetched_at: ourvendSaleSnapshot.fetchedAt,
        })
        .from(ourvendSaleSnapshot)
        .where(firstRun ? sql`true` : sql`${ourvendSaleSnapshot.fetchedAt} > now() - interval '3 days'`);
      return rows as unknown as StockSaleRow[];
    }

    const url = process.env.STOCK_DATABASE_URL;
    if (!url) return null;
    // Отдельное короткоживущее подключение: чужая база не должна держать пул.
    // Параметры — общие для всех читателей донора (`supply/stock-db.ts`).
    const stock = await openStockDb(url);
    try {
      // Свежее: всё, что источник трогал за последние 3 дня — дневные строки
      // дообновляются в течение дня, а перезапись upsert-ом безопасна.
      return (await (firstRun
        ? stock`
            select dt::text, machine_serial, ourvend_name, qty, amount, fetched_at
            from ourvend_sales`
        : stock`
            select dt::text, machine_serial, ourvend_name, qty, amount, fetched_at
            from ourvend_sales
            where fetched_at > now() - interval '3 days'`)) as unknown as StockSaleRow[];
    } finally {
      await stock.end({ timeout: 5 });
    }
  }

  /** Забрать свежее из источника и слить к нам (upsert по дню+автомату+товару). */
  async sync(now = new Date()): Promise<{ upserted: number }> {
    {
      // `now` — параметр: источник учёта кешируется по времени, и прогон,
      // запущенный тестом «в другой момент», обязан спрашивать настройку тем же
      // моментом, каким считает всё остальное.
      const all = await this.fetchSourceRows(now);
      if (all === null || all.length === 0) return { upserted: 0 };

      const machines = await this.db
        .select({ id: entity.id, ref: entity.externalRef })
        .from(entity)
        .where(eq(entity.type, "machine"));
      // Обе формы написания серийника ведут к одной карточке: реестр хранит
      // снековые с приставкой («c2508160376»), а Ourvend отдаёт без неё.
      const serialToEntity = new Map<string, string>();
      for (const m of machines) {
        for (const key of machineSerialKeys(m.ref)) {
          if (!serialToEntity.has(key)) serialToEntity.set(key, m.id);
        }
      }

      const { values, quarantined } = buildUpserts(all, serialToEntity);
      if (quarantined.length > 0) {
        // Мусорные числа не вливаем нулём — откладываем в событие, чтобы
        // расхождение было видно, а не растворилось в выручке.
        await this.db.insert(event).values({
          source: "sales-sync",
          type: "sales.quarantine",
          payload: { count: quarantined.length, rows: quarantined.slice(0, 50) },
        });
        this.log.warn(
          `Продажи: карантин ${quarantined.length} строк с нечисловыми qty/amount — не влиты.`,
        );
      }
      let upserted = 0;
      // Пачками: источник маленький (сотни строк), но не полагаемся на это.
      for (let i = 0; i < values.length; i += 500) {
        const chunk = values.slice(i, i + 500);
        await this.db
          .insert(sale)
          .values(chunk)
          .onConflictDoUpdate({
            target: [sale.source, sale.dt, sale.machineSerial, sale.product],
            set: {
              qty: sql`excluded.qty`,
              amount: sql`excluded.amount`,
              fetchedAt: sql`excluded.fetched_at`,
              machineId: sql`excluded.machine_id`,
            },
          });
        upserted += chunk.length;
      }

      // Карточка автомата могла появиться ПОЗЖЕ продаж (так и было с тремя
      // снек-автоматами: 10,4 млн сум висели «ничьими»). Привязываем задним
      // числом всё, что теперь узнаётся по серийнику. Обычный синк этого не
      // делает — он трогает только последние дни.
      // Сравнение по канону, а не по написанию: реестр хранит снековые
      // серийники с приставкой «c», Ourvend отдаёт их без неё. Regexp здесь —
      // SQL-двойник normalizeMachineSerial из @mydon/shared (тест держит их в
      // паре); нормализуем обе стороны, чтобы форма в базе стала безразлична.
      const linked = await this.db.execute(sql`
        update ${sale} set machine_id = e.id
        from ${entity} e
        where ${sale.machineId} is null
          and e.type = 'machine'
          and regexp_replace(lower(coalesce(e.external_ref, '')), ${MACHINE_SERIAL_SQL_REGEX}, '\\1')
            = regexp_replace(lower(coalesce(${sale.machineSerial}, '')), ${MACHINE_SERIAL_SQL_REGEX}, '\\1')
          and coalesce(e.external_ref, '') <> ''
      `);
      const linkedCount = Number((linked as unknown as { count?: number }).count ?? 0);
      if (linkedCount > 0) {
        this.log.log(`Продажи привязаны к автоматам задним числом: ${linkedCount} строк.`);
      }

      await this.db.insert(event).values({
        source: "sales-sync",
        type: "sales.sync",
        payload: {
          upserted,
          привязано_задним_числом: linkedCount,
          из:
            (await accountingSource(this.db, now)) === "own" ? "ourvend_sale_snapshot (свой)" : "mydon-stock/ourvend",
        },
      });
      this.log.log(`Продажи синхронизированы: ${upserted} строк.`);
      return { upserted };
    }
  }

  /**
   * Сводка для дашборда: сегодня, вчера, 30 дней.
   *
   * `now` — параметр, а не `new Date()` внутри: `configured` меряет свежесть
   * снапшота, и «37 часов назад» иначе нечем проверить тестом.
   */
  async summary(now: Date = new Date()): Promise<{
    today: { qty: number; amount: number };
    yesterday: { qty: number; amount: number };
    days30: { qty: number; amount: number };
    lastSaleDt: string | null;
    configured: boolean;
    /**
     * ДЕЙСТВУЮЩИЙ источник учёта — рядом с `configured`, потому что без него
     * флаг не переводится в текст.
     *
     * `configured: false` означает РАЗНОЕ в двух режимах: в `stock` — «не задан
     * `STOCK_DATABASE_URL`», в `own` — «учётный снапшот не обновляется, продажи
     * стоят». Витрины печатали общий текст «синк не настроен на сервере
     * (STOCK_DATABASE_URL)» — то есть после шага 1 рунбука предлагали владельцу
     * настроить переменную, которую шаг 3 того же рунбука УДАЛЯЕТ. Одно поле
     * рядом дешевле второго флага: витрина выбирает текст по режиму.
     */
    source: AccountingSource;
  }> {
    /**
     * `configured` — «ИСТОЧНИК ЧИТАЕМ», а не «источник выбран».
     *
     * Витрины (`reports-overview.tsx`, `sales-view.tsx`, бот `sales-brief.ts`)
     * рисуют по нему «появится после сбора». Пока флаг считался как
     * «`own` ИЛИ есть переменная», он был ТОЖДЕСТВЕННО ИСТИННЫМ: в режиме `own`
     * первое слагаемое всегда верно, а `stock` без переменной невозможен
     * (`resolveAccountingSource`). То есть плитка обещала «настроено» и в тот
     * день, когда агент снапшота лежал третьи сутки, синк честно отдавал
     * `{ upserted: 0 }` и учёт стоял молча — ровно тот случай, ради которого
     * флаг и заведён.
     *
     * Теперь вопрос задаётся по режиму: у зеркала «читаем» = переменная есть, у
     * своего снапшота «читаем» = он свежий. Свежесть — той же функцией, что у
     * сторожа и отчёта (`snapshotIsStale`), иначе плитка гасла бы на своей
     * границе, а тревога приходила бы на другой.
     */
    const источник = await accountingSource(this.db, now);
    const configured =
      источник === "own"
        ? // Свежесть — ПО ПОЛОВИНЕ ПРОДАЖ, и только по ней. Сторож и
          // `OurvendHealth.snapshotStale` смотрят на ОБЕ половины (R-FW-P2) и
          // умеют назвать вставшую словами; этот флаг — нет: его читают три
          // витрины ПРОДАЖ («снапшот не пришёл» на чипе журнала, «снапшота за
          // сутки нет» в пустом журнале и у бота), и погасить их из-за
          // упавшей Lot-сессии остатков значит сказать владельцу неправду о
          // продажах, которые в этот момент едут. Половина остатков остаётся
          // за сторожем, который тревожит по адресу.
          !snapshotIsStale(
            (await lastSnapshotAt(this.db)).sales,
            now,
            await snapshotStaleThreshold(this.db, this.log),
          )
        : Boolean(process.env.STOCK_DATABASE_URL);
    // `now` ЦЕЛИКОМ, а не наполовину: доккомментарий обещает «параметр, а не
    // `new Date()` внутри», и «сегодня» по стенным часам при заданном `now`
    // сделало бы из теста проверку «примерно тех же суток».
    const today = todayLocal(now);
    // Вчера — тоже ТАШКЕНТСКИЕ сутки: `setDate` сдвигал календарь ПРОЦЕССА, и
    // при `TZ=UTC` плитка «вчера» до 05:00 показывала позавчерашний день.
    const yesterday = tashkentDay(new Date(tashkentDayStartOf(now).getTime() - DAY_MS));
    const days30Since = daysAgoLocal(30, now);

    const [row] = await this.db
      .select({
        tQty: sql<string>`coalesce(sum(${sale.qty}) filter (where ${sale.dt} = ${today}), 0)`,
        tAmt: sql<string>`coalesce(sum(${sale.amount}) filter (where ${sale.dt} = ${today}), 0)`,
        yQty: sql<string>`coalesce(sum(${sale.qty}) filter (where ${sale.dt} = ${yesterday}), 0)`,
        yAmt: sql<string>`coalesce(sum(${sale.amount}) filter (where ${sale.dt} = ${yesterday}), 0)`,
        mQty: sql<string>`coalesce(sum(${sale.qty}) filter (where ${sale.dt} >= ${days30Since}), 0)`,
        mAmt: sql<string>`coalesce(sum(${sale.amount}) filter (where ${sale.dt} >= ${days30Since}), 0)`,
        last: sql<string | null>`max(${sale.dt})::text`,
      })
      .from(sale);

    return {
      today: { qty: Number(row?.tQty ?? 0), amount: Number(row?.tAmt ?? 0) },
      yesterday: { qty: Number(row?.yQty ?? 0), amount: Number(row?.yAmt ?? 0) },
      days30: { qty: Number(row?.mQty ?? 0), amount: Number(row?.mAmt ?? 0) },
      lastSaleDt: row?.last ?? null,
      configured,
      source: источник,
    };
  }

  /**
   * Динамика по дням для графика дашборда. Дни без продаж в ответе
   * отсутствуют — график сам решает, как показать дыру (нули не выдумываем).
   */
  async daily(days = 30): Promise<{ dt: string; qty: number; amount: number }[]> {
    const since = daysAgoLocal(Math.min(Math.max(days, 1), 120));
    const rows = await this.db
      .select({
        dt: sale.dt,
        qty: sql<string>`sum(${sale.qty})`,
        amount: sql<string>`sum(${sale.amount})`,
      })
      .from(sale)
      .where(gte(sale.dt, since))
      .groupBy(sale.dt)
      .orderBy(asc(sale.dt));
    return rows.map((r) => ({ dt: r.dt, qty: Number(r.qty), amount: Number(r.amount) }));
  }

  /** Журнал: дневные позиции с именем автомата и точкой (адресом) из карточки. */
  async journal(
    days = 7,
    limit = 300,
  ): Promise<(SaleRow & { machineName: string | null; point: string | null })[]> {
    const since = daysAgoLocal(days);
    const rows = await this.db
      .select({ row: sale, machineName: entity.name, machineAttrs: entity.attrs })
      .from(sale)
      .leftJoin(entity, eq(entity.id, sale.machineId))
      .where(gte(sale.dt, since))
      .orderBy(desc(sale.dt), desc(sale.amount))
      .limit(limit);
    return rows.map((r) => {
      const a = (r.machineAttrs ?? {}) as Record<string, unknown>;
      const point = [a["точка"], a["адрес"], a["локация"]].find(
        (v): v is string => typeof v === "string" && v.length > 0,
      );
      return { ...r.row, machineName: r.machineName, point: point ?? null };
    });
  }

  /**
   * Продажи одного товара за период — для карточки товара.
   *
   * Связь по ИМЕНИ: `sale.product` — текст из источника, FK на карточку нет
   * (признанный долг складского ТЗ). Точное совпадение имени — честная первая
   * версия: «не найдено» может означать и «не продаётся», и «в источнике имя
   * другое», и карточка говорит это словами, а не выдаёт ноль за факт.
   */
  async byProduct(
    name: string,
    days = 90,
  ): Promise<{
    total: { qty: number; amount: number };
    machines: {
      machineId: string | null;
      serial: string;
      machineName: string | null;
      qty: number;
      amount: number;
    }[];
  }> {
    const since = daysAgoLocal(Math.min(Math.max(days, 1), 365));
    const rows = await this.db
      .select({
        machineId: sale.machineId,
        serial: sale.machineSerial,
        machineName: entity.name,
        qty: sql<string>`sum(${sale.qty})`,
        amount: sql<string>`sum(${sale.amount})`,
      })
      .from(sale)
      .leftJoin(entity, eq(entity.id, sale.machineId))
      .where(and(eq(sale.product, name), gte(sale.dt, since)))
      .groupBy(sale.machineId, sale.machineSerial, entity.name)
      .orderBy(sql`sum(${sale.amount}) desc`);

    const machines = rows.map((r) => ({
      machineId: r.machineId,
      serial: r.serial,
      machineName: r.machineName,
      qty: Number(r.qty),
      amount: Number(r.amount),
    }));
    return {
      total: {
        qty: machines.reduce((s, m) => s + m.qty, 0),
        amount: machines.reduce((s, m) => s + m.amount, 0),
      },
      machines,
    };
  }

  /**
   * Продажи КАРТОЧКИ товара: по её имени плюс привязанным алиасам источника.
   *
   * Одна продажа не может засчитаться двум карточкам: имя алиаса уникально
   * во всём словаре, а имя, совпадающее с другой карточкой, в алиасы не
   * принимается (см. addAlias).
   */
  async byProductCard(
    entityId: string,
    days = 90,
  ): Promise<{
    total: { qty: number; amount: number };
    machines: {
      machineId: string | null;
      serial: string;
      machineName: string | null;
      qty: number;
      amount: number;
    }[];
    aliases: { id: string; name: string }[];
  }> {
    const [card] = await this.db.select().from(entity).where(eq(entity.id, entityId)).limit(1);
    if (!card) throw new NotFoundException("Карточка товара не найдена");
    const aliases = await this.db
      .select({ id: productNameAlias.id, name: productNameAlias.name })
      .from(productNameAlias)
      .where(eq(productNameAlias.entityId, entityId));

    const names = [card.name, ...aliases.map((a) => a.name)];
    const since = daysAgoLocal(Math.min(Math.max(days, 1), 365));
    const rows = await this.db
      .select({
        machineId: sale.machineId,
        serial: sale.machineSerial,
        machineName: entity.name,
        qty: sql<string>`sum(${sale.qty})`,
        amount: sql<string>`sum(${sale.amount})`,
      })
      .from(sale)
      .leftJoin(entity, eq(entity.id, sale.machineId))
      .where(and(inArray(sale.product, names), gte(sale.dt, since)))
      .groupBy(sale.machineId, sale.machineSerial, entity.name)
      .orderBy(sql`sum(${sale.amount}) desc`);

    const machines = rows.map((r) => ({
      machineId: r.machineId,
      serial: r.serial,
      machineName: r.machineName,
      qty: Number(r.qty),
      amount: Number(r.amount),
    }));
    return {
      total: {
        qty: machines.reduce((s, m) => s + m.qty, 0),
        amount: machines.reduce((s, m) => s + m.amount, 0),
      },
      machines,
      aliases,
    };
  }

  /**
   * Имена продаж, не привязанные ни к одной карточке, — то, что теряется.
   *
   * Сортировка по деньгам: владелец привязывает сначала то, что дороже
   * оставлять невидимым.
   */
  async unmatchedNames(days = 90): Promise<
    { name: string; qty: number; amount: number; lastDt: string }[]
  > {
    const since = daysAgoLocal(Math.min(Math.max(days, 1), 365));
    const rows = await this.db
      .select({
        name: sale.product,
        qty: sql<string>`sum(${sale.qty})`,
        amount: sql<string>`sum(${sale.amount})`,
        lastDt: sql<string>`max(${sale.dt})::text`,
      })
      .from(sale)
      .leftJoin(entity, and(eq(entity.name, sale.product), eq(entity.type, "product")))
      .leftJoin(productNameAlias, eq(productNameAlias.name, sale.product))
      .where(and(gte(sale.dt, since), isNull(entity.id), isNull(productNameAlias.id)))
      .groupBy(sale.product)
      .orderBy(sql`sum(${sale.amount}) desc`)
      .limit(200);
    return rows.map((r) => ({
      name: r.name,
      qty: Number(r.qty),
      amount: Number(r.amount),
      lastDt: r.lastDt,
    }));
  }

  /**
   * Привязать имя источника к карточке — решение владельца, не догадка.
   *
   * Два отказа держат цифры честными: имя, совпадающее с другой карточкой,
   * не принимается (продажа засчиталась бы дважды), занятый алиас не
   * перепривязывается молча (сначала отвяжи — история решений видна в аудите).
   */
  async addAlias(
    name: string,
    entityId: string,
    actor = "owner",
  ): Promise<{ id: string; name: string; entityId: string }> {
    const clean = name.trim();
    if (clean.length === 0) throw new BadRequestException("Пустое имя не привязывается");

    const [card] = await this.db.select().from(entity).where(eq(entity.id, entityId)).limit(1);
    if (!card) throw new NotFoundException("Карточка товара не найдена");
    if (card.type !== "product") throw new BadRequestException("Алиасы привязываются только к товарам");
    const [shadow] = await this.db
      .select({ id: entity.id })
      .from(entity)
      .where(and(eq(entity.name, clean), eq(entity.type, "product")))
      .limit(1);
    if (shadow) {
      throw new BadRequestException(
        "Это имя уже само является карточкой товара — продажа засчиталась бы дважды",
      );
    }

    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(productNameAlias)
        .values({ entityId, name: clean, createdBy: actor })
        .onConflictDoNothing({ target: productNameAlias.name })
        .returning();
      if (!row) {
        const [existing] = await tx
          .select()
          .from(productNameAlias)
          .where(eq(productNameAlias.name, clean))
          .limit(1);
        if (existing && existing.entityId === entityId) {
          return { id: existing.id, name: existing.name, entityId: existing.entityId };
        }
        throw new BadRequestException("Имя уже привязано к другой карточке — сначала отвяжи там");
      }
      await tx.insert(auditLog).values({
        actorKind: "human",
        actorRef: actor,
        action: "sales.alias_added",
        target: row.id,
        after: row,
      });
      return { id: row.id, name: row.name, entityId: row.entityId };
    });
  }

  /** Весь словарь алиасов — для резолвинга имён в лентах прихода/остатков. */
  listAliases(): Promise<{ id: string; name: string; entityId: string }[]> {
    return this.db
      .select({
        id: productNameAlias.id,
        name: productNameAlias.name,
        entityId: productNameAlias.entityId,
      })
      .from(productNameAlias)
      .orderBy(productNameAlias.name)
      .limit(1000);
  }

  /** Отвязать имя. Продажи по нему снова попадут в «несвязанные». */
  async removeAlias(id: string, actor = "owner"): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(productNameAlias)
        .where(eq(productNameAlias.id, id))
        .limit(1);
      if (!row) throw new NotFoundException("Такой привязки нет");
      await tx.delete(productNameAlias).where(eq(productNameAlias.id, id));
      await tx.insert(auditLog).values({
        actorKind: "human",
        actorRef: actor,
        action: "sales.alias_removed",
        target: id,
        before: row,
      });
    });
  }

  /** Автоматы, молчащие N дней: продажи были раньше, а теперь нет — сигнал связи. */
  async silent(daysQuiet = 2): Promise<{ machineId: string | null; serial: string; name: string | null; lastDt: string }[]> {
    // Порог — ТАШКЕНТСКИЕ сутки минус N: `setDate` считал бы их календарём
    // процесса, и до 05:00 сторож молчал бы на сутки дольше положенного.
    const cutoff = todayLocal(new Date(tashkentDayStartOf(new Date()).getTime() - daysQuiet * DAY_MS));
    const rows = await this.db
      .select({
        serial: sale.machineSerial,
        machineId: sale.machineId,
        name: entity.name,
        lastDt: sql<string>`max(${sale.dt})::text`,
      })
      .from(sale)
      .leftJoin(entity, eq(entity.id, sale.machineId))
      .groupBy(sale.machineSerial, sale.machineId, entity.name)
      .having(sql`max(${sale.dt}) < ${cutoff}`);
    return rows;
  }
}
