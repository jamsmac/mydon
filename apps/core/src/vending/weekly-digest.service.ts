import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, eq, gte, lt } from "drizzle-orm";
import { vendingPurchaseOrder, vendingRefill, vendingRefillEvent, vendingStock } from "@mydon/db";
import {
  dayNumber,
  isoWeekFromKey,
  isoWeekTashkent,
  parityDaysInWeek,
  PARITY_STREAK_WINDOW,
  previousIsoWeek,
  tashkentDay,
  tashkentDayStart,
  weekCompare,
  type AnalyticsWarning,
  type DeadRow,
  type IsoWeek,
  type OurvendHealth,
  type ParityDay,
  type WeeklyDigest,
  type WeeklyHealth,
} from "@mydon/shared";
import { DB, type Db } from "../db/db.module";
import { OurvendHealthService } from "../ourvend/ourvend-health.service";
import { OurvendParityService } from "../ourvend/ourvend-parity.service";
import {
  CUTOVER_GREEN_DAYS_FALLBACK,
  SYNC_STALE_HOURS_FALLBACK,
  WEEK_RUNS_LIMIT,
  lastSuccessRunAt,
  runsInWindow,
} from "../ourvend/sync-runs";
import { AnalyticsService } from "./analytics.service";
import { worstFailedStreak, type SyncRunFacts } from "./sync-streak";
import { parseOrderPositions } from "./vending.service";
import { ReportCache } from "./report-cache";

/**
 * Недельная сводка снек-контура (R-P5b-7): понедельничное письмо владельцу
 * одним JSON — деньги, работа за неделю, мёртвый сток, цены, здоровье сбора.
 * Текст собирает бот, панель показывает те же числа.
 *
 * ЧЕТЫРЕ РЕШЕНИЯ, КОТОРЫЕ НЕЛЬЗЯ «УПРОСТИТЬ».
 *
 * 1. НЕДЕЛЯ — ISO-неделя ПО ТАШКЕНТУ, а не «последние 7 дней». Сводка уходит в
 *    понедельник 08:05 и обязана закрывать пн–вс, а не окно «сегодня минус
 *    семь» (в нём был бы кусок текущей недели). Границы даёт общий
 *    `isoWeekTashkent`/`previousIsoWeek`, и ключ `IYYY-IW` совпадает с
 *    `to_char(dt,'IYYY-IW')` в Postgres байт-в-байт.
 *
 * 2. МАРЖА НЕДЕЛИ СЧИТАЕТСЯ ТЕМ ЖЕ `AnalyticsService.margin`, а не своим
 *    расчётом. Приём: окно отчёта — «`days` полных суток по вчерашний день от
 *    `now`», поэтому `margin(7, ПОНЕДЕЛЬНИК_СЛЕДУЮЩЕЙ_НЕДЕЛИ)` даёт РОВНО
 *    пн–вс нужной недели. Соблазн «просто взять продажи и посчитать здесь»
 *    кончился бы вторым индексом себестоимости и двумя разными цифрами маржи в
 *    одном письме: одна в сводке, другая в отчёте «маржа» (R-P5b-10). Тем же
 *    приёмом берётся ПРЕДЫДУЩАЯ неделя для дельты — вызовом с понедельником
 *    текущей.
 *
 * 3. МЁРТВЫЙ СТОК — ПО СЕГОДНЯШНЕМУ ОСТАТКУ, А НЕ ПО НЕДЕЛЬНОМУ. Истории
 *    остатков склада в базе нет (`vending_stock` — одна строка на товар), и
 *    «мёртвый сток за неделю» физически не восстановить. Отчёт отвечает на
 *    вопрос «что лежит мёртвым СЕЙЧАС» — он и полезен, и честен; окно движения
 *    берётся из настройки `DEAD_STOCK_DAYS`, как у отдельного отчёта.
 *
 * 4. ЦЕНЫ РЕЖУТСЯ ПО НЕДЕЛЕ УЖЕ ПОСЛЕ РАСЧЁТА. Лента закупочных цен в
 *    `AnalyticsService` намеренно БЕЗ верхней границы (свежее изменение —
 *    главная новость отчёта «цены»), а сводка обязана говорить только о своей
 *    неделе, иначе в понедельничном письме появилось бы сегодняшнее утро.
 *    И считается лента по ДВОЙНОМУ окну: переход цены виден только по паре
 *    соседних наблюдений, и переход в понедельник недели различим лишь тогда,
 *    когда видно предыдущее воскресенье.
 *
 * ПУСТАЯ НЕДЕЛЯ НЕ ВРЁТ НУЛЯМИ. Нет продаж — `machines` пуст, `totals.pct`
 * равен `null`, и бот печатает «считать нечего», а не «маржа 0 %»: чаще всего
 * это значит, что стоял сбор (см. `health` в том же ответе).
 */

