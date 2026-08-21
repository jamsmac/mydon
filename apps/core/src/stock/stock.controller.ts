import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post, Query } from "@nestjs/common";
import {
  IsIn,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  IsUUID,
  Min,
  MaxLength,
} from "class-validator";
import { StockService } from "./stock.service";

/** Заявка на движение склада. Приход — с ценой; расход/перемещение — позже. */
export class CreateMovementDto {
  @IsIn(["intake", "consumption", "transfer"])
  kind!: "intake" | "consumption" | "transfer";

  @IsUUID()
  ingredientId!: string;

  @IsUUID()
  warehouseId!: string;

  @IsOptional() @IsUUID()
  counterpartyId?: string;

  @IsOptional() @IsString() @MaxLength(10)
  dt?: string;

  @IsNumber() @IsPositive()
  qty!: number;

  @IsString() @MaxLength(16)
  unit!: string;

  @IsOptional() @IsNumber()
  unitPrice?: number;

  @IsOptional() @IsString() @MaxLength(256)
  supplier?: string;

  @IsOptional() @IsString() @MaxLength(1000)
  note?: string;

  /**
   * Кто внёс: person:<id> от бота, отсутствует — владелец из панели.
   * Раньше DTO поле не принимал, и ЛЮБОЙ приход писался как 'owner' —
   * кладовщик в ленте действий был невидим.
   */
  @IsOptional() @IsString() @MaxLength(128)
  createdBy?: string;

  /** Ключ идемпотентности: повтор того же нажатия несёт то же значение. */
  @IsOptional() @IsString() @MaxLength(128)
  clientKey?: string;
}

/** Пересчёт: фактическое количество ингредиента на складе. */
export class StocktakeDto {
  @IsUUID()
  warehouseId!: string;

  @IsUUID()
  ingredientId!: string;

  @IsNumber() @Min(0)
  actual!: number;

  @IsOptional() @IsString() @MaxLength(16)
  unit?: string;

  @IsOptional() @IsString() @MaxLength(1000)
  note?: string;

  @IsOptional() @IsString() @MaxLength(128)
  countedBy?: string;

  /** Ключ идемпотентности: повтор того же нажатия несёт то же значение. */
  @IsOptional() @IsString() @MaxLength(128)
  clientKey?: string;
}

/**
 * Завести партию прихода (§4.3 + документ Р3/Р4). Все поля документа
 * необязательны: приход без партии остаётся возможен, а партия без кода —
 * тоже законна (не у каждой поставки есть номер партии от поставщика).
 */
export class CreateBatchDto {
  @IsUUID()
  ingredientId!: string;

  @IsUUID()
  warehouseId!: string;

  @IsNumber() @IsPositive()
  qtyReceived!: number;

  @IsString() @MaxLength(16)
  unit!: string;

  @IsOptional() @IsString() @MaxLength(10)
  receivedOn?: string;

  @IsOptional() @IsString() @MaxLength(128)
  batchCode?: string;

  @IsOptional() @IsString() @MaxLength(10)
  expiryDate?: string;

  @IsOptional() @IsString() @MaxLength(10)
  manufactureDate?: string;

  @IsOptional() @IsUUID()
  personId?: string;

  /** Имя поставщика как на карточке — сервер сам разрешит его в контрагента (R-C4). */
  @IsOptional() @IsString() @MaxLength(256)
  supplier?: string;

  @IsOptional() @IsString() @MaxLength(64)
  invoiceNo?: string;

  @IsOptional() @IsString() @MaxLength(10)
  invoiceDate?: string;

  @IsOptional() @IsString() @MaxLength(64)
  ikpu?: string;

  @IsOptional() @IsNumber() @Min(0)
  unitPriceNet?: number;

  @IsOptional() @IsNumber() @Min(0)
  vatRate?: number;

  @IsOptional() @IsNumber() @Min(0)
  unitPriceGross?: number;

  @IsOptional() @IsString() @MaxLength(1000)
  note?: string;

