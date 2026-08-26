import { Inject, Injectable, Logger, type OnApplicationShutdown, type OnModuleInit } from "@nestjs/common";
import { Cron } from "croner";
import { and, eq, gte, inArray, lte } from "drizzle-orm";
import { event, sale, slotSnapshot, vendingRefill, vendingRefillEvent } from "@mydon/db";
import {
  hasProduct,
  normalizeMachineSerial,
  normalizeProductName,
  shrinkageByDay,
  slotValid,
  tashkentDay,
  tashkentDayStart,
  tashkentDayStartOf,
  TZ,
  type MachineSnapshot,
  type ShrinkDayInput,
  type ShrinkMachine,
  type ShrinkRefillDay,
  type ShrinkReport,
  type ShrinkWarning,
  type ShrinkWarningCode,
  type Slot,
} from "@mydon/shared";
import { DB, type Db } from "../db/db.module";
import { readIntSetting } from "../system/settings";
import { skipReasonOf, type SkipReason } from "./refill-events.service";
import { ReportCache, clamp, listInline } from "./report-cache";
import { VendingService } from "./vending.service";

/** Дни отчёта по умолчанию — окно, на котором порог 30 000 сум уже бьёт (донор mydon-stock). */
export const SHRINK_DAYS_DEFAULT = 14;
/**
 * Потолок окна: снимки читаются по автомату, но 60 суток парка — это уже
 * полмиллиона строк за прогон. Глубже — разовый разбор выгрузкой, не отчётом.
 */
export const SHRINK_DAYS_MAX = 60;
/** Порог алерта, если настройки нет (донор mydon-stock, `SHRINK_ALERT_UZS`). */
export const SHRINK_ALERT_FALLBACK = 30_000;
/** Окно суточного алерта: неделя — столько владелец держит в голове. */
export const ALERT_DAYS = 7;
/**
 * Насколько далеко от границы суток может стоять снимок, чтобы считаться
 * «границей дня». Снимки идут раз в 3 ч, поэтому 6 ч — это пропущенный сбор,
 * а не смещение расписания: считать по нему значит приписать автомату чужие
 * продажи соседних суток.
 */
export const SNAPSHOT_STALE_MS = 6 * 3_600_000;
/** «Заканчивается»: столько штук осталось по товару. */
export const LOW_STOCK_LEFT = 1;
/**
 * Ниже этой суммарной ёмкости «остался один» — не новость: одинокая пружина
 * на 4 позиции пустеет каждый день и превратила бы брифинг в шум.
 */
export const LOW_STOCK_MIN_CAPACITY = 5;
/**
 * Свежесть планограммы для алерта «заканчивается». `machine_slot` — таблица
 * upsert-зеркала: строки автомата, переставшего отдавать данные, лежат в ней
 * вечно (уборка `pruneVanishedSlots` трогает только машины текущей пачки).
 * Без этой отсечки такой автомат каждое утро давал бы по событию на КАЖДЫЙ
 * товар планограммы — вечный «заканчивается» по аппарату, которого нет.
 */
export const LOW_STOCK_FRESH_MS = 24 * 3_600_000;
/**
 * Потолок событий за ОДИН прогон алертов — усушка и «заканчивается» вместе.
 * Брифинг из полутора сотен строк читать не будет никто, а именно столько даёт
 * парк, у которого разом опустела планограмма. Раньше потолок стоял только на
 * «заканчивается», и поток `vending.shrinkage_alert` (машины × позиции) мог
 * вытеснить из выборки правил деньги, договоры и кофе — выдавленное не
 * показывается и не ack-ается, то есть теряется, а не откладывается.
 * Обрезка громкая (warn в лог), а не молчаливая.
 */
export const ALERT_MAX_EVENTS = 50;
/**
 * Окно повтора «заканчивается»: пока остаток по (автомат, товар) не изменился,
 * событие не повторяется трое суток. Суточного дедупа мало — пустая позиция
 * держится пустой неделями, и владелец получал бы ту же строку каждое утро,
 * пока не перестал бы читать брифинг целиком. Изменился `left` — это новость,
 * и она проходит сразу.
 */
export const LOW_STOCK_REPEAT_MS = 3 * 86_400_000;

export const SHRINK_EVENT = "vending.shrinkage_alert";
export const LOW_STOCK_EVENT = "machine.low_stock";

