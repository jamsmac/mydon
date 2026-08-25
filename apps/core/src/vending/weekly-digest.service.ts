import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, eq, gte, lt } from "drizzle-orm";
import { vendingPurchaseOrder, vendingRefill, vendingRefillEvent, vendingStock } from "@mydon/db";
import {
  dayNumber,
  isoWeekFromKey,
  isoWeekTashkent,
  previousIsoWeek,
  tashkentDay,
  tashkentDayStart,
  weekCompare,
  type AnalyticsWarning,
  type DeadRow,
  type IsoWeek,
  type OurvendHealth,
  type WeeklyDigest,
} from "@mydon/shared";
import { DB, type Db } from "../db/db.module";
import { OurvendHealthService } from "../ourvend/ourvend-health.service";
import { SYNC_STALE_HOURS_FALLBACK } from "../ourvend/sync-stale.service";
import { AnalyticsService } from "./analytics.service";
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
  productSaleLagH: null,
  parity: { days: 0, ok: false, checked: 0, mismatches: 0, stockOk: false, stockChecked: 0, note: "здоровье сбора не посчиталось" },
};

@Injectable()
export class WeeklyDigestService {
  private readonly logger = new Logger(WeeklyDigestService.name);
  private readonly кеш = new ReportCache();

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly analytics: AnalyticsService,
    private readonly health: OurvendHealthService,
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

    const [текущая, предыдущая, мёртвый, цены, здоровье, работа] = await Promise.all([
      this.analytics.margin(WEEK_DAYS, конец),
      this.analytics.margin(WEEK_DAYS, начало),
      this.analytics.deadStock(undefined, now),
      this.analytics.priceChanges(PRICE_WINDOW_DAYS, конец),
      this.здоровьеСбора(now),
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
      // Предупреждения секций: сегодня единственное — недоступное здоровье
      // сбора. Числа денег в письме этим не портятся, и молчать о пропавшей
      // секции нельзя (иначе владелец прочитает «сбор в порядке» из пустоты).
      warnings: здоровье.warning ? [здоровье.warning] : [],
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
      const причина = e instanceof Error ? e.message : String(e);
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
