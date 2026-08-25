import { Inject, Injectable, Logger, type OnApplicationShutdown, OnModuleInit } from "@nestjs/common";
import { event, machineStock, ourvendSaleSnapshot, ourvendStockSnapshot, sale } from "@mydon/db";
import { machineSerialSql, normalizeProductName } from "@mydon/shared";
import { sql } from "drizzle-orm";
import { Cron } from "croner";
import { DB, type Db } from "../db/db.module";

/**
 * Паритет собственного снапшота OurVend со stock-дорожкой — гейт П2.
 *
 * Пока `sale` наполняется чтением БД mydon-stock, а наш снапшот пишется в
 * тень, этот сервис ежедневно сверяет их по (день, автомат): суммы штук и
 * денег. 7 подряд зелёных дней = разрешение переключить
 * OURVEND_ACCOUNTING_SOURCE=own и погасить чтение чужой базы.
 * Серийники сравниваются каноном (у сторон разные формы: «c…» и голая).
 */

export interface ParityDayRow {
  dt: string;
  serial: string;
  qty: number;
  amount: number;
}

export interface ParityMismatch {
  dt: string;
  serial: string;
  ownQty: number;
  stockQty: number;
  ownAmount: number;
  stockAmount: number;
  reason: string;
}

/** exported для тестов: чистое сравнение двух агрегатов. */
export function computeParity(
  own: ParityDayRow[],
  stockSide: ParityDayRow[],
): { checked: number; mismatches: ParityMismatch[] } {
  const key = (r: { dt: string; serial: string }) => `${r.dt}|${r.serial}`;
  const stockMap = new Map(stockSide.map((r) => [key(r), r]));
  const seen = new Set<string>();
  const mismatches: ParityMismatch[] = [];
  let checked = 0;
  const close = (a: number, b: number) => Math.abs(a - b) < 0.01;
  for (const o of own) {
    checked += 1;
    seen.add(key(o));
    const s = stockMap.get(key(o));
    if (!s) {
      mismatches.push({
        dt: o.dt,
        serial: o.serial,
        ownQty: o.qty,
        stockQty: 0,
        ownAmount: o.amount,
        stockAmount: 0,
        reason: "у stock-дорожки нет этого дня/автомата",
      });
      continue;
    }
    if (!close(o.qty, s.qty) || !close(o.amount, s.amount)) {
      mismatches.push({
        dt: o.dt,
        serial: o.serial,
        ownQty: o.qty,
        stockQty: s.qty,
        ownAmount: o.amount,
        stockAmount: s.amount,
        reason: "суммы расходятся",
      });
    }
  }
  for (const s of stockSide) {
    if (seen.has(key(s))) continue;
    mismatches.push({
      dt: s.dt,
      serial: s.serial,
      ownQty: 0,
      stockQty: s.qty,
      ownAmount: 0,
      stockAmount: s.amount,
      reason: "в нашем снапшоте нет этого дня/автомата",
    });
  }
  return { checked, mismatches };
}

/** Остаток автомата строкой: день, автомат, товар, штуки. */
export interface ParityStockRow {
  dt: string;
  serial: string;
  product: string;
  qty: number;
}

export interface ParityStockMismatch {
  dt: string;
  serial: string;
  product: string;
  own: number;
  stock: number;
  reason: string;
}

/**
 * Сверка остатков автоматов (гашение связи №1, П4/R-P4-6) — чистое сравнение,
 * exported для тестов.
 *
 * СРАВНИВАЮТСЯ ТОЛЬКО АВТОМАТЫ, КОТОРЫЕ ЕСТЬ У ОБЕИХ СТОРОН. Аппарат,
 * заведённый у нас и ещё не появившийся в stock-дорожке (или наоборот),
 * красил бы гейт каждый день — и семь зелёных подряд не наступили бы никогда,
 * хотя расхождения по существу нет.
 *
 * Имя товара сравнивается НОРМАЛИЗОВАННЫМ: стороны пишут «Red  Bull» и
 * «red bull», и посимвольное сравнение объявило бы расхождением опечатку в
 * пробеле. Показываем при этом имя как есть — владельцу нужно то написание,
 * которое он увидит в кабинете.
 */