  @IsOptional() @IsString() @MaxLength(16)
  source?: string;

  @IsOptional() @IsString() @MaxLength(128)
  extId?: string;

  @IsOptional() @IsString() @MaxLength(128)
  createdBy?: string;

  /** Ключ идемпотентности связанного движения прихода — тот же приём, что у CreateMovementDto. */
  @IsOptional() @IsString() @MaxLength(128)
  clientKey?: string;
}

/** Отметить вскрытие партии. */
export class OpenBatchDto {
  @IsOptional() @IsString() @MaxLength(10)
  openedOn?: string;

  @IsOptional() @IsUUID()
  openedBy?: string;
}

/** Склад: движения сырья и остаток на чтении. */
@Controller("stock")
export class StockController {
  constructor(private readonly stock: StockService) {}

  @Post("movement")
  create(@Body() dto: CreateMovementDto) {
    return this.stock.createMovement(dto);
  }

  @Delete("movement/:id")
  async remove(@Param("id", ParseUUIDPipe) id: string) {
    await this.stock.removeMovement(id);
    return { ok: true };
  }

  /** Завести партию прихода (и связанное приходное движение — см. StockService.createBatch). */
  @Post("batch")
  createBatch(@Body() dto: CreateBatchDto) {
    return this.stock.createBatch(dto);
  }

  /** Список партий с остатком (леджер) и флагом срока; фильтры необязательны. */
  @Get("batches")
  batches(
    @Query("ingredientId") ingredientId?: string,
    @Query("warehouseId") warehouseId?: string,
    @Query("flag") flag?: string,
  ) {
    return this.stock.listBatches({ ingredientId, warehouseId, flag });
  }

  /** Отчёт по срокам годности: просрочено/истекает/в порядке/без срока + порядок FEFO. */
  @Get("expiry")
  expiry() {
    return this.stock.expiryReport();
  }

  /** Отметить вскрытие партии. */
  @Post("batch/:id/open")
  openBatch(@Param("id", ParseUUIDPipe) id: string, @Body() dto: OpenBatchDto) {
    return this.stock.openBatch(id, dto);
  }

  /** Остаток ингредиента: сводный, по складам и лента движений. */
  @Get("ingredient/:id")
  ingredient(@Param("id", ParseUUIDPipe) id: string) {
    return this.stock.ingredientStock(id);
  }

  /** Остаток склада: что и сколько лежит. */
  @Get("warehouse/:id")
  warehouse(@Param("id", ParseUUIDPipe) id: string) {
    return this.stock.warehouseStock(id);
  }

  /** Остаток пары «склад × ингредиент» — что показать перед вводом факта. */
  @Get("balance")
  balance(
    @Query("warehouseId", ParseUUIDPipe) warehouseId: string,
    @Query("ingredientId", ParseUUIDPipe) ingredientId: string,
  ) {
    return this.stock.pairBalance(warehouseId, ingredientId);
  }

  /** Инвентаризация: записать факт пересчёта корректировкой на дельту. */
  @Post("stocktake")
  stocktake(@Body() dto: StocktakeDto) {
    return this.stock.stocktake(dto);
  }

  /** Свести приход из mydon-stock в ленту склада (идемпотентно). */
  @Post("sync-intake")
  syncIntake() {
    return this.stock.syncIntakeFromPurchases();
  }

  /**
   * Расход сырья за период. По умолчанию — последние 30 дней. Даты в формате
   * YYYY-MM-DD; нераспознанные молча заменяются умолчанием.
   */
  @Get("consumption")
  consumption(@Query("from") from?: string, @Query("to") to?: string) {
    const iso = /^\d{4}-\d{2}-\d{2}$/;
    const today = new Date();
    const past = new Date();
    past.setDate(past.getDate() - 30);
    const day = (d: Date) => d.toISOString().slice(0, 10);
    const f = from && iso.test(from) ? from : day(past);
    const t = to && iso.test(to) ? to : day(today);
    return this.stock.consumption(f, t);
  }
}
