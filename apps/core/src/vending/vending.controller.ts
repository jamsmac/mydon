import { Body, Controller, Get, Param, Post } from "@nestjs/common";
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
  MaxLength,
  Min,
  ValidateNested,
} from "class-validator";
import { Type } from "class-transformer";
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

  @IsArray() @ArrayMaxSize(500) @ValidateNested({ each: true }) @Type(() => IngestSlotDto)
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
 * Вендинг: приём собранных данных и просмотр дефицита. Приём (POST) закрыт
 * общим ServiceTokenGuard — данные кладёт коллектор, не кто угодно.
 */
@Controller("vending")
export class VendingController {
  constructor(private readonly vending: VendingService) {}

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
  orders() {
    return this.vending.orders();
  }

  /** Принять накладную на склад (§5.7): приход += заказанное, статус received. */
  @Post("orders/receive")
  receiveOrder(@Body() dto: ReceiveOrderDto) {
    return this.vending.receiveOrder(dto.orderId, dto.receivedBy, dto.distributed);
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
}
