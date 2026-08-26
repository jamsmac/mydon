import { Inject, Injectable, Logger } from "@nestjs/common";
import { event, ourvendSaleSnapshot, ourvendStockSnapshot } from "@mydon/db";
import { normalizeMachineSerial, strictNumber } from "@mydon/shared";
import { and, eq, sql } from "drizzle-orm";
import { DB, type Db } from "../db/db.module";

/**
 * Собственный учётный снапшот OurVend (П2 плана поглощения mydon-stock).
 *
 * Агент собирает кабинет и присылает дни целиком; здесь каждый (день, автомат),
 * ПО КОТОРОМУ ПРИЕХАЛИ СТРОКИ, перезаписывается атомарно — исчезнувшие у
 * вендора позиции не зависают (перенос семантики донора app/ourvend.py:
 * DELETE+INSERT в транзакции). Пустой день сутки не стирает: см. `rewriteKeys`.
 * До переключения OURVEND_ACCOUNTING_SOURCE=own таблицы теневые: по ним
 * считается паритет со stock-дорожкой (гейт «7 дней сходимости»).
 */

/** Один день одного автомата в присланном снапшоте. */
export interface SnapshotDay {
  dt: string;
  machineSerial: string;
  rows: { product: string; qty: unknown; amount?: unknown }[];
}

export interface QuarantinedSnapshotRow {
  dt: string;
  machineSerial: string;
  product: string;
  field: "qty" | "amount";
  value: unknown;
}

/**
 * exported для тестов: построчная проверка чисел (правило среза D — массовые
 * операции валидируются построчно в сервисе, мусор не вливается нулём).
 * Строки-двойники одного (день, автомат, товар) АГРЕГИРУЮТСЯ суммой — иначе
 * plain INSERT под уникальным индексом откатил бы всю пачку по 23505.
 * Битые формы (rows не массив, null-элементы) отбрасываются, а не роняют POST.
 */
export function buildSnapshotRows(
  days: SnapshotDay[],
  withAmount: boolean,
): {
  clean: { dt: string; machineSerial: string; product: string; qty: number; amount: number }[];
  quarantined: QuarantinedSnapshotRow[];
} {
  const agg = new Map<string, { dt: string; machineSerial: string; product: string; qty: number; amount: number }>();
  const quarantined: QuarantinedSnapshotRow[] = [];
  for (const day of days) {
    if (!day || typeof day.dt !== "string" || !day.machineSerial) continue;
    const dt = day.dt.slice(0, 10);
    // Канон серийника — как в ключах sale/machine_stock (см. buildUpserts).
    const machineSerial = normalizeMachineSerial(String(day.machineSerial));
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dt) || machineSerial.length === 0) continue;
    if (!Array.isArray(day.rows)) continue;
    for (const r of day.rows) {
      if (r === null || typeof r !== "object") continue;
      const product = typeof r.product === "string" ? r.product.trim().slice(0, 512) : "";
      if (!product) continue;
      const qty = strictNumber(r.qty);
      if (qty === null) {
        quarantined.push({ dt, machineSerial, product, field: "qty", value: r.qty });
        continue;
      }
      const amount = withAmount ? strictNumber(r.amount) : 0;
      if (withAmount && amount === null) {
        quarantined.push({ dt, machineSerial, product, field: "amount", value: r.amount });
        continue;
      }
      const key = `${dt}|${machineSerial}|${product}`;
      const prev = agg.get(key);
      if (prev) {
        prev.qty += qty;
        prev.amount += amount ?? 0;
      } else {
        agg.set(key, { dt, machineSerial, product, qty, amount: amount ?? 0 });
      }
    }
  }
  return { clean: [...agg.values()], quarantined };
}

/**
 * Ключи (день, автомат), которые надо перезаписать, — ПО ЧИСТЫМ СТРОКАМ
 * (R-FW-S7).
 *
 * ПУСТОЙ ДЕНЬ БОЛЬШЕ НЕ СТИРАЕТ СУТКИ АВТОМАТА. Раньше ключ брался из
 * присланных дней независимо от того, осталась ли после проверки чисел хоть
 * одна строка: пустой ответ кабинета (или ответ, где ВСЕ строки ушли в
 * карантин) сносил `(dt, серийник)` целиком. До катовера это была тень, а в
 * режиме `own` — боевой учёт: сутки продаж автомата исчезали бы из `sale` без
 * ошибки и без следа. Удаление теперь всегда ЗАМЕНА: снесли ровно те ключи, по
 * которым что-то приехало.
 *
 * Обратная сторона решения принята сознательно: день, у которого вендор
 * ЗАКОННО обнулил все строки, останется в снапшоте старым. Это видно паритетом
 * («в нашем снапшоте есть, у второй стороны нет»), а тихая потеря суток — нет.
 *
 * Принимает любые строки с `dt`/`machineSerial` — и присланные дни, и чистые
 * строки: проверка формы и канон серийника здесь всё равно свои.
 */
