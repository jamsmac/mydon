import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post, Put, Query } from "@nestjs/common";
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
