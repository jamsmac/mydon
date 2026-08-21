import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post, Query } from "@nestjs/common";
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  IsUUID,
  Min,
  MaxLength,
  ValidateNested,
} from "class-validator";
import { Type } from "class-transformer";
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

/** Одна строка массового импорта партий (срез D, задача 3). */
export class ImportBatchItemDto {
  @IsInt() @Min(1)
  fileRow!: number;

  /** Карточка сырья, подтверждённая на витрине (Task 2); null — строка не сопоставлена. */
  @IsOptional() @IsUUID()
  ingredientId?: string | null;

  @IsUUID()
  warehouseId!: string;

  @IsNumber() @IsPositive()
  qtyReceived!: number;

  @IsString() @MaxLength(16)
  unit!: string;

  /** Дата прихода (R-D3); null — строка без даты, в отчёт, не в партию. */
  @IsOptional() @IsString() @MaxLength(10)
  receivedOn?: string | null;

  @IsOptional() @IsString() @MaxLength(256)
  supplier?: string | null;

  @IsOptional() @IsString() @MaxLength(64)
  invoiceNo?: string | null;

  @IsOptional() @IsString() @MaxLength(10)
  invoiceDate?: string | null;

  @IsOptional() @IsNumber() @Min(0)
  unitPriceGross?: number | null;

  @IsOptional() @IsString() @MaxLength(1000)
  note?: string | null;

  /** Имя строки — только для отчёта, если она не создаст партию. */
  @IsOptional() @IsString() @MaxLength(256)
  name?: string | null;

  /** Ключ идемпотентности строки в паре с `source` тела запроса; по умолчанию — String(fileRow). */
  @IsOptional() @IsString() @MaxLength(128)
  extId?: string | null;
}

/**
 * Массовый импорт партий с предпросмотром (срез D, задача 3). До 500 строк —
 * см. `ArrayMaxSize`.
 */
export class ImportBatchesDto {
  @IsString() @MaxLength(32)
  source!: string;

  /** Ничего не пишет, возвращает тот же отчёт, что настоящий прогон (R-D7). */
  @IsOptional() @IsBoolean()
  dryRun?: boolean;

  /** Дата инвентаризации: партии импорта закрываются расходом на эту дату (R-D1). */
  @IsOptional() @IsString() @MaxLength(10)
  closeOn?: string | null;

  @IsArray() @ArrayMaxSize(500) @ValidateNested({ each: true }) @Type(() => ImportBatchItemDto)
  items!: ImportBatchItemDto[];
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

  /**
   * Массовый импорт партий с предпросмотром (срез D, задача 3): `dryRun`
   * ничего не пишет и возвращает тот же отчёт, что настоящий прогон (R-D7).
   */
  @Post("batches/import")
  importBatches(@Body() dto: ImportBatchesDto) {
    return this.stock.importBatches(dto);
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
