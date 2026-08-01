import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post } from "@nestjs/common";
import {
  IsIn,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  IsUUID,
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
}
