import { BadRequestException, Body, Controller, Get, Param, Post, Query } from "@nestjs/common";
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsISO8601,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from "class-validator";
import { Transform, Type } from "class-transformer";
import { Throttle } from "@nestjs/throttler";
import { AnalyticsService } from "./analytics.service";
import { RefillEventsService } from "./refill-events.service";
import { RefillService } from "./refill.service";
import { ShrinkageService } from "./shrinkage.service";
import { VendingService } from "./vending.service";
import { WeeklyDigestService } from "./weekly-digest.service";

export class IngestSlotDto {
  @IsString() @IsNotEmpty() @MaxLength(16)
  coilId!: string;

  @IsString() @MaxLength(255)
  product!: string;

  @IsInt() @Min(0)
  capacity!: number;

  @IsInt() @Min(0)
  quantity!: number;
}

export class IngestMachineDto {
  @IsString() @IsNotEmpty() @MaxLength(64)
  serial!: string;

  @IsOptional() @IsString() @MaxLength(255)
  alias?: string;

  // Потолок здесь — только защита от заведомо абсурдного запроса, а рабочее
  // ограничение живёт в сервисе (MAX_SLOTS_PER_MACHINE): валидатор отклоняет
  // ВЕСЬ запрос, поэтому одна разросшаяся машина уносила приём остальных
  // четырёх. Прежние 500 стояли в 12 слотах от живого автомата на 488.
  @IsArray() @ArrayMaxSize(5000) @ValidateNested({ each: true }) @Type(() => IngestSlotDto)
  slots!: IngestSlotDto[];
}

export class IngestPayloadDto {
  @IsOptional() @IsISO8601()
  capturedAt?: string;

  @IsArray() @ArrayMaxSize(200) @ValidateNested({ each: true }) @Type(() => IngestMachineDto)
  machines!: IngestMachineDto[];
}

export class IngestProductSaleDto {
  @IsString() @IsNotEmpty() @MaxLength(64)
  serial!: string;

  @IsString() @IsNotEmpty() @MaxLength(255)
  product!: string;

  @IsInt() @Min(0)
  quantity!: number;
}

export class IngestMachineSaleDto {
  @IsString() @IsNotEmpty() @MaxLength(64)
  serial!: string;

  @IsNumber() @Min(0)
  totalAmount!: number;

  @IsInt() @Min(0)
  totalCount!: number;
}

export class IngestSalesDto {
  @IsOptional() @IsISO8601()
  capturedAt?: string;

  @IsISO8601()
  periodStart!: string;

  @IsISO8601()
  periodEnd!: string;

  @IsArray() @ArrayMaxSize(5000) @ValidateNested({ each: true }) @Type(() => IngestProductSaleDto)
  productSales!: IngestProductSaleDto[];

  @IsArray() @ArrayMaxSize(500) @ValidateNested({ each: true }) @Type(() => IngestMachineSaleDto)
  machineSales!: IngestMachineSaleDto[];
}

export class IngestStockItemDto {
  @IsString() @IsNotEmpty() @MaxLength(255)
  product!: string;

  @IsInt() @Min(0)
  quantity!: number;
}

export class IngestStockDto {
  @IsOptional() @IsISO8601()
  countedAt?: string;

  @IsArray() @ArrayMaxSize(5000) @ValidateNested({ each: true }) @Type(() => IngestStockItemDto)
  items!: IngestStockItemDto[];
}

export class SubmitPurchaseDto {
  @IsOptional() @IsString() @MaxLength(128)
  createdBy?: string;
}

export class CashLineDto {
  @IsString() @IsNotEmpty() @MaxLength(255)
  label!: string;

  @IsOptional() @IsNumber() @Min(0)
  qty?: number;

  @IsOptional() @IsNumber() @Min(0)
  unitPrice?: number;

  // Целое: сум без копеек. Дробное здесь дало бы независимое .toFixed(2) на
  // receivedAmount/totalSpent/remainder разъехаться на 1 тийин (найдено
  // адверсариал-ревью) — проще не пускать дробь на границе API, чем сверять
  // сумму после округления.
  @IsInt() @Min(0)
  amount!: number;
}

export class CashCategoryDto {
  @IsString() @IsNotEmpty() @MaxLength(64)
  name!: string;