export function computeStockParity(
  own: ParityStockRow[],
  stockSide: ParityStockRow[],
): { checked: number; mismatches: ParityStockMismatch[] } {
  const общие = new Set(
    [...new Set(own.map((r) => r.serial))].filter((s) => stockSide.some((r) => r.serial === s)),
  );
  const key = (r: ParityStockRow) => `${r.dt}|${r.serial}|${normalizeProductName(r.product)}`;
  const ourOwn = own.filter((r) => общие.has(r.serial));
  const ourStock = stockSide.filter((r) => общие.has(r.serial));
  const stockMap = new Map(ourStock.map((r) => [key(r), r]));
  const seen = new Set<string>();
  const mismatches: ParityStockMismatch[] = [];
  let checked = 0;

  for (const o of ourOwn) {
    checked += 1;
    seen.add(key(o));
    const s = stockMap.get(key(o));
    if (!s) {
      mismatches.push({
        dt: o.dt,
        serial: o.serial,
        product: o.product,
        own: o.qty,
        stock: 0,
        reason: "у stock-дорожки нет этой позиции",
      });
      continue;
    }
    if (Math.abs(o.qty - s.qty) >= 0.01) {
      mismatches.push({ dt: o.dt, serial: o.serial, product: o.product, own: o.qty, stock: s.qty, reason: "остатки расходятся" });
    }
  }
  for (const s of ourStock) {
    if (seen.has(key(s))) continue;
    mismatches.push({
      dt: s.dt,
      serial: s.serial,
      product: s.product,
      own: 0,
      stock: s.qty,
      reason: "в нашем снапшоте нет этой позиции",
    });
  }
  return { checked, mismatches };
}

@Injectable()
export class OurvendParityService implements OnModuleInit, OnApplicationShutdown {
  private readonly log = new Logger(OurvendParityService.name);
  private cron: Cron | null = null;

  constructor(@Inject(DB) private readonly db: Db) {}

  onModuleInit(): void {
    // Утром, после и снапшота stock (07:50), и нашего (08:05): обе стороны
    // уже отработали за вчера.
    this.cron = new Cron("40 8 * * *", { timezone: "Asia/Tashkent" }, () => {
      void this.daily().catch((e: unknown) =>
        this.log.warn(`Паритет OurVend не посчитался: ${e instanceof Error ? e.message : String(e)}`),
      );
    });
  }

  onApplicationShutdown(): void {
    this.cron?.stop();
    this.cron = null;
  }

