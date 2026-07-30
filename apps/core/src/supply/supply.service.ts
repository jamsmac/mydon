import { Inject, Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { entity, event, machineStock, purchase } from "@mydon/db";
import { desc, eq, gte, sql } from "drizzle-orm";
import { Cron } from "croner";
import { DB, type Db } from "../db/db.module";
import { todayLocal } from "../sales/sales.service";

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

/** exported для тестов: превращение строк источника в наши. */
export function buildPurchaseUpserts(rows: StockPurchaseRow[]): (typeof purchase.$inferInsert)[] {
  return rows
    .filter((r) => r.product && r.dt)
    .map((r) => ({
      extId: String(r.id),
      dt: String(r.dt).slice(0, 10),
      product: String(r.product).slice(0, 512),
      unit: r.unit ? String(r.unit) : null,
      qty: String(Number(r.qty) || 0),
      unitPrice: r.unit_price === null ? null : String(Number(r.unit_price) || 0),
      total: r.total === null ? null : String(Number(r.total) || 0),
      note: r.note ? String(r.note).slice(0, 1000) : null,
      expiryDate: r.expiry_date ? String(r.expiry_date).slice(0, 10) : null,
      source: "stock",
    }));
}

export function buildStockUpserts(
  rows: StockLevelRow[],
  serialToEntity: Map<string, string>,
): (typeof machineStock.$inferInsert)[] {
  return rows
    .filter((r) => r.machine_serial && r.ourvend_name && r.dt)
    .map((r) => ({
      dt: String(r.dt).slice(0, 10),
      machineSerial: String(r.machine_serial).toLowerCase(),
      machineId: serialToEntity.get(String(r.machine_serial).toLowerCase()) ?? null,
      product: String(r.ourvend_name).slice(0, 512),
      qty: String(Number(r.qty) || 0),
      fetchedAt: new Date(r.fetched_at),
    }));
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
export class SupplyService implements OnModuleInit {
  private readonly log = new Logger(SupplyService.name);
  private cron: Cron | null = null;

  constructor(@Inject(DB) private readonly db: Db) {}

  onModuleInit(): void {
    if (!process.env.STOCK_DATABASE_URL) {
      this.log.log("STOCK_DATABASE_URL не задан — синк снабжения выключен.");
      return;
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

  async sync(): Promise<{ purchases: number; stock: number }> {
    const url = process.env.STOCK_DATABASE_URL;
    if (!url) return { purchases: 0, stock: 0 };

    const { default: postgres } = await import("postgres");
    const stock = postgres(url, { prepare: false, max: 1, connect_timeout: 10 });
    try {
      // Приход: имя товара и единица разворачиваются сразу — у нас плоская строка.
      const [{ np }] = await this.db.select({ np: sql<number>`count(*)` }).from(purchase);
      const pRows = (await (Number(np) === 0
        ? stock`
            select p.id, p.dt::text, pr.name as product, pr.unit, p.qty, p.unit_price, p.total,
                   p.note, p.expiry_date::text
            from purchases p join products pr on pr.id = p.product_id`
        : stock`
            select p.id, p.dt::text, pr.name as product, pr.unit, p.qty, p.unit_price, p.total,
                   p.note, p.expiry_date::text
            from purchases p join products pr on pr.id = p.product_id
            where p.created_at > now() - interval '3 days'`)) as unknown as StockPurchaseRow[];

      const [{ ns }] = await this.db.select({ ns: sql<number>`count(*)` }).from(machineStock);
      const sRows = (await (Number(ns) === 0
        ? stock`
            select dt::text, machine_serial, ourvend_name, qty, fetched_at
            from ourvend_machine_stock`
        : stock`
            select dt::text, machine_serial, ourvend_name, qty, fetched_at
            from ourvend_machine_stock
            where fetched_at > now() - interval '3 days'`)) as unknown as StockLevelRow[];

      const machines = await this.db
        .select({ id: entity.id, ref: entity.externalRef })
        .from(entity)
        .where(eq(entity.type, "machine"));
      const serialToEntity = new Map(
        machines.filter((m) => m.ref).map((m) => [m.ref!.toLowerCase(), m.id]),
      );

      const pValues = buildPurchaseUpserts(pRows);
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

      const sValues = buildStockUpserts(sRows, serialToEntity);
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

      // Дозаполнение карточек автоматов из источника: тип (кофе/снеки) и точка.
      // Ревизия 2026-07-30: у 11 из 26 автоматов тип был не указан — панель
      // честно писала «не указан», но пустоту надо закрывать, а не только
      // показывать. Заполняем лишь пустые поля.
      const stockMachines = (await stock`
        select serial, name, kind, location from machines where serial is not null
      `) as unknown as StockMachineRow[];
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
      const linked = await this.db.execute(sql`
        update ${machineStock} set machine_id = e.id
        from ${entity} e
        where ${machineStock.machineId} is null
          and e.type = 'machine'
          and lower(coalesce(e.external_ref, '')) = ${machineStock.machineSerial}
      `);
      const linkedCount = Number((linked as unknown as { count?: number }).count ?? 0);
      if (linkedCount > 0) {
        this.log.log(`Остатки привязаны к автоматам задним числом: ${linkedCount} строк.`);
      }

      if (pValues.length + sValues.length > 0) {
        await this.db.insert(event).values({
          source: "supply-sync",
          type: "supply.sync",
          payload: { приход: pValues.length, остатки: sValues.length },
        });
      }
      this.log.log(`Снабжение: приход ${pValues.length}, остатки ${sValues.length}.`);
      return { purchases: pValues.length, stock: sValues.length };
    } finally {
      await stock.end({ timeout: 5 });
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

  /** Сводка снабжения для плиток. */
  async summary(): Promise<{
    purchases30: { count: number; total: number };
    emptyPositions: number;
    lowPositions: number;
    lastStockDt: string | null;
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
    };
  }
}
