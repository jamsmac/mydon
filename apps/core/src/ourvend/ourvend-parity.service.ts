import { Inject, Injectable, Logger, type OnApplicationShutdown, OnModuleInit } from "@nestjs/common";
import { event, ourvendSaleSnapshot, sale } from "@mydon/db";
import { machineSerialSql } from "@mydon/shared";
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

    const own = ownRaw.map((r) => ({ ...r, qty: Number(r.qty), amount: Number(r.amount) }));
    const stockSide = stockRaw.map((r) => ({ ...r, qty: Number(r.qty), amount: Number(r.amount) }));
    const { checked, mismatches } = computeParity(own, stockSide);
    const note =
      own.length === 0
        ? "собственный снапшот ещё пуст — сверять нечего (агент ещё не отработал?)"
        : null;
    return { days: n, checked, ok: mismatches.length === 0 && own.length > 0, mismatches, ownRows: own.length, note };
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
      },
    });
    this.log.log(`Паритет OurVend: ${p.ok ? "ОК" : `расхождений ${p.mismatches.length}`} (пар ${p.checked}).`);
  }
}