/** Дней в ISO-неделе — окно всех недельных выборок. */
const WEEK_DAYS = 7;
/** Лучших товаров в письме — донорский топ-5. */
const TOP_PRODUCTS = 5;
/** Худших — трое: список длиннее читается как «всё плохо». */
const WORST_PRODUCTS = 3;
/** Мёртвого стока в письме — топ-5 по оценке; весь список даёт отдельный отчёт. */
const DEAD_ROWS = 5;
/**
 * Окно расчёта лент цен: неделя плюс предыдущая. Нужна ТОЛЬКО ради видимости
 * перехода на границе недели (см. решение 4); в ответ едут изменения самой
 * недели.
 */
const PRICE_WINDOW_DAYS = 2 * WEEK_DAYS;

const DAY_MS = 86_400_000;

/**
 * Насколько глубоко в прошлое пускаем `?week=` — два года.
 *
 * Ключ недели — единственный параметр отчётов, у которого пространство
 * значений НЕ ограничено формой (`^\d{4}-\d{2}$` даёт полмиллиона годных
 * недель против 90–180 значений у соседних `?days=`). Каждый новый ключ — это
 * гарантированный промах кеша и четыре тяжёлых расчёта под ним, то есть
 * готовый способ уложить Core одним циклом `curl` мимо пятиминутного кеша, на
 * который и рассчитан троттл. Продаж старше двух лет в базе нет, поэтому
 * ограничение ничего не отнимает у владельца.
 */
export const WEEK_HISTORY_LIMIT = 104;

/**
 * Здоровье сбора, которого посчитать не вышло.
 *
 * НЕ «всё хорошо» и не ноль: прогонов нет, серии нет, лаги `null` («снимков
 * нет»), паритет за ноль суток. Витрины уже умеют читать эту форму как «оценить
 * нечем», а сводка отдельно говорит об этом словами в `warnings`.
 */
const ЗДОРОВЬЕ_НЕИЗВЕСТНО: OurvendHealth = {
  runs: [],
  failedStreak: 0,
  lastSuccessAt: null,
  // «Успехов не было вовсе», а не «ноль часов»: секция не посчиталась, и
  // выдать здесь ноль значило бы сказать «собрали только что».
  staleHours: null,
  staleThresholdH: SYNC_STALE_HOURS_FALLBACK,
  slotsLagMin: null,
  salesLagH: null,
  // «Не посчитали» — это НЕ «учёт встал». Секция здоровья упала (например, на
  // сыром SQL паритета), и выдать здесь `true` значило бы разбудить владельца
  // тревогой о снапшоте, которого никто не спрашивал.
  snapshotStale: false,
  productSaleLagH: null,
  // «Не посчиталось» — это НЕ «готовы к переключению»: серия ноль, а порог —
  // настоящий фолбэк, чтобы витрина не нарисовала «0 из 0 — можно».
  parityStreak: 0,
  cutoverThreshold: CUTOVER_GREEN_DAYS_FALLBACK,
  // `mode` — самое НЕ ЗАЯВЛЯЮЩЕЕ из трёх: `retired` витрина читает как
  // «сверка завершена, зеркала нет», а это утверждение о катовере, которого мы
  // тут не знаем. Причина отсутствия чисел сказана в `note`, а не режимом.
  parity: {
    days: 0,
    ok: false,
    checked: 0,
    mismatches: 0,
    stockOk: false,
    stockChecked: 0,
    mode: "mirror",
    note: "здоровье сбора не посчиталось",
  },
};

/**
 * Пара к `ЗДОРОВЬЕ_НЕИЗВЕСТНО`: «не посчитали» ≠ «всё хорошо».
 *
 * Нули здесь читаются вместе с `warnings`: подпись недели остаётся (числа без
 * недели не значат ничего), прогонов ноль, `lastSuccessAt` — `null` («успехов
 * не было ВОВСЕ», а не «ноль часов назад»), дней паритета нет. Причина едет
 * словами в `warnings`, как и у соседа.
 */
