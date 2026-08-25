import { Inject, Injectable, Logger } from "@nestjs/common";
import { desc } from "drizzle-orm";
import { ourvendSaleSnapshot, productSale, slotSnapshot, vendingSyncRun } from "@mydon/db";
import { staleHours, type OurvendHealth, type OurvendSyncRun } from "@mydon/shared";
import { DB, type Db } from "../db/db.module";
import { readIntSetting } from "../system/settings";
import { ReportCache } from "../vending/report-cache";
import { failedStreak, STREAK_SCAN_LIMIT } from "../vending/sync-streak";
import { OurvendParityService } from "./ourvend-parity.service";
import { lastSuccessRunAt } from "./sync-runs";
import { SYNC_STALE_HOURS_FALLBACK } from "./sync-stale.service";

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
 * КЕШ — МИНУТА, А НЕ ПЯТЬ. Весь смысл отчёта — свежесть, и пятиминутный кеш
 * показывал бы лаг пятиминутной давности ровно тогда, когда владелец обновляет
 * страницу, чтобы понять, поднялся ли сбор. Но и без кеша нельзя: внутри —
 * четыре «последних строки» и ВЕСЬ сырой SQL паритета, а зовут отчёт двое
 * (`GET /ourvend/health` и недельная сводка) с РАЗНЫМИ счётчиками троттла,
 * то есть до 24 прогонов паритета в минуту с одного адреса. Сбор ходит раз в
 * три часа — за минуту здоровье измениться не может, и минута кеша не врёт
 * ничем, кроме округления лага.
 */

/** Сколько прогонов показываем по умолчанию — ровно столько просят бот и панель. */
export const HEALTH_RUNS_DEFAULT = 20;
export const HEALTH_RUNS_MAX = 100;

/** Окно паритета — то же, что у гейта переключения источника учёта (7 зелёных дней). */
const PARITY_DAYS = 7;

/**
 * Срок жизни готового отчёта о здоровье — минута (см. шапку модуля).
 *
 * Ключ кеша содержит МИНУТУ момента, а не только окно: `now` здесь параметр
 * (иначе лаг нечем проверить тестом), и ключ без него отдавал бы вызывающему
 * с другим моментом чужой ответ.
 */
export const HEALTH_CACHE_MS = 60_000;

const МИНУТА = 60_000;
const ЧАС = 3_600_000;

@Injectable()
export class OurvendHealthService {
  private readonly logger = new Logger(OurvendHealthService.name);
  private readonly кеш = new ReportCache(HEALTH_CACHE_MS);

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
    const минута = Math.floor(now.getTime() / HEALTH_CACHE_MS);
    return this.кеш.get(`ourvend-health|${n}|${минута}`, () => this.здоровье(n, now));
  }

  private async здоровье(n: number, now: Date): Promise<OurvendHealth> {
    const [прогоны, слоты, продажи, витрина, паритет, успех, порог] = await Promise.all([
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
      lastSuccessRunAt(this.db),
      // Порог застоя — В ОТВЕТЕ, а не только у сторожа: бот и панель рисуют
      // «⛔ сбор стоит» сравнением `staleHours >= staleThresholdH`, и своя
      // константа у каждого разошлась бы с базой в тот же день, когда владелец
      // подвинет порог в панели настроек (R-P8a-6).
      readIntSetting(this.db, "SYNC_STALE_HOURS", SYNC_STALE_HOURS_FALLBACK, this.logger),
    ]);

    const серия = failedStreak(прогоны);
    const успехAt = успех ? успех.toISOString() : null;

    return {
      runs: прогоны.slice(0, n).map(строкаПрогона),
      failedStreak: серия.streak,
      lastSuccessAt: успехAt,
      // Один расчёт давности на всех читателей (`staleHours` из shared): своя
      // формула здесь разошлась бы со сторожем, и витрина показывала бы
      // «стоит 6 ч» там, где сторож молчит.
      staleHours: staleHours(успехAt, now),
      staleThresholdH: порог,
      slotsLagMin: лаг(слоты[0]?.at, now, МИНУТА, 0),
      salesLagH: лаг(продажи[0]?.at, now, ЧАС, 1),
      productSaleLagH: лаг(витрина[0]?.at, now, ЧАС, 1),
      parity: {
        days: паритет.days,
        ok: паритет.ok,
        // Сверенных пар ПРОДАЖ — рядом с числом расхождений: без него
        // «расхождений 0» и «сверять было нечего» выглядят одинаково.
        checked: паритет.checked,
        mismatches: паритет.mismatches.length,
        stockOk: паритет.stock.ok,
        // СКОЛЬКО ПАР ОСТАТКОВ ВООБЩЕ СРАВНИВАЛОСЬ. Без этого числа
        // `stockOk: false` при `mismatches: 0` читается как «расхождений ноль,
        // но всё плохо» — а на проде это первый же случай: снимок остатков
        // есть только за сегодня, сверка идёт по закрытым суткам, и сверять
        // физически не по чему. Витрина обязана сказать это словами.
        stockChecked: паритет.stock.checked,
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