  @IsArray() @ArrayMaxSize(200) @ValidateNested({ each: true }) @Type(() => CashLineDto)
  lines!: CashLineDto[];
}

export class IngestCashSessionDto {
  @IsInt() @Min(0)
  receivedAmount!: number;

  @IsArray() @ArrayMaxSize(50) @ValidateNested({ each: true }) @Type(() => CashCategoryDto)
  categories!: CashCategoryDto[];

  @IsOptional() @IsString() @MaxLength(128)
  createdBy?: string;
}

export class ReceiveOrderDto {
  /** Пусто → принимаем последнюю неполученную накладную. */
  @IsOptional() @IsString() @MaxLength(36)
  orderId?: string;

  @IsOptional() @IsString() @MaxLength(128)
  receivedBy?: string;

  /** Товар → сколько сразу распределили по автоматам, минуя склад (§5.7). */
  @IsOptional() @IsObject()
  distributed?: Record<string, number>;
}

export class SetProductPriceDto {
  @IsString() @IsNotEmpty() @MaxLength(255)
  product!: string;

  /**
   * Целые сумы: дробной цены за единицу в закупе не бывает, а дробь на
   * границе API — почти наверняка ошибка разбора команды. Потолок — тот же,
   * что в парсере бота: numeric(10,2) не переживёт больше, а дороже 10 млн
   * сум за единицу в этом бизнесе не бывает.
   */
  @IsInt() @Min(1) @Max(10_000_000)
  price!: number;

  @IsOptional() @IsString() @MaxLength(128)
  actor?: string;

  /** Повторная команда со словом «точно» — пропуск гейта цены. */
  @IsOptional() @IsIn([true, false])
  confirmed?: boolean;
}

/**
 * Эталон витрины (П5b, R-P5b-6) — сколько владелец РЕШИЛ брать за товар.
 * Не путать с `SetProductPriceDto`: тот про закупочную цену.
 */
export class SetSalePriceDto {
  @IsString() @IsNotEmpty() @MaxLength(255)
  product!: string;

  /**
   * Целые сумы: витрина автомата дробей не принимает (монет меньше сума в
   * обороте нет), а дробь на границе API — почти наверняка ошибка разбора
   * команды. Потолок тот же, что у закупочной цены.
   */
  @IsInt() @Min(1) @Max(10_000_000)
  price!: number;

  @IsOptional() @IsString() @MaxLength(128)
  actor?: string;

  /** Повторная команда со словом «точно» — пропуск гейта по факту витрины. */
  @IsOptional() @IsIn([true, false])
  confirmed?: boolean;
}

/** Разовый бутстрап «витрина как факт» (П5b, R-P5b-6). */
export class BootstrapSalePriceDto {
  /**
   * Окно факта витрины, суток. По умолчанию 14 — столько же, сколько у гейта
   * и у отчёта «разрыв витрины»; потолок 180 — как у лент изменений цен.
   */
  @IsOptional() @IsInt() @Min(1) @Max(180)
  days?: number;

  @IsOptional() @IsString() @MaxLength(128)
  actor?: string;
}

/** Правила закупа товара (П5a): что владелец решает про закуп, а не про товар. */
export class SetProductRulesDto {
  @IsString() @IsNotEmpty() @MaxLength(255)
  product!: string;

  /** Кратность блока: закупаем упаковками, а не поштучно. */
  @IsOptional() @IsInt() @Min(1) @Max(1000)
  packSize?: number;

  @IsOptional() @IsIn([true, false])
  excludedFromPurchase?: boolean;

  /** 0 — снять фикс-количество. */
  @IsOptional() @IsInt() @Min(0) @Max(100_000)
  fixedPurchaseQty?: number;

  @IsOptional() @IsString() @MaxLength(128)
  actor?: string;
}

export class SyncFinishDto {
  @IsIn(["success", "partial", "failed"])
  status!: "success" | "partial" | "failed";

  @IsInt() @Min(0)
  machinesTotal!: number;

  @IsInt() @Min(0)
  machinesOk!: number;

  @IsInt() @Min(0)
  durationMs!: number;

  @IsOptional() @IsString() @MaxLength(2000)
  error?: string;
}

