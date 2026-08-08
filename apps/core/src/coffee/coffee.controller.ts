import { BadRequestException, Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post, Put, Query } from "@nestjs/common";
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsISO8601,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from "class-validator";
import { Type } from "class-transformer";
import { UNITS, type Unit } from "@mydon/shared";
import { CoffeeService } from "./coffee.service";

export class CreateLocationDto {
  @IsString() @IsNotEmpty() @MaxLength(128)
  name!: string;
}

export class UpdateLocationDto {
  @IsOptional() @IsString() @MaxLength(128)
  name?: string;

  @IsOptional() @IsBoolean()
  isActive?: boolean;
}

export class AddBunkerIngredientDto {
  @IsInt() @Min(1) @Max(8)
  position!: number;

  @IsString() @IsNotEmpty() @MaxLength(128)
  ingredientName!: string;
}

export class RemoveBunkerIngredientDto {
  @IsInt() @Min(1) @Max(8)
  position!: number;

  @IsUUID()
  ingredientId!: string;
}

export class SetIngredientPriceDto {
  @IsUUID()
  ingredientId!: string;

  @IsNumber() @Min(0)
  purchasePrice!: number;
}

export class SetTargetFillWeightDto {
  @IsInt() @Min(1) @Max(8)
  position!: number;

  @IsUUID()
  ingredientId!: string;

  @IsInt() @Min(0)
  targetFillWeight!: number;
}

export class SetTareDto {
  @IsInt() @Min(1) @Max(27)
  containerNumber!: number;

  @IsInt() @Min(1) @Max(8)
  position!: number;

  @IsInt() @Min(0)
  tareWeight!: number;
}

export class SubmitRefillDto {
  @IsUUID()
  locationId!: string;

  @IsInt() @Min(1) @Max(8)
  position!: number;

  @IsOptional() @IsInt() @Min(1) @Max(27)
  containerNumber?: number;

  @IsOptional() @IsUUID()
  ingredientId?: string;

  @IsInt() @Min(0)
  filledWeight!: number;

  @IsOptional() @IsInt() @Min(0)
  measuredBefore?: number;

  @IsOptional() @IsInt() @Min(1)
  packageCount?: number;

  @IsISO8601()
  enteredDate!: string;

  @IsOptional() @IsString() @MaxLength(128)
  createdBy?: string;
}

export class RecordConsumableDto {
  @IsUUID()
  locationId!: string;

  @IsISO8601()
  loggedDate!: string;

  @IsOptional() @IsInt() @Min(0)
  water?: number;

  @IsOptional() @IsInt() @Min(0)
  cups?: number;

  @IsOptional() @IsInt() @Min(0)
  lids?: number;

  @IsOptional() @IsString() @MaxLength(128)
  createdBy?: string;
}

export class RecordContainerReturnDto {
  @IsInt() @Min(1) @Max(8)
  position!: number;

  @IsInt() @Min(1) @Max(27)
  containerNumber!: number;

  @IsInt() @Min(0) @Max(10000)
  weight!: number;

  @IsISO8601()
  returnedDate!: string;

  @IsOptional() @IsString() @MaxLength(256)
  locationNote?: string;

  @IsOptional() @IsString() @MaxLength(128)
  createdBy?: string;
}

export class RecordWashDto {
  @IsUUID()
  locationId!: string;

  @IsOptional() @IsInt() @Min(1) @Max(8)
  position?: number;

  @IsOptional() @IsIn(["wash", "clean", "replace", "service"])
  kind?: "wash" | "clean" | "replace" | "service";

  @IsOptional() @IsString() @MaxLength(2000)
  note?: string;

  @IsOptional() @IsString() @MaxLength(128)
  performedBy?: string;
}

export class RecipeLineDto {
  @IsUUID()
  ingredientId!: string;

  @IsNumber() @Min(0)
  quantity!: number;

  @IsIn(UNITS as unknown as string[])
  unit!: Unit;
}

export class UpsertProductDto {
  @IsString() @IsNotEmpty() @MaxLength(128)
  name!: string;

  @IsArray() @ArrayMaxSize(50) @ValidateNested({ each: true }) @Type(() => RecipeLineDto)
  recipe!: RecipeLineDto[];
}

export class RecordSaleDto {
  @IsUUID()
  locationId!: string;

  @IsUUID()
  productId!: string;

  @IsISO8601()
  loggedDate!: string;

  @IsInt() @Min(0)
  quantity!: number;

  @IsOptional() @IsString() @MaxLength(128)
  createdBy?: string;
}

export class LinkLocationDto {
  @IsUUID()
  locationId!: string;

  // Какой аппарат ставим на место. Снятие — отдельным маршрутом
  // `DELETE machine-link/:entityId`: на месте может стоять несколько аппаратов,
  // и «снять» без указания какого именно — не операция, а угадывание.
  @IsOptional() @IsUUID()
  entityId?: string | null;
}

