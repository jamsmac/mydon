import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from "@nestjs/common";
import { IsNotEmpty, IsOptional, IsString, IsUUID, MaxLength } from "class-validator";
import { SalesService } from "./sales.service";

export class AddAliasDto {
  /** Имя из источника — ровно как в продажах. */
  @IsString() @IsNotEmpty() @MaxLength(300)
  name!: string;

  @IsUUID()
  entityId!: string;

  @IsOptional() @IsString() @MaxLength(128)
  actor?: string;
}

/** Продажи автоматов: сводка, журнал, «молчащие» (этап 1 миграции). */
@Controller("sales")
export class SalesController {
  constructor(private readonly sales: SalesService) {}

  @Get("summary")
  summary() {
    return this.sales.summary();
  }

  /** Динамика по дням — для графика дашборда. */
  @Get("daily")
  daily(@Query("days") days?: string) {
    const n = Number(days);
    return this.sales.daily(Number.isFinite(n) && n > 0 ? n : 30);
  }

  @Get("silent")
  silent(@Query("days") days?: string) {
    const n = Number(days);
    return this.sales.silent(Number.isFinite(n) && n > 0 ? Math.min(n, 30) : 2);
  }

  /**
   * Продажи одного товара — для карточки. `entityId` собирает имя карточки
   * плюс алиасы; `name` оставлен для прямого запроса по имени.
   */
  @Get("by-product")
  byProduct(
    @Query("entityId") entityId?: string,
    @Query("name") name?: string,
    @Query("days") days?: string,
  ) {
    const n = Number(days);
    const d = Number.isFinite(n) && n > 0 ? Math.min(n, 365) : 90;
    if (entityId) return this.sales.byProductCard(entityId, d);
    return this.sales.byProduct((name ?? "").trim(), d);
  }

  /** Имена продаж без карточки и алиаса — то, что теряется из карточек. */
  @Get("unmatched-names")
  unmatchedNames(@Query("days") days?: string) {
    const n = Number(days);
    return this.sales.unmatchedNames(Number.isFinite(n) && n > 0 ? Math.min(n, 365) : 90);
  }

  /** Привязать имя источника к карточке товара (решение владельца). */
  @Post("alias")
  addAlias(@Body() dto: AddAliasDto) {
    return this.sales.addAlias(dto.name, dto.entityId, dto.actor ?? "owner");
  }

  @Delete("alias/:id")
  async removeAlias(@Param("id", ParseUUIDPipe) id: string, @Query("actor") actor?: string) {
    await this.sales.removeAlias(id, actor ?? "owner");
    return { ok: true };
  }

  @Get()
  journal(@Query("days") days?: string, @Query("limit") limit?: string) {
    const d = Number(days);
    const l = Number(limit);
    return this.sales.journal(
      Number.isFinite(d) && d > 0 ? Math.min(d, 90) : 7,
      Number.isFinite(l) && l > 0 ? Math.min(l, 1000) : 300,
    );
  }
}