export function rewriteKeys(days: { dt: string; machineSerial: string }[]): { dt: string; machineSerial: string }[] {
  const seen = new Set<string>();
  const out: { dt: string; machineSerial: string }[] = [];
  for (const day of days) {
    if (!day || typeof day.dt !== "string" || !day.machineSerial) continue;
    const dt = day.dt.slice(0, 10);
    const machineSerial = normalizeMachineSerial(String(day.machineSerial));
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dt) || machineSerial.length === 0) continue;
    const key = `${dt}|${machineSerial}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ dt, machineSerial });
  }
  return out;
}

@Injectable()
export class OurvendSnapshotService {
  private readonly log = new Logger(OurvendSnapshotService.name);

  constructor(@Inject(DB) private readonly db: Db) {}

  /** Принять пачку дней продаж и/или снимков остатков. Идемпотентно. */
  async apply(input: { sales?: SnapshotDay[]; stock?: SnapshotDay[] }): Promise<{
    saleDays: number;
    saleRows: number;
    stockDays: number;
    stockRows: number;
    quarantined: number;
  }> {
    const fetchedAt = new Date();
    const sales = buildSnapshotRows(input.sales ?? [], true);
    const stock = buildSnapshotRows(input.stock ?? [], false);

    // Ключи перезаписи — ИЗ ЧИСТЫХ СТРОК, а не из присланных дней (R-FW-S7):
    // пустой или целиком забракованный день не должен стирать сутки автомата.
    const saleKeys = rewriteKeys(sales.clean);
    const stockKeys = rewriteKeys(stock.clean);

    await this.db.transaction(async (tx) => {
      for (const k of saleKeys) {
        await tx
          .delete(ourvendSaleSnapshot)
          .where(and(eq(ourvendSaleSnapshot.dt, k.dt), eq(ourvendSaleSnapshot.machineSerial, k.machineSerial)));
      }
      const saleValues = sales.clean.map((r) => ({
        dt: r.dt,
        machineSerial: r.machineSerial,
        product: r.product,
        qty: String(r.qty),
        amount: String(r.amount),
        fetchedAt,
      }));
      for (let i = 0; i < saleValues.length; i += 500) {
        await tx.insert(ourvendSaleSnapshot).values(saleValues.slice(i, i + 500));
      }

      for (const k of stockKeys) {
        await tx
          .delete(ourvendStockSnapshot)
          .where(and(eq(ourvendStockSnapshot.dt, k.dt), eq(ourvendStockSnapshot.machineSerial, k.machineSerial)));
      }
      const stockValues = stock.clean.map((r) => ({
        dt: r.dt,
        machineSerial: r.machineSerial,
        product: r.product,
        qty: String(r.qty),
        fetchedAt,
      }));
      for (let i = 0; i < stockValues.length; i += 500) {
        await tx.insert(ourvendStockSnapshot).values(stockValues.slice(i, i + 500));
      }
    });

    const quarantined = sales.quarantined.length + stock.quarantined.length;
    if (quarantined > 0) {
      await this.db.insert(event).values({
        source: "ourvend-accounting",
        type: "ourvend.snapshot_quarantine",
        payload: {
          count: quarantined,
          rows: [...sales.quarantined, ...stock.quarantined].slice(0, 50),
        },
      });
      this.log.warn(`Снапшот OurVend: карантин ${quarantined} строк с нечисловыми значениями.`);
    }
    if (saleKeys.length + stockKeys.length > 0) {
      await this.db.insert(event).values({
        source: "ourvend-accounting",
        type: "ourvend.snapshot",
        payload: {
          продажи_дней: saleKeys.length,
          продажи_строк: sales.clean.length,
          остатки_машин: stockKeys.length,
          остатки_строк: stock.clean.length,
        },
      });
    }
    return {
      saleDays: saleKeys.length,
      saleRows: sales.clean.length,
      stockDays: stockKeys.length,
      stockRows: stock.clean.length,
      quarantined,
    };
  }

  /**
   * Докуда дотянулись снапшоты. Вотермарки ПОМАШИННЫЕ: сбой продаж одной
   * машины не должен «уезжать» вместе с глобальным max(dt) здоровых машин —
   * иначе её дни терялись бы навсегда и молча.
   */
  async status(): Promise<{
    lastSaleDt: string | null;
    lastStockDt: string | null;
    perMachineSale: { machineSerial: string; last: string }[];
  }> {
    const [s] = await this.db
      .select({ last: sql<string | null>`max(${ourvendSaleSnapshot.dt})::text` })
      .from(ourvendSaleSnapshot);
    const [m] = await this.db
      .select({ last: sql<string | null>`max(${ourvendStockSnapshot.dt})::text` })
      .from(ourvendStockSnapshot);
    const perMachine = await this.db
      .select({
        machineSerial: ourvendSaleSnapshot.machineSerial,
        last: sql<string>`max(${ourvendSaleSnapshot.dt})::text`,
      })
      .from(ourvendSaleSnapshot)
      .groupBy(ourvendSaleSnapshot.machineSerial);
    return { lastSaleDt: s?.last ?? null, lastStockDt: m?.last ?? null, perMachineSale: perMachine };
  }
}