export class SetWashScheduleDto {
  @IsUUID()
  locationId!: string;

  @IsOptional() @IsInt() @Min(1) @Max(8)
  position?: number;

  @IsOptional() @IsInt() @Min(1)
  frequencyDays?: number;

  @IsOptional() @IsInt() @Min(1)
  frequencyCups?: number;

  @IsOptional() @IsBoolean()
  isActive?: boolean;

  @IsOptional() @IsString() @MaxLength(2000)
  notes?: string;
}

export class IngestCoffeeStockItemDto {
  @IsUUID()
  ingredientId!: string;

  @IsInt() @Min(0)
  quantity!: number;
}

export class IngestCoffeeStockDto {
  @IsOptional() @IsISO8601()
  countedAt?: string;

  @IsArray() @ArrayMaxSize(200) @ValidateNested({ each: true }) @Type(() => IngestCoffeeStockItemDto)
  items!: IngestCoffeeStockItemDto[];
}

/** Кофе-бункеры: точки, тара, ежедневная заливка, расходники, мойка, сверка расхода. */
@Controller("coffee")
export class CoffeeController {
  constructor(private readonly coffee: CoffeeService) {}

  @Get("locations")
  locations() {
    return this.coffee.locations();
  }

  /** Завести точку из панели. */
  @Post("locations")
  createLocation(@Body() dto: CreateLocationDto) {
    return this.coffee.createLocation(dto.name);
  }

  /** Переименовать / включить-выключить точку. */
  @Put("locations/:id")
  updateLocation(@Param("id", ParseUUIDPipe) id: string, @Body() dto: UpdateLocationDto) {
    return this.coffee.updateLocation(id, dto);
  }

  // ── Привязка точек к автоматам реестра ─────────────────────────────────

  @Get("machines")
  machineCandidates() {
    return this.coffee.machineCandidates();
  }

  @Put("location-link")
  linkLocation(@Body() dto: LinkLocationDto) {
    return this.coffee.linkLocation(dto.locationId, dto.entityId ?? null);
  }

  /**
   * Снять аппарат с места — закрыть его открытый период размещения.
   *
   * Адресуется АППАРАТОМ, а не местом: у места аппаратов может быть несколько
   * (слово владельца — «в одной точке может стоять как разные аппараты, так и
   * несколько одинаковых»), и «снять с точки» без имени аппарата двусмысленно.
   */
  @Delete("machine-link/:entityId")
  unlinkMachine(@Param("entityId", ParseUUIDPipe) entityId: string) {
    return this.coffee.unlinkMachine(entityId);
  }

  @Post("location-link/auto")
  autoLinkLocations() {
    return this.coffee.autoLinkLocations();
  }

  /** История размещений: какой аппарат когда на какой точке стоял. */
  @Get("placements")
  placements(@Query("locationId") locationId?: string) {
    return this.coffee.placements(locationId || undefined);
  }

  // ── Настройки ─────────────────────────────────────────────────────────

  @Get("bunker-config")
  bunkerConfig() {
    return this.coffee.bunkerConfig();
  }

  @Post("bunker-config")
  addBunkerIngredient(@Body() dto: AddBunkerIngredientDto) {
    return this.coffee.addBunkerIngredient(dto.position, dto.ingredientName);
  }

  @Delete("bunker-config")
  removeBunkerIngredient(@Body() dto: RemoveBunkerIngredientDto) {
    return this.coffee.removeBunkerIngredient(dto.position, dto.ingredientId);
  }

  @Put("ingredient-price")
  setIngredientPrice(@Body() dto: SetIngredientPriceDto) {
    return this.coffee.setIngredientPrice(dto.ingredientId, dto.purchasePrice);
  }

  @Put("target-fill")
  setTargetFillWeight(@Body() dto: SetTargetFillWeightDto) {
    return this.coffee.setTargetFillWeight(dto.position, dto.ingredientId, dto.targetFillWeight);
  }

  @Get("fill-status")
  fillStatusByLocation() {
    return this.coffee.fillStatusByLocation();
  }

  @Get("tare")
  tareGrid() {
    return this.coffee.tareGrid();
  }

  @Put("tare")
  setTare(@Body() dto: SetTareDto) {
    return this.coffee.setTare(dto.containerNumber, dto.position, dto.tareWeight);
  }

  // ── Ввод данных / Таблица ────────────────────────────────────────────

  @Post("refill")
  submitRefill(@Body() dto: SubmitRefillDto) {
    return this.coffee.submitRefill(dto);
  }

  @Get("refill/recent")
  recentRefills(@Query("limit") limit?: string) {
    return this.coffee.recentRefills(limit ? Number(limit) : undefined);
  }

