import { Inject, Injectable } from "@nestjs/common";
import { desc } from "drizzle-orm";
import { ourvendSaleSnapshot, productSale, slotSnapshot, vendingSyncRun } from "@mydon/db";
import type { OurvendHealth, OurvendSyncRun } from "@mydon/shared";
import { DB, type Db } from "../db/db.module";
import { failedStreak, STREAK_SCAN_LIMIT } from "../vending/sync-streak";
import { OurvendParityService } from "./ourvend-parity.service";

/**
 * Здоровье сбора OurVend (R-P5b-8): прогоны, серия отказов, свежесть снимков,
 * паритет с учётной дорожкой.
 *
 * ЗАЧЕМ ОТЧЁТ ВООБЩЕ ЕСТЬ. 25.08.2026 сбор падал с 24-го двенадцать раз
 * подряд, и не заметил никто: слоты писались (их берёт другой прогон), а
 * продажи — нет. Ни один дашборд не показывал «сбор стоит», потому что
 * показывать было нечему: отсутствие строк выглядит как тишина, а не как
 * авария. Этот отчёт превращает тишину в число.
 *
 * ЧЕГО ЗДЕСЬ НЕТ: живого запроса к OurVend. Коннектор живёт в слое агентов и
 * ходит по крону; делать вид, что «сверка» стучится в кабинет прямо сейчас,
 * значит обещать свежесть, которой нет. Отчёт честно показывает СЛЕДЫ сбора.
 *
 * ЛАГ `null` — ЭТО НЕ НОЛЬ. Ноль минут читается как «только что сняли», а
 * пустая таблица снимков означает ровно обратное: снимков нет вовсе. Поэтому
 * `null` доезжает до бота и панели как есть, и обе витрины печатают
 * «снимков нет», а не «0 мин».
 *
 * КЕША НЕТ НАМЕРЕННО. Весь смысл отчёта — свежесть; пятиминутный кеш показывал
 * бы лаг пятиминутной давности ровно тогда, когда владелец обновляет страницу,
 * чтобы понять, поднялся ли сбор. От нагрузки защищает троттл на роуте.
 */

/** Сколько прогонов показываем по умолчанию — ровно столько просят бот и панель. */
export const HEALTH_RUNS_DEFAULT = 20;
export const HEALTH_RUNS_MAX = 100;

/** Окно паритета — то же, что у гейта переключения источника учёта (7 зелёных дней). */
const PARITY_DAYS = 7;

const МИНУТА = 60_000;
const ЧАС = 3_600_000;

@Injectable()
export class OurvendHealthService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly parity: OurvendParityService,
  ) {}

  /**
   * `now` — параметр, а не `Date.now()` внутри: лаг считается от него, и тест
   * обязан уметь задать момент, иначе проверялось бы «примерно столько же».
   */
  async health(runs = HEALTH_RUNS_DEFAULT, now = new Date()): Promise<OurvendHealth> {
    const n = зажать(runs);
    const [прогоны, слоты, продажи, витрина, паритет] = await Promise.all([
      this.db
        .select({
          id: vendingSyncRun.id,
          startedAt: vendingSyncRun.startedAt,
          finishedAt: vendingSyncRun.finishedAt,
          status: vendingSyncRun.status,
          machinesTotal: vendingSyncRun.machinesTotal,
          machinesOk: vendingSyncRun.machinesOk,
          error: vendingSyncRun.error,
          durationMs: vendingSyncRun.durationMs,
        })
        .from(vendingSyncRun)
        .orderBy(desc(vendingSyncRun.startedAt))
        .limit(Math.max(n, STREAK_SCAN_LIMIT)),
      // Свежесть — тремя отдельными запросами «последняя строка», а не
      // `max()`: и то и другое идёт по индексу, но строку видно целиком, и
      // заглушка юнит-теста исполняет ровно тот же путь, что и Postgres.
      this.db
        .select({ at: slotSnapshot.capturedAt })
        .from(slotSnapshot)
        .orderBy(desc(slotSnapshot.capturedAt))
        .limit(1),
      this.db
        .select({ at: ourvendSaleSnapshot.fetchedAt })
        .from(ourvendSaleSnapshot)
        .orderBy(desc(ourvendSaleSnapshot.fetchedAt))
        .limit(1),
      this.db
        .select({ at: productSale.capturedAt })
        .from(productSale)
        .orderBy(desc(productSale.capturedAt))
        .limit(1),
      this.parity.parity(PARITY_DAYS),
    ]);

    const серия = failedStreak(прогоны);
    const успех = прогоны.find((r) => r.status === "success");

    return {
      runs: прогоны.slice(0, n).map(строкаПрогона),
      failedStreak: серия.streak,
      // Успех датируется ЗАВЕРШЕНИЕМ, а не стартом: «последний раз данные
      // приехали в 03:07», а не «мы начали пробовать в 03:05».
      lastSuccessAt: успех ? (успех.finishedAt ?? успех.startedAt).toISOString() : null,
      slotsLagMin: лаг(слоты[0]?.at, now, МИНУТА, 0),
      salesLagH: лаг(продажи[0]?.at, now, ЧАС, 1),
      productSaleLagH: лаг(витрина[0]?.at, now, ЧАС, 1),
      parity: {
        days: паритет.days,
        ok: паритет.ok,
        mismatches: паритет.mismatches.length,
        stockOk: паритет.stock.ok,
        note: паритет.note,
      },
    };
  }
}

function зажать(runs: number): number {
  const n = Math.trunc(runs);
  if (!Number.isFinite(n) || n <= 0) return HEALTH_RUNS_DEFAULT;
  return Math.min(n, HEALTH_RUNS_MAX);
}

type Прогон = {
  id: string;
  startedAt: Date;
  finishedAt: Date | null;
  status: OurvendSyncRun["status"];
  machinesTotal: number;
  machinesOk: number;
  error: string | null;
  durationMs: number | null;
};

const строкаПрогона = (r: Прогон): OurvendSyncRun => ({
  id: r.id,
  startedAt: r.startedAt.toISOString(),
  finishedAt: r.finishedAt ? r.finishedAt.toISOString() : null,
  status: r.status,
  machinesTotal: r.machinesTotal,
  machinesOk: r.machinesOk,
  durationMs: r.durationMs,
  error: r.error,
});

/**
 * Возраст снимка в заданных единицах. `undefined` на входе — снимков НЕТ
 * вовсе, и ответ `null`, а не ноль (см. шапку модуля).
 *
 * Отрицательный возраст (снимок «из будущего» — расхождение часов агента и
 * базы) зажимается в ноль: минус в поле «сколько прошло» владелец прочитал бы
 * как ошибку отчёта, а не как расхождение часов.
 */
function лаг(at: Date | undefined | null, now: Date, единица: number, знаков: number): number | null {
  if (!at) return null;
  const мс = Math.max(0, now.getTime() - at.getTime());
  const множитель = 10 ** знаков;
  return Math.round((мс / единица) * множитель) / множитель;
}
