import { Inject, Injectable } from "@nestjs/common";
import { and, eq, gte, lt } from "drizzle-orm";
import { vendingPurchaseOrder, vendingRefill, vendingRefillEvent, vendingStock } from "@mydon/db";
import {
  isoWeekFromKey,
  isoWeekTashkent,
  previousIsoWeek,
  tashkentDay,
  tashkentDayStart,
  weekCompare,
  type DeadRow,
  type IsoWeek,
  type WeeklyDigest,
} from "@mydon/shared";
import { DB, type Db } from "../db/db.module";
import { OurvendHealthService } from "../ourvend/ourvend-health.service";
import { AnalyticsService } from "./analytics.service";
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

@Injectable()
export class WeeklyDigestService {
  private readonly кеш = new ReportCache();

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly analytics: AnalyticsService,
    private readonly health: OurvendHealthService,
  ) {}

  /**
   * Сводка недели. Пусто → ПРЕДЫДУЩАЯ ISO-неделя по Ташкенту: письмо уходит
   * утром понедельника и закрывает уже прожитую неделю, а не начатую.
   *
   * Негодный ключ (`2026-99`, мусор) не отбивается ошибкой, а падает в ту же
   * предыдущую неделю: сводка — чтение, и владельцу полезнее увидеть письмо,
   * чем 400 из бота.
   */
  async digest(week?: string, now = new Date()): Promise<WeeklyDigest> {
    const неделя = (week ? isoWeekFromKey(week) : null) ?? previousIsoWeek(isoWeekTashkent(now));
    return this.кеш.get(`weekly-digest|${неделя.key}|${tashkentDay(now)}`, now, () => this.сводка(неделя, now));
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
      this.health.health(undefined, now),
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
      health: здоровье,
    };
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
      for (const p of Array.isArray(н.positions) ? н.positions : []) {
        const поз = (p ?? {}) as { order?: unknown; price?: unknown };
        // `order` — сколько заказали и сколько зачисляет приёмка: та же
        // колонка, по которой считает себестоимость `AnalyticsService`.
        const qty = typeof поз.order === "number" && Number.isFinite(поз.order) ? Math.trunc(поз.order) : 0;
        if (qty <= 0) continue;
        units += qty;
        // Позиция без цены прибавляет ШТУКИ, но не деньги: ноль — это «цену не
        // вписали», а не «привезли даром» (R-P5b-2).
        const price = typeof поз.price === "number" && Number.isFinite(поз.price) && поз.price > 0 ? поз.price : 0;
        amount += price * qty;
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