const НЕДЕЛЯ_НЕИЗВЕСТНА = (week: string, partialWeek: boolean): WeeklyHealth => ({
  week,
  runs: 0,
  success: 0,
  partial: 0,
  failed: 0,
  running: 0,
  worstFailedStreak: 0,
  lastDataAt: null,
  parityDays: [],
  parityGreen: 0,
  parityRed: 0,
  // Считается арифметикой, а не базой, поэтому остаётся правдой и тогда, когда
  // не посчиталось ВСЁ остальное: «неделя ещё идёт» знать от Postgres не надо.
  partialWeek,
  // Потолок чтения не срабатывал — читать не вышло вовсе. `true` здесь
  // утверждало бы про журнал то, чего мы не видели.
  capped: false,
});

/**
 * Текст предупреждения о неделе, до которой окно счёта серии не достаёт.
 *
 * Молчаливый пустой список читался бы как «сверки не было» — ровно тот ноль,
 * который выдают за результат. Здесь причина названа и сказано, где смотреть.
 */
/**
 * Причина отказа человеческим текстом — одна формулировка на три `catch` файла.
 */
const причинаОтказа = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const ПАРИТЕТ_ВНЕ_ОКНА =
  `Дни паритета за эту неделю вне окна счёта серии (${PARITY_STREAK_WINDOW} дней) — ` +
  "смотри /ourvend/parity/streak";

/**
 * Потолок чтения журнала прогонов сработал — числа посчитаны по свежему хвосту.
 *
 * Молчаливое обрезание здесь читается как посчитанный результат: «отказов 3»
 * за неделю с зациклившимся кроном увело бы владельца от аварии.
 */
const ПРОГОНЫ_ОБРЕЗАНЫ =
  `Прогонов за неделю больше потолка чтения (${WEEK_RUNS_LIMIT}) — числа блока посчитаны ` +
  "по самым свежим прогонам окна, весь журнал в /ourvend/health.";