/**
 * Заливка автомата сотрудником (WAREHOUSE_SPEC §4.1).
 *
 * `clientKey` обязателен и приходит от клиента, а не генерируется здесь:
 * весь смысл ключа в том, чтобы ПОВТОР того же нажатия принёс то же значение.
 * Сгенерируй его сервер — каждый повтор был бы новой записью.
 */
export class CreateRefillDto {
  @IsString() @IsNotEmpty() @MaxLength(64)
  machineSerial!: string;

  @IsOptional() @IsUUID()
  machineId?: string;

  @IsOptional() @IsString() @MaxLength(16)
  coilId?: string;

  @IsString() @IsNotEmpty() @MaxLength(255)
  productName!: string;

  @IsInt() @Min(1)
  qty!: number;

  @IsOptional() @IsUUID()
  personId?: string;

  @IsOptional() @IsUUID()
  taskId?: string;

  @IsOptional() @IsISO8601({ strict: true })
  performedAt?: string;

  @IsString() @IsNotEmpty() @MaxLength(128)
  clientKey!: string;

  @IsOptional() @IsIn(["bot", "panel"])
  source?: string;

  @IsOptional() @IsString() @MaxLength(2000)
  note?: string;

  @IsOptional() @IsString() @MaxLength(128)
  createdBy?: string;
}

/**
 * Прогон детектора заливок (П4). Дни — окно снимков, по которому ищется приход.
 *
 * Потолок 30 суток — граница памяти, а не вкуса: снимки читаются по автомату,
 * но список автоматов и события окна всё равно живут в процессе, и полугодовой
 * прогон стоил бы сотен тысяч строк ради нулевого улова. Рабочее окно — 2 дня
 * (крон после каждого сбора слотов); всё, что глубже, — разовый разбор.
 */
export class DetectRefillEventsDto {
  @IsOptional() @IsInt() @Min(1) @Max(30)
  days?: number;
}

/**
 * Окно отчёта об усушке (П4). Потолок 60 суток — граница памяти: снимки
 * читаются по автомату, но 60 дней парка это уже полмиллиона строк за прогон.
 *
 * `@Type(() => Number)` обязателен: в query всё приходит строкой, а
 * `ValidationPipe` включён БЕЗ `enableImplicitConversion` — без него
 * `@IsInt()` отбивал бы любой `?days=`.
 */
export class ShrinkageDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(60)
  days?: number;
}

/**
 * Окна отчётов аналитики снека (П5b). Границы стоят на ВХОДЕ, а не только в
 * сервисе: `?days=100000` иначе доехал бы до выборки продаж и был бы зажат уже
 * после того, как запрос ушёл в базу.
 *
 * `@Type(() => Number)` обязателен всем четырём: в query всё приходит строкой,
 * а `ValidationPipe` включён БЕЗ `enableImplicitConversion` — без него
 * `@IsInt()` отбивал бы любой `?days=`.
 */
export class MarginDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(90)
  days?: number;
}

/** Мёртвый сток: потолок 180 суток — полгода без движения это уже не «сток», а списание. */
export class DeadStockDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(180)
  days?: number;
}

export class PriceChangesDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(180)
  days?: number;
}

/** Разрыв витрины: то же окно, что у гейта команды «цена продажи» (14 суток). */
export class PriceGapDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(90)
  days?: number;
}

/**
 * Неделя сводки, ключ `IYYY-IW` (`2026-34`). Пусто — предыдущая ISO-неделя.
 *
 * Регулярка, а не `@IsInt()` по двум полям: ключ приезжает из бота одной
 * строкой («итоги недели 2026-34») и таким же уезжает в дедуп доставки —
 * разбирать и собирать его заново значило бы завести второй формат недели.
 * Негодная НЕДЕЛЯ (`2026-99`) формой проходит и гасится сервисом в предыдущую:
 * отчёт — чтение, и владельцу полезнее письмо, чем 400.
 */
export class WeeklyDigestDto {
  // `@Transform` гасит ПУСТОЕ значение (`?week=`) в «не задано»: документировано
  // «пусто → предыдущая неделя», а `@IsOptional` пустую строку не пропускает и
  // отдал бы 400 на ссылку, которую руками собрать легче лёгкого.
  @IsOptional()
  @Transform(({ value }) => (value === "" ? undefined : value))
  @Matches(/^\d{4}-\d{2}$/, { message: "week — ключ ISO-недели вида 2026-34" })
  week?: string;
}

