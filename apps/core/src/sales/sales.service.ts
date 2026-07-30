import { Inject, Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { entity, event, sale } from "@mydon/db";
import { desc, eq, gte, sql } from "drizzle-orm";
import { Cron } from "croner";
import { DB, type Db } from "../db/db.module";

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

/** Что пойдёт в нашу таблицу. exported для тестов — это сердце синка. */
export function buildUpserts(
  rows: StockSaleRow[],
  serialToEntity: Map<string, string>,
): (typeof sale.$inferInsert)[] {
  return rows
    .filter((r) => r.machine_serial && r.ourvend_name && r.dt)
    .map((r) => ({
      dt: String(r.dt).slice(0, 10),
      machineSerial: String(r.machine_serial).toLowerCase(),
      machineId: serialToEntity.get(String(r.machine_serial).toLowerCase()) ?? null,
      product: String(r.ourvend_name).slice(0, 512),
      qty: String(Number(r.qty) || 0),
      amount: String(Number(r.amount) || 0),
      source: "ourvend",
      fetchedAt: new Date(r.fetched_at),
    }));
}

/** Сегодняшняя дата по-ташкентски (в контейнере TZ=Asia/Tashkent). */
export function todayLocal(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
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
export class SalesService implements OnModuleInit {
  private readonly log = new Logger(SalesService.name);
  private cron: Cron | null = null;

  constructor(@Inject(DB) private readonly db: Db) {}

  onModuleInit(): void {
    const url = process.env.STOCK_DATABASE_URL;
    if (!url || url.length === 0) {
      this.log.log("STOCK_DATABASE_URL не задан — синк продаж выключен.");
      return;
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

  /** Забрать свежее из mydon-stock и слить к нам (upsert по дню+автомату+товару). */
  async sync(): Promise<{ upserted: number }> {
    const url = process.env.STOCK_DATABASE_URL;
    if (!url) return { upserted: 0 };

    // Отдельное короткоживущее подключение: чужая база не должна держать пул.
    const { default: postgres } = await import("postgres");
    const stock = postgres(url, { prepare: false, max: 1, connect_timeout: 10 });
    try {
      // Свежее: всё, что источник трогал за последние 3 дня — дневные строки
      // дообновляются в течение дня, а перезапись upsert-ом безопасна.
      const rows = (await stock`
        select dt::text, machine_serial, ourvend_name, qty, amount, fetched_at
        from ourvend_sales
        where fetched_at > now() - interval '3 days'
      `) as unknown as StockSaleRow[];

      // Первый прогон: истории у нас нет — забираем всё целиком.
      const [{ n }] = await this.db.select({ n: sql<number>`count(*)` }).from(sale);
      const all =
        Number(n) === 0
          ? ((await stock`
              select dt::text, machine_serial, ourvend_name, qty, amount, fetched_at
              from ourvend_sales
            `) as unknown as StockSaleRow[])
          : rows;

      if (all.length === 0) return { upserted: 0 };

      const machines = await this.db
        .select({ id: entity.id, ref: entity.externalRef })
        .from(entity)
        .where(eq(entity.type, "machine"));
      const serialToEntity = new Map(
        machines
          .filter((m) => m.ref !== null && m.ref.length > 0)
          .map((m) => [m.ref!.toLowerCase(), m.id]),
      );

      const values = buildUpserts(all, serialToEntity);
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
      const linked = await this.db.execute(sql`
        update ${sale} set machine_id = e.id
        from ${entity} e
        where ${sale.machineId} is null
          and e.type = 'machine'
          and lower(coalesce(e.external_ref, '')) = ${sale.machineSerial}
      `);
      const linkedCount = Number((linked as unknown as { count?: number }).count ?? 0);
      if (linkedCount > 0) {
        this.log.log(`Продажи привязаны к автоматам задним числом: ${linkedCount} строк.`);
      }

      await this.db.insert(event).values({
        source: "sales-sync",
        type: "sales.sync",
        payload: { upserted, привязано_задним_числом: linkedCount, из: "mydon-stock/ourvend" },
      });
      this.log.log(`Продажи синхронизированы: ${upserted} строк.`);
      return { upserted };
    } finally {
      await stock.end({ timeout: 5 });
    }
  }

  /** Сводка для дашборда: сегодня, вчера, 30 дней. */
  async summary(): Promise<{
    today: { qty: number; amount: number };
    yesterday: { qty: number; amount: number };
    days30: { qty: number; amount: number };
    lastSaleDt: string | null;
    configured: boolean;
  }> {
    const configured = Boolean(process.env.STOCK_DATABASE_URL);
    const today = todayLocal();
    const y = new Date();
    y.setDate(y.getDate() - 1);
    const yesterday = todayLocal(y);
    const d30 = new Date();
    d30.setDate(d30.getDate() - 30);

    const [row] = await this.db
      .select({
        tQty: sql<string>`coalesce(sum(${sale.qty}) filter (where ${sale.dt} = ${today}), 0)`,
        tAmt: sql<string>`coalesce(sum(${sale.amount}) filter (where ${sale.dt} = ${today}), 0)`,
        yQty: sql<string>`coalesce(sum(${sale.qty}) filter (where ${sale.dt} = ${yesterday}), 0)`,
        yAmt: sql<string>`coalesce(sum(${sale.amount}) filter (where ${sale.dt} = ${yesterday}), 0)`,
        mQty: sql<string>`coalesce(sum(${sale.qty}) filter (where ${sale.dt} >= ${todayLocal(d30)}), 0)`,
        mAmt: sql<string>`coalesce(sum(${sale.amount}) filter (where ${sale.dt} >= ${todayLocal(d30)}), 0)`,
        last: sql<string | null>`max(${sale.dt})::text`,
      })
      .from(sale);

    return {
      today: { qty: Number(row?.tQty ?? 0), amount: Number(row?.tAmt ?? 0) },
      yesterday: { qty: Number(row?.yQty ?? 0), amount: Number(row?.yAmt ?? 0) },
      days30: { qty: Number(row?.mQty ?? 0), amount: Number(row?.mAmt ?? 0) },
      lastSaleDt: row?.last ?? null,
      configured,
    };
  }

  /** Журнал: дневные позиции с именем автомата. */
  async journal(days = 7, limit = 300): Promise<(SaleRow & { machineName: string | null })[]> {
    const since = new Date();
    since.setDate(since.getDate() - days);
    const rows = await this.db
      .select({ row: sale, machineName: entity.name })
      .from(sale)
      .leftJoin(entity, eq(entity.id, sale.machineId))
      .where(gte(sale.dt, todayLocal(since)))
      .orderBy(desc(sale.dt), desc(sale.amount))
      .limit(limit);
    return rows.map((r) => ({ ...r.row, machineName: r.machineName }));
  }

  /** Автоматы, молчащие N дней: продажи были раньше, а теперь нет — сигнал связи. */
  async silent(daysQuiet = 2): Promise<{ machineId: string | null; serial: string; name: string | null; lastDt: string }[]> {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - daysQuiet);
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
      .having(sql`max(${sale.dt}) < ${todayLocal(cutoff)}`);
    return rows;
  }
}