@Injectable()
export class WeeklyDigestService {
  private readonly logger = new Logger(WeeklyDigestService.name);
  private readonly кеш = new ReportCache();

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly analytics: AnalyticsService,
    private readonly health: OurvendHealthService,
    private readonly parity: OurvendParityService,
  ) {
    // Сводка считает ТЕ ЖЕ числа, что отчёты аналитики, и обязана гаснуть
    // вместе с ними: иначе правка цены обновляла бы `/vending/margin`, а
    // `/vending/weekly-digest` до пяти минут отдавал бы прежние — два ответа
    // Core на один вопрос (R-P5b-10).
    this.analytics.attachCache(this.кеш);
  }

  /**
   * Сводка недели. Пусто → ПРЕДЫДУЩАЯ ISO-неделя по Ташкенту: письмо уходит
   * утром понедельника и закрывает уже прожитую неделю, а не начатую.
   *
   * Негодный ключ (`2026-99`, мусор) не отбивается ошибкой, а падает в ту же
   * предыдущую неделю: сводка — чтение, и владельцу полезнее увидеть письмо,
   * чем 400 из бота. ТОЧНО ТАК ЖЕ гасится неделя ВНЕ ДИАПАЗОНА — из будущего,
   * текущая (она ещё не прожита) и старше `WEEK_HISTORY_LIMIT`: см. границу.
   */
  async digest(week?: string, now = new Date()): Promise<WeeklyDigest> {
    const неделя = нормализоватьНеделю(week, now);
    return this.кеш.get(`weekly-digest|${неделя.key}|${tashkentDay(now)}`, () => this.сводка(неделя, now));
  }

  private async сводка(неделя: IsoWeek, now: Date): Promise<WeeklyDigest> {
    const прошлая = previousIsoWeek(неделя);
    // Начало понедельника недели и понедельника СЛЕДУЮЩЕЙ: две точки, из
    // которых получаются все окна. `tashkentDayStart` не может вернуть null —
    // `from` приходит из `isoWeek*` уже голой датой; `!` тут честнее, чем
    // выдуманный запасной момент.
    const начало = tashkentDayStart(неделя.from)!;
    const конец = new Date(tashkentDayStart(неделя.to)!.getTime() + DAY_MS);

    const [текущая, предыдущая, мёртвый, цены, здоровье, недельное, работа] = await Promise.all([
      this.analytics.margin(WEEK_DAYS, конец),
      this.analytics.margin(WEEK_DAYS, начало),
      this.analytics.deadStock(undefined, now),
      this.analytics.priceChanges(PRICE_WINDOW_DAYS, конец),
      this.здоровьеСбора(now),
      this.здоровьеНедели(неделя, начало, конец, now),
      this.работаЗаНеделю(начало, конец),
    ]);

    const продукты = текущая.products;
    // Худшие берутся с ХВОСТА того же списка (он отсортирован по марже вниз) и
    // НЕ пересекаются с топом: товар в обоих списках сразу владелец прочитал
    // бы как ошибку отчёта. Мало товаров — худших просто нет.
    const хвост = продукты.slice(Math.max(TOP_PRODUCTS, продукты.length - WORST_PRODUCTS));

    return {
      week: неделя.key,
      from: неделя.from,
      to: неделя.to,
      previousWeek: прошлая.key,
      machines: текущая.machines.map((m) => ({
        serial: m.serial,
        name: m.name,
        qty: m.qty,
        revenue: m.revenue,
        margin: m.margin,
        pct: m.pct,
      })),
      totals: текущая.totals,
      delta: weekCompare(текущая.totals, предыдущая.totals),
      topProducts: продукты.slice(0, TOP_PRODUCTS),
      worstProducts: [...хвост].reverse(),
      refills: работа.refills,
      intake: работа.intake,
      stocktakes: работа.stocktakes,
      deadStock: { rows: топМёртвых(мёртвый.warehouse, мёртвый.machines), totalValue: мёртвый.totalValue },
      priceChanges: {
        purchase: цены.purchase.filter((c) => вНеделе(c.at, неделя)),
        retail: цены.retail.filter((c) => вНеделе(c.at, неделя)),
      },
      health: здоровье.health,
      weekHealth: недельное.health,
      // Предупреждения ОБЕИХ секций здоровья: они падают независимо, и
      // потерянная вторая читалась бы как «там всё хорошо». Числа денег в
      // письме этим не портятся, и молчать о пропавшей секции нельзя.
      warnings: [...(здоровье.warning ? [здоровье.warning] : []), ...недельное.warnings],
    };
  }

  /**
   * Здоровье сбора, которое не может уронить письмо.
   *
   * Раньше `health` стоял в общем `Promise.all` без `catch`: любой отказ его
   * запросов (внутри — сырой SQL паритета) отдавал 500 на ВСЮ сводку, и
   * понедельничное письмо не уходило вовсе. Деньги недели при этом посчитаны
   * и ни от чего в этой секции не зависят — терять их из-за неё нечестно.
   * Секция деградирует до «оценить нечем», причина едет в `warnings` и в лог.
   */
  private async здоровьеСбора(now: Date): Promise<{ health: OurvendHealth; warning: AnalyticsWarning | null }> {
    try {
      return { health: await this.health.health(undefined, now), warning: null };
    } catch (e) {
      const причина = причинаОтказа(e);
      this.logger.error(`Здоровье сбора для недельной сводки не посчиталось: ${причина}`);
      return {
        health: ЗДОРОВЬЕ_НЕИЗВЕСТНО,
        warning: {
          code: "health_unavailable",
          message: `Здоровье сбора не посчиталось (${причина}) — деньги недели в письме честные, а про сбор смотри /ourvend/health.`,
        },
      };
    }
  }

  /**
   * Здоровье сбора ЗА ОТЧЁТНУЮ НЕДЕЛЮ (R-H-9) — спутник `здоровьеСбора`, а не
   * его замена.
   *
   * Дефект O7: письмо подписано неделей, а блок здоровья брал числа моментом
   * отправки. Авария понедельничного утра попадала в письмо о ПРОШЛОЙ неделе,
   * и владелец искал её в логах не того дня; неделя, на которой сбор стоял
   * двое суток, выглядела чистой, если к утру он ожил. Оба набора чисел теперь
   * едут рядом, каждый под своей подписью.
   *
   * Окно — те же `начало`/`конец`, что уже вычислила `сводка()`: второй
   * арифметики недели здесь нет, иначе границы разошлись бы на первом же
   * уточнении, и деньги считались бы за одну неделю, а прогоны — за другую.
   *
   * КАЖДЫЙ ИСТОЧНИК ПОД СВОИМ `catch`, а не все трое под общим. Прогоны — два
   * простых индексных запроса, дни паритета — скан общей `event` с разбором
   * jsonb: падает практически только он. Под общим `catch` его отказ обнулял
   * бы и прогоны, и письмо печатало бы «за неделю прогонов не было — сбор не
   * запускался» о неделе, в которой сбор отработал 56 раз. Это тот же дефект,
   * против которого заведена задача, только с другой стороны: «не посчитали»
   * превращается не в «всё хорошо», а в утверждение о несуществующем факте, и
   * владелец идёт чинить крон, который работал. Тем же приёмом гасит паритет и
   * `OurvendHealthService`.
   *
   * Внешний `try` остаётся страховкой на отказ САМОЙ БАЗЫ — при нём письма всё
   * равно не будет (`analytics.margin` ходит туда же).
   */
  private async здоровьеНедели(
    неделя: IsoWeek,
    начало: Date,
    конец: Date,
    now: Date,
  ): Promise<{ health: WeeklyHealth; warnings: AnalyticsWarning[] }> {
    // Считается арифметикой, а не базой: правда и при полном отказе чтения.
    const partialWeek = конец.getTime() > now.getTime();
    try {
      const окно = { from: начало, to: конец };
      const [прочитано, данные, паритет] = await Promise.all([
        // На ОДИН прогон больше потолка: иначе «ровно 200» и «больше 200»
        // неразличимы, и обрезанный счёт уехал бы в письмо как посчитанный.
        runsInWindow(this.db, окно, WEEK_RUNS_LIMIT + 1),
        lastSuccessRunAt(this.db, окно),
        this.дниПаритета(неделя, now),
      ]);

      const capped = прочитано.length > WEEK_RUNS_LIMIT;
      const прогоны = capped ? прочитано.slice(0, WEEK_RUNS_LIMIT) : прочитано;
      const сколько = (status: SyncRunFacts["status"]): number =>
        прогоны.filter((r) => r.status === status).length;
      const success = сколько("success");
      const partial = сколько("partial");
      const failed = сколько("failed");
      const running = сколько("running");
      const дни = "days" in паритет ? паритет.days : [];

      const warnings: AnalyticsWarning[] = [];
      if ("failure" in паритет) {
        warnings.push({
          code: "health_unavailable",
          message:
            `Дни паритета за неделю ${неделя.key} не посчитались (${паритет.failure}) — ` +
            "прогоны сбора в письме настоящие, а сверку смотри в /ourvend/parity/streak.",
        });
      } else if (дни.length === 0 && внеОкнаСерии(неделя, now)) {
        // Пусто ПОТОМУ ЧТО не достали, а не потому что сверки не было — это
        // два разных ответа, и различает их только окно показа серии.
        warnings.push({ code: "health_unavailable", message: ПАРИТЕТ_ВНЕ_ОКНА });
      }
      if (capped) warnings.push({ code: "history_capped", message: ПРОГОНЫ_ОБРЕЗАНЫ });

      return {
        health: {
          week: неделя.key,
          // СУММОЙ разрядов, а не длиной выборки: строка письма печатает и
          // итог, и разряды, и «прогонов 57 · успешных 54 · частичных 1 ·
          // отказов 1» владелец прочитал бы как ошибку отчёта.
          runs: success + partial + failed + running,
          success,
          partial,
          failed,
          running,
          worstFailedStreak: worstFailedStreak(прогоны),
          lastDataAt: данные ? данные.toISOString() : null,
          parityDays: дни,
          parityGreen: дни.filter((d) => d.ok).length,
          parityRed: дни.filter((d) => !d.ok).length,
          partialWeek,
          capped,
        },
        warnings,
      };
    } catch (e) {
      const причина = причинаОтказа(e);
      this.logger.error(`Здоровье сбора за неделю ${неделя.key} не посчиталось: ${причина}`);
      return {
        health: НЕДЕЛЯ_НЕИЗВЕСТНА(неделя.key, partialWeek),
        warnings: [
          {
            code: "health_unavailable",
            message:
              `Здоровье сбора за неделю ${неделя.key} не посчиталось (${причина}) — ` +
              "деньги недели в письме честные, а про сбор смотри /ourvend/health.",
          },
        ],
      };
    }
  }

  /**
   * Дни паритета недели ПОД СВОИМ `catch` (ревью T8, M1).
   *
   * Отдельным методом, а не `.catch()` инлайном в `Promise.all`: причина
   * отказа нужна в тексте предупреждения, а мутируемая переменная, которую
   * пишет колбэк, для компилятора остаётся `null` навсегда. Успех и отказ
   * различаются формой ответа, а не значением `null`: «дней нет» и «дни не
   * посчитались» — два разных ответа, и письмо говорит о них разное.
   *
   * Второго разбора payload не заводим: поля дня уже разобрал
   * `parity-streak.ts`, и своя копия правила «что такое зелёный день»
   * разошлась бы с гейтом катовера.
   */
  private async дниПаритета(
    неделя: IsoWeek,
    now: Date,
  ): Promise<{ days: ParityDay[] } | { failure: string }> {
    try {
      const серия = await this.parity.streak(now);
      return { days: parityDaysInWeek(серия.days, неделя.from, неделя.to) };
    } catch (e) {
      const причина = причинаОтказа(e);
      this.logger.error(`Дни паритета недели ${неделя.key} не посчитались: ${причина}`);
      return { failure: причина };
    }
  }

  /**
   * Работа за неделю четырьмя короткими выборками: события заливок, записи
   * мастера, принятые накладные, инвентаризации склада. Суммы считаются в
   * памяти, а не в SQL: строк за неделю десятки, а `sum(...) group by` в сыром
   * виде юнит-тест не исполняет — и ошибка в границе суток прошла бы зелёной.
   *
   * Окно у всех четырёх одно и полуинтервальное — `[понедельник, следующий
   * понедельник)`: `lte` по концу воскресенья втянул бы полночь понедельника в
   * обе соседние недели, и одна и та же заливка посчиталась бы дважды.
   */
  private async работаЗаНеделю(начало: Date, конец: Date) {
    const [события, записи, накладные, инвентаризации] = await Promise.all([
      this.db
        .select({ units: vendingRefillEvent.units })
        .from(vendingRefillEvent)
        .where(and(gte(vendingRefillEvent.windowTo, начало), lt(vendingRefillEvent.windowTo, конец))),
      this.db
        .select({ qty: vendingRefill.qty })
        .from(vendingRefill)
        .where(and(gte(vendingRefill.performedAt, начало), lt(vendingRefill.performedAt, конец))),
      this.db
        .select({ positions: vendingPurchaseOrder.positions })
        .from(vendingPurchaseOrder)
        .where(
          and(
            eq(vendingPurchaseOrder.status, "received"),
            gte(vendingPurchaseOrder.receivedAt, начало),
            lt(vendingPurchaseOrder.receivedAt, конец),
          ),
        ),
      this.db
        .select({ countedAt: vendingStock.countedAt })
        .from(vendingStock)
        .where(and(gte(vendingStock.countedAt, начало), lt(vendingStock.countedAt, конец))),
    ]);

    let units = 0;
    let amount = 0;
    for (const н of накладные) {
      // Разбор — общий `parseOrderPositions`: свой давал ДРУГОЙ гейт цены
      // (любое число > 0 против потолка в 10 млн у аналитики), и мусорная
      // позиция попадала в деньги письма, но не в себестоимость отчёта.
      for (const поз of parseOrderPositions(н.positions)) {
        units += поз.qty;
        // Позиция без цены прибавляет ШТУКИ, но не деньги: ноль — это «цену не
        // вписали», а не «привезли даром» (R-P5b-2).
        amount += (поз.price ?? 0) * поз.qty;
      }
    }

    const моменты = инвентаризации
      .map((r) => r.countedAt)
      .filter((d): d is Date => d instanceof Date)
      .sort((a, b) => b.getTime() - a.getTime());

    return {
      refills: {
        events: события.length,
        detectedUnits: события.reduce((s, r) => s + число(r.units), 0),
        recordedUnits: записи.reduce((s, r) => s + число(r.qty), 0),
      },
      intake: { orders: накладные.length, units, amount: Math.round(amount) || 0 },
      stocktakes: {
        positions: инвентаризации.length,
        lastCountedAt: моменты[0] ? моменты[0].toISOString() : null,
      },
    };
  }
}

