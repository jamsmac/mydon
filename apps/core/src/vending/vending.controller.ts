import { Body, Controller, Get, Param, Post, Query } from "@nestjs/common";
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
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from "class-validator";
import { Type } from "class-transformer";
import { RefillService } from "./refill.service";
import { VendingService } from "./vending.service";

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
 * Вендинг: приём собранных данных и просмотр дефицита. Приём (POST) закрыт
 * общим ServiceTokenGuard — данные кладёт коллектор, не кто угодно.
 */
@Controller("vending")
export class VendingController {
  constructor(
    private readonly vending: VendingService,
    private readonly refills: RefillService,
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

  /** Принять накладную на склад (§5.7): приход += заказанное, статус received. */
  @Post("orders/receive")
  receiveOrder(@Body() dto: ReceiveOrderDto) {
    return this.vending.receiveOrder(dto.orderId, dto.receivedBy, dto.distributed);
  }

  /** Правка закупочной цены товара (гейт ±20% — см. setProductPrice). */
  @Post("product-price")
  setProductPrice(@Body() dto: SetProductPriceDto) {
    return this.vending.setProductPrice(dto.product, dto.price, dto.actor, dto.confirmed);
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