const DAY_MS = 86_400_000;

/**
 * Формы отчёта — из `@mydon/shared` (`vending-reports.ts`, R-H-6).
 *
 * Форму объявляет тот, кто считает числа; Core её импортирует и отдаёт своим
 * модулям отсюда же, откуда они её брали (контроллер, недельная сводка,
 * брифинг) — иначе переезд формы стал бы правкой каждого импортёра.
 */
export type { ShrinkMachine, ShrinkRefillDay, ShrinkReport, ShrinkWarning, ShrinkWarningCode };

/** Итог суточного прогона алертов. */
export interface AlertRun {
  /** Записано событий всего. */
  alerts: number;
  /** Из них «заканчивается товар». */
  lowStock: number;
}

/**
 * Ключ сшивки товара — и заодно запись «как его показывать».
 *
 * Ключ нормализованный, потому что снимок присылает «Snickers», продажи —
 * «SNICKERS», а алиаса на такую пару нет. Отображаемое имя первым занимает
 * прайс (его правит владелец), дальше — первое встреченное написание из
 * планограммы или снимка: показать владельцу «red bull» вместо «Red Bull»
 * значит выдать ему служебный ключ вместо названия товара.
 */
function ключТовара(ctx: ShrinkContext, raw: string): string {
  const имя = ctx.canonOf(raw);
  const ключ = normalizeProductName(имя);
  if (!ctx.display.has(ключ)) ctx.display.set(ключ, имя);
  return ключ;
}

/**
 * Человеческая причина молчания источника по автомату. `not_in_service` сюда
 * не доходит: автоматы не в строю отсеиваются реестром ДО расчёта (о них
 * говорит план закупа), но в союзе `SkipReason` он есть — и полнота записи
 * важнее, чем экономия одной строки.
 */
const ПРИЧИНА: Record<SkipReason, string> = {
  dead: "источник отдаёт ёмкости вне диапазона (заглушка)",
  uncalibrated: "ёмкости слотов не откалиброваны",
  no_slots: "в автомате нет назначенных слотов",
  not_in_service: "автомат не в строю",
};

/**
 * Общий справочник прогона: канон имён, цены и реестр автоматов. Читается ОДИН
 * раз и передаётся отчёту — утренний прогон считает отчёт и тут же эмиттер
 * остатка, и второй поход за теми же картами это не только лишние запросы, но
 * и риск получить два разных ответа в пределах одного прогона.
 */
interface ShrinkContext {
  canonOf: (raw: string) => string;
  /** Цена по НОРМАЛИЗОВАННОМУ ключу имени. */
  priceByKey: Map<string, number>;
  /** Нормализованный ключ → как показывать товар владельцу. */
  display: Map<string, string>;
  registry: { notInService: Map<string, { name: string; status: string }>; nameBySerial: Map<string, string> };
}

/**
 * Усушка автомата по дням (П4, R-P4-3).
 *
 * ЗАЧЕМ. Между «сколько стояло», «сколько продано» и «сколько осталось» на
 * снеке регулярно не сходится, и до этого среза расхождение не видел никто:
 * ручной инвентаризации автомата нет и не будет (снимок раз в 3 ч точнее
 * пересчёта руками), а продажи и остатки лежали в разных отчётах.
 *
 * ПОЧЕМУ ПО ДНЯМ БЕЗ ЗАЛИВОК. В сутки заливки приход и продажи гасятся внутри
 * одного 3-часового окна, и сходимость искажается — на живых данных дни без
 * заливки сходятся ровно в ноль, а дни заливки «шумят» десятками штук.
 * Поэтому день с приходом выкидывается ЦЕЛИКОМ (не по позиции), а владельцу
 * показывается отдельной строкой: «приход N ед по снимку, записано M».
 *
 * ПОЧЕМУ ТОВАР СШИВАЕТСЯ ПО НОРМАЛИЗОВАННОМУ КЛЮЧУ. Снимок присылает
 * «Snickers», продажи — «SNICKERS», а алиаса на такую пару нет: канон
 * возвращает оба имени как есть, и точное сравнение строк дало бы «продаж 0»
 * → вся дневная выручка легла бы в недостачу, молча и с алертом.
 *
 * ЧЕГО СЕРВИС НЕ ДЕЛАЕТ: не правит остатки и не списывает склад. Усушка —
 * наблюдение, а не проводка; списывать по ней значит закрепить догадку.
 */