/**
 * Окно журнала детектора. DTO, а не `Number(days)` руками: без границ роут
 * принимал любое число и надеялся на зажим в сервисе — у соседних чтений
 * граница стоит на входе, и разнобой рано или поздно кончается тем, что зажим
 * забудут добавить.
 */
export class RefillEventsListDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(30)
  days?: number;
}

/**
 * Вендинг: приём собранных данных и просмотр дефицита. Приём (POST) закрыт
 * общим ServiceTokenGuard — данные кладёт коллектор, не кто угодно.
 */
@Controller("vending")
export class VendingController {
  constructor(
    private readonly vending: VendingService,
    private readonly refills: RefillService,
    private readonly refillEvents: RefillEventsService,
    private readonly shrinkageReport: ShrinkageService,
    private readonly analytics: AnalyticsService,
    private readonly weekly: WeeklyDigestService,
  ) {}

  @Post("ingest")
  ingest(@Body() dto: IngestPayloadDto) {
    return this.vending.ingestSlots(dto);
  }

  @Get("machines")
  machines() {
    return this.vending.machines();
  }

  @Get("deficit")
  deficit() {
    return this.vending.deficitSummary();
  }

  @Post("ingest-sales")
  ingestSales(@Body() dto: IngestSalesDto) {
    return this.vending.ingestSales(dto);
  }

  @Get("forecast")
  forecast() {
    return this.vending.forecast();
  }

  @Get("purchase")
  purchase() {
    return this.vending.purchase();
  }

  /** Отправить актуальный закуп на утверждение владельцу (§5.7). */
  @Post("purchase/submit")
  submitPurchase(@Body() dto: SubmitPurchaseDto) {
    return this.vending.submitPurchase(dto.createdBy);
  }

  /** Накладные закупа (материализованы при одобрении заявки). */
  @Get("orders")
  orders(@Query("limit") limit?: string) {
    // Сервис зажимает 1..50; NaN → дефолт. Больший лимит нужен выбору
    // накладной для чека (pickReceiptOrder), витрины живут на дефолте.
    const n = limit === undefined ? undefined : Number(limit);
    return this.vending.orders(n !== undefined && Number.isFinite(n) ? n : undefined);
  }

  /**
   * Принять накладную на склад (§5.7): приход += заказанное, статус received.
   *
   * Кеш аналитики сбрасывается ВСЕГДА, а не только при удачной приёмке:
   * приёмка меняет и остаток склада (мёртвый сток), и взвешенную себестоимость
   * всей маржи (`costIndex`), и пишет наблюдения цен. Сброс стоит один поход в
   * базу на следующем чтении, а несброшенный кеш — пять минут отчёта, в
   * котором только что принятой накладной нет.
   */
  @Post("orders/receive")
  async receiveOrder(@Body() dto: ReceiveOrderDto) {
    const итог = await this.vending.receiveOrder(dto.orderId, dto.receivedBy, dto.distributed);
    this.analytics.invalidateReports();
    return итог;
  }

  /** План закупа: раздача по маршруту и слотам (П5a). */
  @Get("plan")
  plan() {
    return this.vending.plan();
  }

  /** Прайс вендинга с правилами закупа — для редактора панели. */
  @Get("products")
  products() {
    return this.vending.products();
  }

  /** Правила закупа товара: блок / исключён / фикс-количество (П5a). */
  @Post("product-rules")
  setProductRules(@Body() dto: SetProductRulesDto) {
    const { product, actor, ...patch } = dto;
    if (patch.packSize === undefined && patch.excludedFromPurchase === undefined && patch.fixedPurchaseQty === undefined) {
      throw new BadRequestException("нечего менять: укажи packSize, excludedFromPurchase или fixedPurchaseQty");
    }
    return this.vending.setProductRules(product, patch, actor);
  }

  /**
   * Правка закупочной цены товара (гейт ±20% — см. setProductPrice).
   *
   * Закупочная цена — второй операнд маржи и оценки мёртвого стока, поэтому
   * удачная правка сбрасывает кеш аналитики: иначе владелец, поправив цену в
   * боте, пять минут читал бы маржу по старой.
   */
  @Post("product-price")
  async setProductPrice(@Body() dto: SetProductPriceDto) {
    const итог = await this.vending.setProductPrice(dto.product, dto.price, dto.actor, dto.confirmed);
    if (итог.ok) this.analytics.invalidateReports();
    return итог;
  }