const число = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : Number(v) || 0);

/**
 * Ключ недели в рабочих границах: `[предыдущая − WEEK_HISTORY_LIMIT;
 * предыдущая]`. Всё, что вне, — В ПРЕДЫДУЩУЮ, ровно как негодный ключ.
 *
 * Отбивать 400 нельзя по той же причине, по которой не отбивается `2026-99`:
 * сводка — чтение, и владельцу, промахнувшемуся в цифре, полезнее письмо. Но
 * и пускать любой ключ дальше нельзя: каждый уникальный ключ — это промах
 * кеша и четыре тяжёлых расчёта под ним (см. `WEEK_HISTORY_LIMIT`).
 */
function нормализоватьНеделю(week: string | undefined, now: Date): IsoWeek {
  const предыдущая = previousIsoWeek(isoWeekTashkent(now));
  const запрошенная = week ? isoWeekFromKey(week) : null;
  if (!запрошенная) return предыдущая;
  // Сравниваем ПОНЕДЕЛЬНИКАМИ, а не ключами: `2027-01` строкой меньше
  // `2026-52`, и лексикографическое сравнение пустило бы будущую неделю.
  const глубина = (dayNumber(предыдущая.from) - dayNumber(запрошенная.from)) / 7;
  if (глубина < 0 || глубина > WEEK_HISTORY_LIMIT) return предыдущая;
  return запрошенная;
}