  /**
   * Сверка последних N дней, где у нашего снапшота есть данные. Сегодняшний
   * день не сверяется: stock-дорожка снимает «вчера», у сегодняшнего дня обе
   * стороны заведомо неполные.
   */
  async parity(days = 7): Promise<{
    days: number;
    checked: number;
    ok: boolean;
    mismatches: ParityMismatch[];
    ownRows: number;
    note: string | null;
    /** Вторая половина гейта: остатки автоматов (связь №1, П4). */
    stock: { days: number; checked: number; ok: boolean; mismatches: ParityStockMismatch[] };
  }> {
    const n = Math.min(Math.max(Math.trunc(days) || 7, 1), 30);
    // Канон серийника — общий SQL-хелпер (@mydon/shared), тот же, что в
    // синках: у сторон разные формы («c…» и голая), сравнивать можно только
    // приведённые.
    const canon = (col: string) => sql.raw(machineSerialSql(col));

    const ownRaw = (await this.db.execute(sql`
      select dt::text as dt, ${canon("machine_serial")} as serial,
             sum(qty)::float as qty, sum(amount)::float as amount
      from ${ourvendSaleSnapshot}
      where dt >= (current_date - ${sql.raw(String(n))}::int)
        and dt < current_date
      group by 1, 2
    `)) as unknown as ParityDayRow[];
    // Stock-сторона НЕ фильтруется по дням снапшота: день, выпавший из
    // снапшота (сбой агента, пустая перезапись), обязан всплыть расхождением
    // «в нашем снапшоте нет», а не исчезнуть из сверки. Дни до внедрения
    // снапшота отсекаются его минимальной датой — иначе вся история до
    // старта была бы вечным красным.
    const stockRaw = (await this.db.execute(sql`
      select dt::text as dt, ${canon("machine_serial")} as serial,
             sum(qty)::float as qty, sum(amount)::float as amount
      from ${sale}
      where source = 'ourvend'
        and dt >= (current_date - ${sql.raw(String(n))}::int)
        and dt < current_date
        and dt >= (select min(dt) from ${ourvendSaleSnapshot})
      group by 1, 2
    `)) as unknown as ParityDayRow[];

    // ── Вторая половина гейта: остатки автоматов (связь №1, R-P4-6) ──
    // Сравниваются те же дни и тем же каноном серийника, но ключ на разряд
    // подробнее: (день, автомат, ТОВАР). Суммы по автомату сошлись бы и при
    // перепутанных товарах, а после флипа планограмму и закуп мы будем строить
    // именно по товарам.
    const ownStockRaw = (await this.db.execute(sql`
      select dt::text as dt, ${canon("machine_serial")} as serial, product,
             sum(qty)::float as qty
      from ${ourvendStockSnapshot}
      where dt >= (current_date - ${sql.raw(String(n))}::int)
        and dt < current_date
      group by 1, 2, 3
    `)) as unknown as ParityStockRow[];
    const stockStockRaw = (await this.db.execute(sql`
      select dt::text as dt, ${canon("machine_serial")} as serial, product,
             sum(qty)::float as qty
      from ${machineStock}
      where dt >= (current_date - ${sql.raw(String(n))}::int)
        and dt < current_date
        and dt >= (select min(dt) from ${ourvendStockSnapshot})
      group by 1, 2, 3
    `)) as unknown as ParityStockRow[];

    const own = ownRaw.map((r) => ({ ...r, qty: Number(r.qty), amount: Number(r.amount) }));
    const stockSide = stockRaw.map((r) => ({ ...r, qty: Number(r.qty), amount: Number(r.amount) }));
    const { checked, mismatches } = computeParity(own, stockSide);

    const ownStock = ownStockRaw.map((r) => ({ ...r, qty: Number(r.qty) }));
    const stockStock = stockStockRaw.map((r) => ({ ...r, qty: Number(r.qty) }));
    const остатки = computeStockParity(ownStock, stockStock);
    const stock = {
      days: n,
      checked: остатки.checked,
      // Пустая сверка — НЕ «ок»: ноль расхождений при нуле сверенных пар это
      // «мы ничего не проверили», и зачесть такой день в семь зелёных значит
      // разрешить флип по молчанию.
      ok: остатки.mismatches.length === 0 && остатки.checked > 0,
      mismatches: остатки.mismatches,
    };

    const note =
      own.length === 0
        ? "собственный снапшот ещё пуст — сверять нечего (агент ещё не отработал?)"
        : null;
    return {
      days: n,
      checked,
      // Вердикт — И по продажам, И по остаткам: флаг переключения один
      // (`OURVEND_ACCOUNTING_SOURCE`), значит и разрешение на него одно.
      ok: mismatches.length === 0 && own.length > 0 && stock.ok,
      mismatches,
      ownRows: own.length,
      note,
      stock,
    };
  }

  /** Ежедневный вердикт — событием: 7 зелёных подряд открывают переключение. */
  async daily(): Promise<void> {
    const p = await this.parity(7);
    if (p.note) {
      this.log.log(`Паритет OurVend: ${p.note}`);
      return;
    }
    await this.db.insert(event).values({
      source: "ourvend-accounting",
      type: "ourvend.parity",
      payload: {
        ok: p.ok,
        дней: p.days,
        сверено_пар: p.checked,
        расхождений: p.mismatches.length,
        расхождения: p.mismatches.slice(0, 50),
        // Обе половины гейта в ОДНОЙ сводке: два отдельных события владелец
        // читал бы как два независимых вердикта, а переключение одно.
        остатки_сверено: p.stock.checked,
        остатки_расхождений: p.stock.mismatches.length,
        остатки_расхождения: p.stock.mismatches.slice(0, 50),
      },
    });
    this.log.log(
      `Паритет OurVend: ${p.ok ? "ОК" : "расхождения"} — продажи ${p.mismatches.length} из ${p.checked} пар, ` +
        `остатки ${p.stock.mismatches.length} из ${p.stock.checked}.`,
    );
  }
}