  /**
   * Эталон витрины товара (гейт ±20% от ФАКТА витрины — см. setSalePrice).
   *
   * Удачная правка сбрасывает кеш аналитики: эталон — второй операнд отчёта
   * «разрыв витрины», и закешированный отчёт показывал бы владельцу разрыв,
   * которого он только что не стало.
   */
  @Post("sale-price")
  async setSalePrice(@Body() dto: SetSalePriceDto) {
    const итог = await this.vending.setSalePrice(dto.product, dto.price, dto.actor, dto.confirmed);
    if (итог.ok) this.analytics.invalidateReports();
    return итог;
  }

  /** «Витрина как факт»: разовый бутстрап эталонов по продажам окна. */
  @Post("sale-price/bootstrap")
  async bootstrapSalePrice(@Body() dto: BootstrapSalePriceDto) {
    const итог = await this.vending.bootstrapSalePrice(dto.days, dto.actor);
    if (итог.set.length > 0) this.analytics.invalidateReports();
    return итог;
  }

  // ── Склад: инвентаризация (POST) и остаток (GET) ──────────────────────────

  @Post("stock")
  ingestStock(@Body() dto: IngestStockDto) {
    return this.vending.ingestStock(dto);
  }

  @Get("stock")
  stock() {
    return this.vending.stockLevels();
  }

  // ── Касса закупа (§5.8): получил → статьи → остаток ───────────────────────

  @Post("cash")
  recordCashSession(@Body() dto: IngestCashSessionDto) {
    return this.vending.recordCashSession(dto.receivedAmount, dto.categories, dto.createdBy);
  }

  @Get("cash")
  cashSessions() {
    return this.vending.cashSessions();
  }

  // ── Журнал сбора: коллектор открывает запуск, потом закрывает итогом ───────

  @Post("sync/start")
  startSync() {
    return this.vending.startSyncRun();
  }

  @Post("sync/:id/finish")
  finishSync(@Param("id") id: string, @Body() dto: SyncFinishDto) {
    return this.vending.finishSyncRun(id, dto);
  }

  @Get("sync")
  syncRuns() {
    return this.vending.syncRuns();
  }

  // ── Заливка автоматов: факт от сотрудника, списание со склада ─────────────

  @Post("refills")
  createRefill(@Body() dto: CreateRefillDto) {
    return this.refills.create({
      ...dto,
      performedAt: dto.performedAt ? new Date(dto.performedAt) : undefined,
    });
  }

  /** Товары, стоящие в автомате по зеркалу — кнопки мастера заливки в боте. */
  @Get("machine-products")
  machineProducts(@Query("serial") serial?: string) {
    return this.refills.productsOf(serial ?? "");
  }

  // ── Детектор заливок по снимкам: заливка = факт снимка (R-P4-2) ───────────

  /**
   * Прогон детектора — крон агента после каждого сбора слотов (SERVICE_TOKEN).
   * Идемпотентен: повторный прогон по тому же окну новых событий не даёт.
   */
  @Post("refill-events/detect")
  detectRefillEvents(@Body() dto: DetectRefillEventsDto) {
    return this.refillEvents.detect(dto.days);
  }

  /**
   * Усушка автоматов по дням без заливок (П4, R-P4-3). Чтение открыто: это
   * отчёт, а не мутация.
   *
   * ЛИЧНЫЙ ЛИМИТ, а не общий. GET проходит `ServiceTokenGuard` без токена, а
   * расчёт тяжёлый: `?days=60` тянет продажи периода в память и делает запрос
   * снимков на каждый автомат. Общего лимита (60 запросов / 10 с) хватало,
   * чтобы уложить Core одним циклом `curl` из докер-сети. Шесть запросов в
   * минуту — это вдвое больше, чем нужно панели: отчёт всё равно живёт в кеше
   * пять минут (`REPORT_CACHE_MS`).
   */
  @Throttle({ burst: { limit: 6, ttl: 60_000 }, sustained: { limit: 6, ttl: 60_000 } })
  @Get("shrinkage")
  shrinkage(@Query() dto: ShrinkageDto) {
    return this.shrinkageReport.report(dto.days);
  }

