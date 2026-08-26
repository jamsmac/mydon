import { Inject, Injectable, Logger } from "@nestjs/common";
import { desc } from "drizzle-orm";
import { ourvendSaleSnapshot, productSale, slotSnapshot, vendingSyncRun } from "@mydon/db";
import { staleHours, type OurvendHealth, type OurvendSyncRun, type ParityStreak } from "@mydon/shared";
import { DB, type Db } from "../db/db.module";
import { accountingSource } from "../sales/accounting-source";
import { ReportCache } from "../vending/report-cache";
import { failedStreak, STREAK_SCAN_LIMIT } from "../vending/sync-streak";
import { OurvendParityService } from "./ourvend-parity.service";
import {
  CUTOVER_GREEN_DAYS_FALLBACK,
  lastSnapshotAt,
  lastSuccessRunAt,
  snapshotStaleThreshold,
  snapshotStaleVerdict,
  syncStaleThreshold,
} from "./sync-runs";

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
    const [прогоны, слоты, продажи, витрина, паритет, серияПаритета, успех, порог, источник, порогСнапшота, снапшот] =
      await Promise.all([
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
        this.parity.parity(PARITY_DAYS, now),
        // Серия зелёных дней — рядом с сегодняшней сверкой, а не вместо неё
        // (R-P8b-2): `parity` отвечает «сходится ли СЕЙЧАС», серия — «сколько
        // дней подряд сходилось», и катовер открывает второе, а не первое.
        // Порог она приносит с собой, чтобы витрина сравнивала с тем же числом,
        // по которому будят владельца.
        // …И ПОД СВОИМ `catch`. Отчёт о здоровье — та самая витрина, которую
        // владелец открывает в дни катовера, и ронять её целиком из-за счёта
        // серии нельзя: `streak()` читает общую таблицу `event` и настройку
        // порога, то есть имеет свои поводы отказать. Тот же приём, что у
        // сигнала в `daily()`: отказ спутника не выдаёт себя за отказ главного.
        this.parity.streak(now).catch((e: unknown): ParityStreak => {
          this.logger.warn(
            `Серия зелёных дней паритета не посчиталась: ${e instanceof Error ? e.message : String(e)}`,
          );
          return { greenDays: 0, threshold: CUTOVER_GREEN_DAYS_FALLBACK, readyForCutover: false, days: [], lastRed: null, since: null };
        }),
        lastSuccessRunAt(this.db),
        // Порог застоя — В ОТВЕТЕ, а не только у сторожа: бот и панель рисуют
        // «⛔ сбор стоит» сравнением `staleHours >= staleThresholdH`, и своя
        // константа у каждого разошлась бы с базой в тот же день, когда владелец
        // подвинет порог в панели настроек (R-P8a-6). Считает его ОДНА функция
        // на двоих (`syncStaleThreshold`) — иначе витрина показывала бы порог,
        // по которому сторож не тревожит.
        syncStaleThreshold(this.db, this.logger),
        // Режим учёта и порог свежести снапшота — ради ОДНОГО поля `snapshotStale`
        // (R-P8b-5). Оба чтения дешёвые (`system_config` целиком, кеш источника —
        // минута) и идут в той же пачке, а не отдельным раундом: отчёт и так
        // держится на `Promise.all`, и последовательный `await` добавил бы
        // задержку ровно там, где владелец обновляет страницу.
        accountingSource(this.db, now),
        snapshotStaleThreshold(this.db, this.logger),
        // Свежесть — ПО ОБЕИМ половинам снапшота (R-FW-P2): продажи и остатки
        // приезжают тремя независимыми POST-ами, и вставшая половина
        // замораживает СВОЮ таблицу при свежих часах второй.
        lastSnapshotAt(this.db),
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
      //
      // ТОЧНОЕ ПРАВИЛО ОКРУГЛЕНИЯ (П8a fix wave; адверсариал прод-данные №7).
      // Это поле — округлённое до 0.1 ч число ДЛЯ ПОКАЗА, не для решения:
      // `SyncStaleService.check()` сравнивает с порогом СЫРЫЕ часы
      // (`rawStaleHours` в `sync-runs.ts`), а не это значение, — «5 ч 59 м
      // 49 с» иначе округлились бы до ровно 6.0 и прошли бы порог на 11
      // секунд раньше настоящей границы. Если когда-нибудь понадобится
      // сравнение прямо здесь (например, серверный бейдж «⛔ сбор стоит» без
      // похода к сторожу) — считать `staleHours >= staleThresholdH` НЕЛЬЗЯ:
      // это то же округлённое-раньше-времени сравнение, только скопированное.
      // Источник истины по границе — `rawStaleHours`, а не это поле.
      staleHours: staleHours(успехAt, now),
      staleThresholdH: порог,
      slotsLagMin: лаг(слоты[0]?.at, now, МИНУТА, 0),
      salesLagH: лаг(продажи[0]?.at, now, ЧАС, 1),
      // ВЕРДИКТ, а не второй порог рядом с лагом. Витрине иначе пришлось бы
      // сравнивать три вещи: лаг, порог и РЕЖИМ УЧЁТА — в режиме `stock` тот же
      // лаг не значит ничего (снапшот там теневой, продажи и остатки едут
      // зеркалом), и бот с панелью рисовали бы «⛔ учёт стоит» каждый день до
      // катовера. Считает ОДНА функция на троих (`snapshotIsStale`), и по СЫРЫМ
      // часам: `salesLagH` выше округлён до 0.1 ч и годится только для показа —
      // сравнивать с порогом округлённое значит двигать границу (см. длинный
      // комментарий у `staleHours` ниже).
      snapshotStale: источник === "own" && snapshotStaleVerdict(снапшот, now, порогСнапшота).stale,
      productSaleLagH: лаг(витрина[0]?.at, now, ЧАС, 1),
      // Гейт катовера ЧИСЛАМИ, а не флагом: владелец решает не «готово/не
      // готово», а «сколько ещё ждать», и «5 из 7» отвечает на этот вопрос.
      parityStreak: серияПаритета.greenDays,
      cutoverThreshold: серияПаритета.threshold,
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
        // С ЧЕМ сверялись — витрине словами: «расхождений 0» в режиме `retired`
        // означает «сверять не с чем», а не «всё сошлось».
        mode: паритет.mode,
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