/**
 * Неделя лежит ГЛУБЖЕ окна показа серии паритета (`PARITY_STREAK_WINDOW`).
 *
 * Считается КАЛЕНДАРЁМ, а не по содержимому `days`: список обрезан четырнадцатью
 * сутками С СОБЫТИЕМ, и судить по нему «достали или нет» значило бы объявлять
 * вне окна каждую неделю, в которую сверка просто молчала. Понедельничное
 * письмо (прошлая неделя) всегда внутри; `?week=` глубже двух недель — нет.
 *
 * Граница — голые ташкентские сутки, тем же `tashkentDayStart`, что и всё
 * остальное в файле: вторая арифметика суток здесь дала бы второе правило о
 * том, где кончается день.
 *
 * ЧАСТИЧНОЕ ПОКРЫТИЕ СОЗНАТЕЛЬНО НЕ СИГНАЛИТСЯ. Сравнивается ВОСКРЕСЕНЬЕ
 * недели, поэтому неделя, у которой в окно попали, скажем, пять суток из
 * семи, отдаёт свои пять дней молча. Критерий двоичный намеренно: у окна
 * показа нет обещания «ровно N суток» (в нём четырнадцать дней С СОБЫТИЕМ, а
 * не календарных), и предупреждать о недоборе, границу которого мы сами не
 * знаем, значило бы пугать неточностью там, где числа честные. Для
 * понедельничного письма — единственного, которое приходит само, — случай
 * недостижим: прошлая неделя целиком внутри окна.
 */