  // ── Аналитика снека (П5b): деньги, мёртвый сток, цены, витрина ────────────
  //
  // У каждого GET СВОЙ лимит, а не общий: расчёт тяжёлый (продажи окна в
  // память плюс остатки и события), и общего потолка (60 запросов / 10 с)
  // хватало, чтобы уложить Core одним циклом `curl` из докер-сети. Двенадцать
  // запросов в минуту — вдвое больше, чем нужно панели (у неё три листа), и в
  // двадцать раз меньше, чем нужно, чтобы Core лёг: отчёт всё равно живёт в
  // кеше пять минут (`REPORT_CACHE_MS`).

  /** Маржа по проданному за окно: автомат → товар (R-P5b-3). */
  @Throttle({ burst: { limit: 12, ttl: 60_000 }, sustained: { limit: 12, ttl: 60_000 } })
  @Get("margin")
  margin(@Query() dto: MarginDto) {
    return this.analytics.margin(dto.days);
  }

  /** Мёртвый сток: что не двигалось за окно — склад и автоматы (R-P5b-4). */
  @Throttle({ burst: { limit: 12, ttl: 60_000 }, sustained: { limit: 12, ttl: 60_000 } })
  @Get("dead-stock")
  deadStock(@Query() dto: DeadStockDto) {
    return this.analytics.deadStock(dto.days);
  }

  /** Изменения цен: закупочные и витринные, плюс помесячная динамика (R-P5b-5). */
  @Throttle({ burst: { limit: 12, ttl: 60_000 }, sustained: { limit: 12, ttl: 60_000 } })
  @Get("price-changes")
  priceChanges(@Query() dto: PriceChangesDto) {
    return this.analytics.priceChanges(dto.days);
  }

  /** Факт витрины против эталона владельца (R-P5b-6). */
  @Throttle({ burst: { limit: 12, ttl: 60_000 }, sustained: { limit: 12, ttl: 60_000 } })
  @Get("price-gap")
  priceGap(@Query() dto: PriceGapDto) {
    return this.analytics.priceGap(dto.days);
  }

  /**
   * Недельная сводка снек-контура одним JSON (R-P5b-7): деньги недели, работа,
   * мёртвый сток, цены, здоровье сбора. Текст собирает бот, панель показывает
   * те же числа — второго расчёта нигде нет.
   *
   * Лимит тот же, что у остальных отчётов: внутри сводки четыре тяжёлых
   * расчёта, но все они живут в кеше пять минут.
   */
  @Throttle({ burst: { limit: 12, ttl: 60_000 }, sustained: { limit: 12, ttl: 60_000 } })
  @Get("weekly-digest")
  weeklyDigest(@Query() dto: WeeklyDigestDto) {
    return this.weekly.digest(dto.week);
  }

  /**
   * Ручной прогон суточных алертов (усушка за порогом + «заканчивается»).
   *
   * Тот же метод, что дёргает крон в 08:35. Роут нужен по двум причинам: без
   * него весь SQL алертов не исполнялся бы против живого Postgres ни разу
   * (юнит-заглушка запросы не выполняет), и владелец не мог бы пересчитать
   * утро после починки данных, не дожидаясь следующих суток. Идемпотентен в
   * пределах суток — дедуп по (автомат, товар, день). Тела нет: окно алерта
   * фиксировано неделей, выбирать тут нечего.
   */
  @Post("shrinkage/alerts")
  shrinkageAlerts() {
    return this.shrinkageReport.alertDaily();
  }

  /** Журнал событий детектора: что автомат получил и была ли запись оператора. */
  @Get("refill-events")
  refillEventsList(@Query() dto: RefillEventsListDto) {
    return this.refillEvents.list(dto.days);
  }

  @Get("refills")
  listRefills(
    @Query("machineSerial") machineSerial?: string,
    @Query("personId") personId?: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
    @Query("limit") limit?: string,
  ) {
    const n = Number(limit);
    return this.refills.list({
      machineSerial,
      personId,
      from: from ? new Date(from) : undefined,
      to: to ? new Date(to) : undefined,
      limit: Number.isFinite(n) && n > 0 ? n : undefined,
    });
  }
}