  /** Удалить ошибочную заливку (строка целиком уходит в audit_log).
   *  `actor` — кто удаляет (в аудит); `by` — удалить только запись этого автора (бот). */
  @Delete("refill/:id")
  deleteRefill(@Param("id", ParseUUIDPipe) id: string, @Query("actor") actor?: string, @Query("by") by?: string) {
    return this.coffee.deleteRefill(id, { ...(actor ? { actor } : {}), ...(by ? { onlyIfCreatedBy: by } : {}) });
  }

  /** Последняя запись автора среди заливок/возвратов/расходников (бот «ошибся»). */
  @Get("last-entry")
  lastEntry(@Query("createdBy") createdBy?: string) {
    if (!createdBy) throw new BadRequestException("createdBy обязателен");
    return this.coffee.lastEntry(createdBy);
  }

  @Get("summary")
  locationSummary() {
    return this.coffee.locationSummary();
  }

  // ── Расходники ────────────────────────────────────────────────────────

  @Post("consumables")
  recordConsumable(@Body() dto: RecordConsumableDto) {
    return this.coffee.recordConsumable(dto);
  }

  @Get("consumables")
  consumablesSummary() {
    return this.coffee.consumablesSummary();
  }

  /** Удалить строку расходников за день (строка целиком уходит в audit_log). */
  @Delete("consumable/:id")
  deleteConsumable(@Param("id", ParseUUIDPipe) id: string, @Query("actor") actor?: string, @Query("by") by?: string) {
    return this.coffee.deleteConsumable(id, { ...(actor ? { actor } : {}), ...(by ? { onlyIfCreatedBy: by } : {}) });
  }

  // ── Возвраты наборов ─────────────────────────────────────────────────

  @Post("container-return")
  recordContainerReturn(@Body() dto: RecordContainerReturnDto) {
    return this.coffee.recordContainerReturn(dto);
  }

  @Get("container-return")
  containerReturns(@Query("limit") limit?: string) {
    return this.coffee.containerReturns(limit ? Number(limit) : undefined);
  }

  /** Удалить ошибочный возврат набора (строка целиком уходит в audit_log). */
  @Delete("container-return/:id")
  deleteContainerReturn(@Param("id", ParseUUIDPipe) id: string, @Query("actor") actor?: string, @Query("by") by?: string) {
    return this.coffee.deleteContainerReturn(id, { ...(actor ? { actor } : {}), ...(by ? { onlyIfCreatedBy: by } : {}) });
  }

  /** Фактический расход по наборам за период: заливка − возврат через тару. */
  @Get("container-consumption")
  containerConsumption(@Query("from") from: string, @Query("to") to: string) {
    return this.coffee.containerConsumption(from, to);
  }

  // ── Мойка/обслуживание ───────────────────────────────────────────────

  @Post("wash")
  recordWash(@Body() dto: RecordWashDto) {
    return this.coffee.recordWash(dto);
  }

  @Get("wash")
  washHistory(@Query("locationId") locationId?: string, @Query("limit") limit?: string) {
    return this.coffee.washHistory(locationId, limit ? Number(limit) : undefined);
  }

  @Get("wash-schedule")
  washScheduleStatus() {
    return this.coffee.washScheduleStatus();
  }

  @Get("wash-schedule/all")
  washSchedules() {
    return this.coffee.washSchedules();
  }

  @Post("wash-schedule")
  setWashSchedule(@Body() dto: SetWashScheduleDto) {
    return this.coffee.setWashSchedule(dto);
  }

  @Delete("wash-schedule/:id")
  removeWashSchedule(@Param("id", ParseUUIDPipe) id: string) {
    return this.coffee.removeWashSchedule(id);
  }

  // ── Товары/рецепты, продажи, сверка ─────────────────────────────────────

  @Get("products")
  products() {
    return this.coffee.products();
  }

  @Post("products")
  upsertProduct(@Body() dto: UpsertProductDto) {
    return this.coffee.upsertProduct(dto.name, dto.recipe);
  }

  @Post("sales")
  recordSale(@Body() dto: RecordSaleDto) {
    return this.coffee.recordSale(dto);
  }

  @Get("reconcile/:locationId")
  reconcile(@Param("locationId") locationId: string, @Query("from") from: string, @Query("to") to: string) {
    return this.coffee.reconcileLocation(locationId, from, to);
  }

  @Get("reconcile")
  reconcileAll(@Query("from") from: string, @Query("to") to: string) {
    return this.coffee.reconcileAllLocations(from, to);
  }

  // ── Склад ─────────────────────────────────────────────────────────────

  @Post("stock")
  ingestCoffeeStock(@Body() dto: IngestCoffeeStockDto) {
    return this.coffee.ingestCoffeeStock(dto.items, dto.countedAt);
  }

  @Get("stock")
  coffeeStockLevels() {
    return this.coffee.coffeeStockLevels();
  }
}