@Injectable()
export class ShrinkageService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(ShrinkageService.name);
  private cron: Cron | null = null;
  /** Готовый отчёт по ключу окна плюс single-flight — общий `ReportCache`. */
  private readonly кеш = new ReportCache();

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly vending: VendingService,
  ) {}

  /**
   * 08:35 по Ташкенту — после утреннего сбора слотов и синка продаж, но до
   * брифинга: событие должно успеть попасть в утреннюю сводку владельца.
   */
  onModuleInit(): void {
    this.cron = new Cron("35 8 * * *", { timezone: TZ }, () => {
      void this.alertDaily().catch((e: unknown) =>
        this.logger.warn(`Алерты усушки не посчитались: ${e instanceof Error ? e.message : String(e)}`),
      );
    });
  }

  onApplicationShutdown(): void {
    this.cron?.stop();
    this.cron = null;
  }

  /**
   * Отчёт об усушке за `days` полных суток по Ташкенту.
   *
   * Период кончается ВЧЕРА: у сегодняшних суток нет снимка на 24:00, и
   * включать их значило бы каждый день показывать «недостачу», которая на
   * самом деле ещё не проданный товар.
   *
   * `now` — параметр, а не `Date.now()` внутри: прогон, пересекающий полночь
   * Ташкента, иначе считал бы первую половину по одному периоду, а вторую по
   * другому, и тесты флакали бы ровно в этот момент.
   *
   * КЕШ И ОДИН РАСЧЁТ НА КЛЮЧ — общий `ReportCache` (тот же, что у аналитики и
   * недельной сводки). Роут открыт на чтение, а расчёт тяжёлый (все продажи
   * периода в память плюс запрос снимков на каждый автомат). Ключ — окно И
   * ташкентские сутки: после полуночи период сдвигается, и вчерашний отчёт под
   * тем же `days` был бы уже не тем отчётом.
   */
  async report(days = SHRINK_DAYS_DEFAULT, now = new Date()): Promise<ShrinkReport> {
    const окно = clamp(days, SHRINK_DAYS_DEFAULT, SHRINK_DAYS_MAX);
    return this.кеш.get(`${окно}|${tashkentDay(now)}`, async () => this.построить(окно, now, await this.контекст()));
  }

  /**
   * Сбросить кеш отчёта. Зовётся оттуда, где данные заведомо поменялись:
   * ручной прогон алертов и крон считают отчёт заново и пишут события — отдать
   * после этого закешированный отчёт значило бы показать владельцу картину, по
   * которой алерты уже не сходятся.
   */
  invalidate(): void {
    this.кеш.clear();
  }

  /** Справочники прогона — одной загрузкой (см. `ShrinkContext`). */
  private async контекст(): Promise<ShrinkContext> {
    const [{ canonOf, priceByName, names }, registry] = await Promise.all([
      this.vending.priceIndex(),
      this.vending.machineRegistry(),
    ]);
    const priceByKey = new Map<string, number>();
    for (const [name, price] of priceByName) priceByKey.set(normalizeProductName(name), price);
    // Отображаемое имя занимает ПРАЙС: его владелец правит руками, и именно
    // это написание он ждёт увидеть в отчёте. Имена из снимков подставляются
    // ниже, только если товара в прайсе нет вовсе.
    const display = new Map<string, string>();
    for (const name of names) display.set(normalizeProductName(name), name);
    return { canonOf, priceByKey, display, registry };
  }

  private async построить(days: number, now: Date, ctx: ShrinkContext): Promise<ShrinkReport> {
    const dates = периодДней(clamp(days, SHRINK_DAYS_DEFAULT, SHRINK_DAYS_MAX), now);
    const from = dates[0]!;
    const to = dates[dates.length - 1]!;
    // Снимки читаем с запасом на допуск: снимок «начала суток» законно стоит
    // за несколько часов ДО полуночи.
    const since = new Date(началоСуток(from) - SNAPSHOT_STALE_MS);
    const периодОт = new Date(началоСуток(from));

    const [threshold, серии, продажи, события, записи] = await Promise.all([
      readIntSetting(this.db, "SHRINK_ALERT_UZS", SHRINK_ALERT_FALLBACK, this.logger),
      // Сначала СПИСОК автоматов окна: снимки по одному автомату читаются
      // ниже, иначе 60 суток парка легли бы в память разом (тот же приём, что
      // в детекторе заливок).
      this.db
        .select({ serial: slotSnapshot.machineSerial })
        .from(slotSnapshot)
        .where(gte(slotSnapshot.capturedAt, since))
        .groupBy(slotSnapshot.machineSerial),
      // Продажи — из `sale` (день + автомат + товар): это единственная
      // таблица, где продажи разложены ПО ДНЯМ. `product_sale` хранит
      // последний 7-дневный батч без разбивки по суткам и для усушки не
      // годится. Источник не фильтруем: писатель у `sale` один
      // (`SalesService`), и жёсткое `source = 'ourvend'` тихо обнулило бы
      // продажи в день, когда источник переименуют, — а нулевые продажи
      // выглядят как недостача во весь остаток.
      this.db
        .select({ dt: sale.dt, machineSerial: sale.machineSerial, product: sale.product, qty: sale.qty })
        .from(sale)
        .where(and(gte(sale.dt, from), lte(sale.dt, to))),
      this.db
        .select({
          machineSerial: vendingRefillEvent.machineSerial,
          windowTo: vendingRefillEvent.windowTo,
          units: vendingRefillEvent.units,
        })
        .from(vendingRefillEvent)
        .where(gte(vendingRefillEvent.windowTo, периодОт)),
      this.db
        .select({ machineSerial: vendingRefill.machineSerial, performedAt: vendingRefill.performedAt, qty: vendingRefill.qty })
        .from(vendingRefill)
        .where(gte(vendingRefill.performedAt, периодОт)),
    ]);

    // Продажи по (автомат, сутки) → НОРМАЛИЗОВАННЫЙ ключ товара. Отсутствие
    // ключа и пустая карта — РАЗНЫЕ вещи: первое значит «продажи за день не
    // собраны» (день не считаем), второе невозможно, потому что ключ рождается
    // из строки.
    const продажиПоДням = new Map<string, Map<string, number>>();
    /** Имя товара из продаж — на случай, если ни прайс, ни снимок его не знают. */
    const имяИзПродаж = new Map<string, string>();
    /** Ключи товаров, по которым у автомата были продажи за период. */
    const продажиАвтомата = new Map<string, Set<string>>();
    for (const r of продажи) {
      const canonSerial = normalizeMachineSerial(r.machineSerial);
      const имя = ctx.canonOf(r.product);
      const ключ = normalizeProductName(имя);
      if (!имяИзПродаж.has(ключ)) имяИзПродаж.set(ключ, имя);
      const карта = продажиПоДням.get(`${canonSerial}|${r.dt}`) ?? new Map<string, number>();
      карта.set(ключ, (карта.get(ключ) ?? 0) + Number(r.qty));
      продажиПоДням.set(`${canonSerial}|${r.dt}`, карта);
      const набор = продажиАвтомата.get(canonSerial) ?? new Set<string>();
      набор.add(ключ);
      продажиАвтомата.set(canonSerial, набор);
    }

    const приходПоДням = сумма(события, (r) => `${normalizeMachineSerial(r.machineSerial)}|${tashkentDay(r.windowTo)}`, (r) => r.units);
    const записаноПоДням = сумма(записи, (r) => `${normalizeMachineSerial(r.machineSerial)}|${tashkentDay(r.performedAt)}`, (r) => r.qty);

    // Серийники сводим к канону ДО чтения снимков: «c2508160376» и
    // «2508160376» — один автомат, и раньше вторая форма молча выбрасывалась
    // вместе со своими снимками — день уезжал в `snapshots_stale` без причины.
    const формыКанона = new Map<string, string[]>();
    for (const { serial } of серии) {
      const canon = normalizeMachineSerial(serial);
      формыКанона.set(canon, [...(формыКанона.get(canon) ?? []), serial]);
    }

    const machines: ShrinkMachine[] = [];
    const warnings: ShrinkWarning[] = [];

    for (const [canon, формы] of формыКанона) {
      // Автомат не в строю в усушку не идёт: у склада-«автомата» и машины в
      // ремонте расхождение остатка — норма, и тревожить им владельца значит
      // приучить его пролистывать отчёт. Про них говорит план закупа.
      if (ctx.registry.notInService.has(canon)) continue;
      const name = ctx.registry.nameBySerial.get(canon) ?? формы[0]!;
      try {
        const строка = await this.поАвтомату(canon, формы, name, dates, since, ctx, {
          продажиПоДням,
          приходПоДням,
          записаноПоДням,
          threshold,
        });
        if (строка.machine) machines.push(строка.machine);
        warnings.push(...строка.warnings);

        // Продажи есть, а слота под этот товар в снимках нет ни одного дня:
        // либо товар вынули из автомата, либо имя не сшилось со справочником.
        // Второе — тихая потеря продаж из расчёта, поэтому говорим вслух.
        //
        // Но ТОЛЬКО про автомат, о котором нам вообще есть что сказать. У
        // отсеянного источника (`no_slots`, заглушка, неоткалиброванные
        // ёмкости) `slotKeys` пуст по построению, и в предупреждение уехал бы
        // ВЕСЬ ассортимент его продаж — про автомат, который строкой выше уже
        // объявлен нечитаемым.
        if (строка.machine) {
          const безСлота = [...(продажиАвтомата.get(canon) ?? [])]
            .filter((k) => !строка.slotKeys.has(k))
            .map((k) => ctx.display.get(k) ?? имяИзПродаж.get(k) ?? k)
            .sort((a, b) => a.localeCompare(b, "ru"));
          if (безСлота.length > 0) {
            warnings.push({
              code: "sales_unknown_product",
              message: `${name}: продажи есть, а слота в снимках нет — ${безСлота.join(", ")}`,
            });
          }
        }
      } catch (e: unknown) {
        // Один сломанный автомат не должен уносить ни отчёт, ни утренние
        // алерты по остальным двадцати пяти. Наружу — фиксированная фраза:
        // текст исключения drizzle несёт запрос и параметры, а этот отчёт
        // читают открытым GET, панелью и телеграмом.
        const текст = e instanceof Error ? e.message : String(e);
        this.logger.warn(`Усушка ${name} (${canon}) не посчиталась: ${текст}`);
        warnings.push({ code: "machine_error", message: `${name}: ошибка расчёта, см. лог` });
      }
    }

    machines.sort((a, b) => b.summary.lossValue - a.summary.lossValue || a.name.localeCompare(b.name, "ru"));
    warnings.sort((a, b) => a.code.localeCompare(b.code) || a.message.localeCompare(b.message, "ru"));
    return { from, to, threshold, machines, warnings };
  }

  /** Усушка одного автомата: снимки, дни, предупреждения по этому аппарату. */
  private async поАвтомату(
    canon: string,
    формы: string[],
    name: string,
    dates: string[],
    since: Date,
    ctx: ShrinkContext,
    данные: {
      продажиПоДням: Map<string, Map<string, number>>;
      приходПоДням: Map<string, number>;
      записаноПоДням: Map<string, number>;
      threshold: number;
    },
  ): Promise<{ machine: ShrinkMachine | null; warnings: ShrinkWarning[]; slotKeys: Set<string> }> {
    const warnings: ShrinkWarning[] = [];
    const slotKeys = new Set<string>();

    const снимки: MachineSnapshot[] = [];
    for (const форма of формы) снимки.push(...(await this.снимкиАвтомата(форма, since, ctx, slotKeys)));
    снимки.sort((a, b) => a.capturedAt.getTime() - b.capturedAt.getTime());
    if (снимки.length === 0) {
      // Серийник только что пришёл из выборки по ЭТОМУ ЖЕ окну — пусто здесь
      // означает, что снимки удалили между двумя запросами. Молчать нельзя:
      // автомат просто исчез бы из отчёта.
      warnings.push({ code: "machine_error", message: `${name}: снимки исчезли между выборками (гонка со сбором)` });
      return { machine: null, warnings, slotKeys };
    }

    // Мёртвый автомат — вон, но С ПРИЧИНОЙ. Причины «источник врёт» и
    // «слоты не откалиброваны» чинятся в разных местах, поэтому текст
    // предупреждения у них разный, хотя код один: для читателя отчёта это
    // одно и то же — «по автомату сказать нечего».
    const причина = skipReasonOf(снимки);
    if (причина) {
      warnings.push({ code: "machine_dead", message: `${name}: ${ПРИЧИНА[причина]} — усушка не считается` });
      return { machine: null, warnings, slotKeys };
    }

    const дни: ShrinkDayInput[] = [];
    const refillDays: ShrinkRefillDay[] = [];
    const староСнимков: string[] = [];
    const безПродаж: string[] = [];

    for (const date of dates) {
      const приход = данные.приходПоДням.get(`${canon}|${date}`) ?? 0;
      if (приход > 0) {
        refillDays.push({ date, detectedUnits: приход, recordedUnits: данные.записаноПоДням.get(`${canon}|${date}`) ?? 0 });
      }
      const начало = ближайший(снимки, началоСуток(date));
      const конец = ближайший(снимки, началоСуток(date) + DAY_MS);
      if (!начало || !конец) {
        староСнимков.push(date);
        continue;
      }
      const продажиДня = данные.продажиПоДням.get(`${canon}|${date}`);
      if (!продажиДня && приход === 0) {
        // Несобранные продажи выглядят как недостача во весь дневной расход —
        // самый громкий ложный алерт, какой этот отчёт может выдать.
        безПродаж.push(date);
        continue;
      }
      дни.push({
        date,
        startSlots: начало.slots,
        endSlots: конец.slots,
        sales: продажиДня ?? new Map<string, number>(),
        refillUnits: приход,
      });
    }

    const summary = shrinkageByDay(дни, ctx.priceByKey, данные.threshold);
    // Наружу товар уходит ЧЕЛОВЕЧЕСКИМ именем: нормализованный ключ («red
    // bull») нужен только для сшивки, показывать его владельцу нельзя.
    const items = summary.items.map((i) => ({ ...i, product: ctx.display.get(i.product) ?? i.product }));

    // Одна строка на автомат, а не на день: 26 автоматов × 14 дней дали бы
    // триста предупреждений, среди которых не видно ни одного. Дат в строке —
    // не больше пяти: окно в 60 суток на автомате без сбора давало строку в
    // полсотни дат, которую владелец не дочитает и до середины.
    if (староСнимков.length > 0) {
      warnings.push({
        code: "snapshots_stale",
        message: `${name}: нет снимков у границ суток — пропущены дни ${listInline(староСнимков)}`,
      });
    }
    if (безПродаж.length > 0) {
      warnings.push({ code: "no_sales_day", message: `${name}: нет продаж за ${listInline(безПродаж)} — дни не считались` });
    }
    // «Ни одного посчитанного дня» — это НЕ «недостач нет». Автомат, у
    // которого весь период оказался заливкой (или снимками/продажами без
    // границ), из расчёта выпал целиком, и молчаливый ноль здесь читался бы
    // как чистый результат — ровно то утверждение, которого расчёт не давал.
    if (summary.daysCounted === 0) {
      warnings.push({
        code: "no_counted_days",
        message: `${name}: не считали — все ${dates.length} дн. периода были заливкой/пропущены`,
      });
    }
    return { machine: { serial: canon, name, summary: { ...summary, items }, refillDays }, warnings, slotKeys };
  }

  /**
   * Суточные алерты: усушка за порогом и «заканчивается товар».
   *
   * ДЕДУП. У двух алертов он разный, потому что разные факты.
   * · Усушка — В ПРЕДЕЛАХ ТАШКЕНТСКИХ СУТОК: крон в 08:35 и ручной прогон из
   *   панели не задваивают строку. Ежедневный повтор здесь НАМЕРЕННЫЙ: пока
   *   недостача за скользящую неделю держится за порогом, владелец видит её
   *   каждое утро — это незакрытая проблема, а не шум.
   * · «Заканчивается» — по (автомат, товар, `left`) на `LOW_STOCK_REPEAT_MS`:
   *   пустая позиция стоит пустой неделями, и ежедневный повтор об одном и том
   *   же нуле как раз шум. Изменился остаток — новость проходит сразу.
   */
  async alertDaily(now = new Date()): Promise<AlertRun> {
    const ctx = await this.контекст();
    const отчёт = await this.построить(ALERT_DAYS, now, ctx);
    // Прогон пересчитал отчёт и написал по нему события: закешированная
    // прошлая картина после этого разошлась бы с брифингом.
    this.invalidate();
    const сутки = tashkentDayStartOf(now);
    const окноПовтора = new Date(now.getTime() - LOW_STOCK_REPEAT_MS);

    const [написанное, поСерийникам] = await Promise.all([
      // Одним запросом за оба окна — берём БОЛЬШЕЕ (окно повтора «остатка»),
      // а суточную границу усушки прикладываем в памяти: два запроса к той же
      // таблице за пересекающиеся окна дороже, чем лишние строки за трое суток.
      this.db
        .select({ type: event.type, payload: event.payload, occurredAt: event.occurredAt })
        .from(event)
        .where(
          and(
            inArray(event.type, [SHRINK_EVENT, LOW_STOCK_EVENT]),
            gte(event.occurredAt, окноПовтора < сутки ? окноПовтора : сутки),
          ),
        ),
      // Планограмма — только СВЕЖАЯ (см. `LOW_STOCK_FRESH_MS`), и той же
      // выборкой, что у плана закупа: две реализации «слоты по автоматам»
      // разошлись бы в правилах валидности.
      this.vending.slotsByMachine(new Date(now.getTime() - LOW_STOCK_FRESH_MS)),
    ]);

    const занято = new Set<string>();
    for (const e of написанное) {
      const p = (e.payload ?? {}) as Record<string, unknown>;
      if (e.type === SHRINK_EVENT) {
        if (e.occurredAt.getTime() < сутки.getTime()) continue;
        занято.add(`${e.type}|${String(p.serial)}|${String(p.product)}`);
      } else {
        // Ключ «заканчивается» включает ОСТАТОК: та же позиция с другим
        // числом — другая новость, и глушить её прошлым событием нельзя.
        занято.add(`${e.type}|${String(p.serial ?? p.machine)}|${String(p.product)}|${String(p.left)}`);
      }
    }

    const строки: { source: string; type: string; payload: Record<string, unknown> }[] = [];
    let lowStock = 0;
    let обрезано = false;
    /** `null` — потолок прогона исчерпан (обрезка), `false` — дедуп. */
    const добавить = (type: string, ключ: string, payload: Record<string, unknown>): boolean | null => {
      if (занято.has(ключ)) return false;
      if (строки.length >= ALERT_MAX_EVENTS) {
        обрезано = true;
        return null;
      }
      занято.add(ключ);
      строки.push({ source: "system", type, payload });
      return true;
    };

    for (const m of отчёт.machines) {
      for (const item of m.summary.items) {
        if (!item.alert) continue;
        if (обрезано) break;
        добавить(SHRINK_EVENT, `${SHRINK_EVENT}|${m.serial}|${item.product}`, {
          serial: m.serial,
          name: m.name,
          product: item.product,
          lossUnits: item.lossUnits,
          lossValue: item.lossValue,
          days: ALERT_DAYS,
        });
      }
      if (обрезано) break;
    }

    // «Заканчивается» считается по ПЛАНОГРАММЕ (`machine_slot`), а не по
    // усушке: это разные вопросы. Товар может не усыхать вовсе и при этом
    // кончиться, и наоборот.
    const поКанону = new Map<string, Slot[]>();
    for (const [serial, список] of поСерийникам) {
      const canon = normalizeMachineSerial(serial);
      поКанону.set(canon, [...(поКанону.get(canon) ?? []), ...список]);
    }
    for (const [canon, список] of поКанону) {
      if (обрезано) break;
      if (ctx.registry.notInService.has(canon)) continue;
      // Тот же судья, что у детектора и у отчёта: заглушка источника и
      // неоткалиброванная планограмма «заканчивается» не значат.
      if (skipReasonOf([{ serial: canon, capturedAt: now, slots: список }])) continue;
      const name = ctx.registry.nameBySerial.get(canon) ?? canon;
      const поТовару = new Map<string, { qty: number; cap: number }>();
      for (const s of список) {
        if (!hasProduct(s) || !slotValid(s)) continue;
        const ключ = ключТовара(ctx, s.product!);
        const a = поТовару.get(ключ) ?? { qty: 0, cap: 0 };
        a.qty += Math.min(s.quantity, s.capacity);
        a.cap += s.capacity;
        поТовару.set(ключ, a);
      }
      for (const [ключ, a] of поТовару) {
        if (обрезано) break;
        if (a.cap < LOW_STOCK_MIN_CAPACITY || a.qty > LOW_STOCK_LEFT) continue;
        const product = ctx.display.get(ключ) ?? ключ;
        // Ключ дедупа — СЕРИЙНИК и ОСТАТОК, а не отображаемое имя: два
        // автомата, названные одинаково, гасили бы алерты друг друга, а
        // изменившийся остаток обязан пройти, не дожидаясь трёх суток.
        if (
          добавить(LOW_STOCK_EVENT, `${LOW_STOCK_EVENT}|${canon}|${product}|${a.qty}`, {
            machine: name,
            serial: canon,
            product,
            left: a.qty,
          })
        ) {
          lowStock += 1;
        }
      }
    }
    if (обрезано) {
      this.logger.warn(
        `Алерты вендинга: обрезано на ${ALERT_MAX_EVENTS} событиях за прогон — столько строк разом даёт сбой сбора, а не расход.`,
      );
    }

    if (строки.length > 0) await this.db.insert(event).values(строки);
    return { alerts: строки.length, lowStock };
  }

  /**
   * Снимки одного автомата за окно, ОДНИМ запросом на автомат (осознанный
   * N+1 при парке ≤ ~30 машин — см. детектор заливок). Имя товара уходит в
   * расчёт НОРМАЛИЗОВАННЫМ ключом (сшивка с продажами), а человеческое
   * написание попадает в `display`, если товара нет в прайсе.
   */
  private async снимкиАвтомата(
    serial: string,
    since: Date,
    ctx: ShrinkContext,
    slotKeys: Set<string>,
  ): Promise<MachineSnapshot[]> {
    const строки = await this.db
      .select({
        coilId: slotSnapshot.coilId,
        productName: slotSnapshot.productName,
        capacity: slotSnapshot.capacity,
        quantity: slotSnapshot.quantity,
        capturedAt: slotSnapshot.capturedAt,
      })
      .from(slotSnapshot)
      .where(and(eq(slotSnapshot.machineSerial, serial), gte(slotSnapshot.capturedAt, since)));

    const поМоменту = new Map<number, MachineSnapshot>();
    for (const r of строки) {
      const t = r.capturedAt.getTime();
      let снимок = поМоменту.get(t);
      if (!снимок) {
        снимок = { serial, capturedAt: r.capturedAt, slots: [] };
        поМоменту.set(t, снимок);
      }
      const сырое = r.productName?.trim();
      let ключ: string | null = null;
      if (сырое) {
        ключ = ключТовара(ctx, сырое);
        slotKeys.add(ключ);
      }
      снимок.slots.push({ coilId: r.coilId, product: ключ, capacity: r.capacity, quantity: r.quantity });
    }
    return [...поМоменту.values()].sort((a, b) => a.capturedAt.getTime() - b.capturedAt.getTime());
  }
}