function внеОкнаСерии(неделя: IsoWeek, now: Date): boolean {
  const начало = tashkentDayStart(tashkentDay(now));
  if (!начало) return false;
  const самыйСтарый = tashkentDay(new Date(начало.getTime() - (PARITY_STREAK_WINDOW - 1) * DAY_MS));
  // Сравнивается ВОСКРЕСЕНЬЕ недели: неделя, у которой не достаёт даже конца,
  // не достаётся вовсе.
  return неделя.to < самыйСтарый;
}

/** Дата изменения цены попала в неделю. Обе стороны — голые ташкентские сутки. */
const вНеделе = (at: string, w: IsoWeek): boolean => at.slice(0, 10) >= w.from && at.slice(0, 10) <= w.to;

/**
 * Топ мёртвого стока по ОБЕИМ половинам сразу: склад и автоматы в одном
 * списке, дороже — выше. Каждая половина отсортирована сама по себе, и взять
 * «первые пять» из склеенных списков без пересортировки значило бы показать
 * дешёвую складскую строку выше дорогой автоматной.
 */
function топМёртвых(warehouse: readonly DeadRow[], inMachines: readonly DeadRow[]): DeadRow[] {
  const текст = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  return [...warehouse, ...inMachines]
    .sort((a, b) => b.value - a.value || текст(a.product, b.product) || текст(a.serial ?? "", b.serial ?? ""))
    .slice(0, DEAD_ROWS);
}