/** Дни периода по Ташкенту: `days` полных суток, последние — вчерашние. */
function периодДней(days: number, now: Date): string[] {
  const сегодня = tashkentDayStartOf(now).getTime();
  const out: string[] = [];
  for (let i = days; i >= 1; i--) out.push(tashkentDay(new Date(сегодня - i * DAY_MS)));
  return out;
}

/**
 * UTC-момент 00:00 Ташкента для даты YYYY-MM-DD.
 *
 * Тонкая обёртка над `tashkentDayStart` из `@mydon/shared`: даты сюда приходят
 * только из `периодДней`, то есть заведомо валидные, а второй копии смещения
 * зоны в коде быть не должно — на ней уехал донор VendCash.
 */
function началоСуток(date: string): number {
  return tashkentDayStart(date)!.getTime();
}

/**
 * Снимок, ближайший к границе суток, — или `null`, если ближайший дальше
 * допуска. Молча взять снимок суточной давности значит приписать автомату
 * продажи соседнего дня.
 */
function ближайший(снимки: MachineSnapshot[], граница: number): MachineSnapshot | null {
  let лучший: MachineSnapshot | null = null;
  let дистанция = Number.POSITIVE_INFINITY;
  for (const s of снимки) {
    const d = Math.abs(s.capturedAt.getTime() - граница);
    if (d < дистанция) {
      дистанция = d;
      лучший = s;
    }
  }
  return дистанция <= SNAPSHOT_STALE_MS ? лучший : null;
}

function сумма<T>(rows: T[], ключ: (r: T) => string, значение: (r: T) => number): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of rows) {
    const k = ключ(r);
    out.set(k, (out.get(k) ?? 0) + значение(r));
  }
  return out;
}

