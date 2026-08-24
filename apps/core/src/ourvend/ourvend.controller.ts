import { Body, Controller, Get, Post, Query } from "@nestjs/common";
import { IsArray, IsOptional } from "class-validator";
import { OurvendParityService } from "./ourvend-parity.service";
import { OurvendSnapshotService, type SnapshotDay } from "./ourvend-snapshot.service";

/**
 * Приём собственного учётного снапшота OurVend (П2 плана поглощения).
 * DTO нарочно мелкий: массовые данные проверяются ПОСТРОЧНО в сервисе с
 * карантином (урок среза D — @IsPositive на строке массового импорта отбивал
 * весь запрос без построчного отчёта). Мутации закрыты общим service-token.
 */
export class OurvendSnapshotDto {
  @IsOptional() @IsArray()
  sales?: SnapshotDay[];

  @IsOptional() @IsArray()
  stock?: SnapshotDay[];
}

@Controller("ourvend")
export class OurvendController {
  constructor(
    private readonly snapshots: OurvendSnapshotService,
    private readonly parity: OurvendParityService,
  ) {}

  @Post("snapshot")
  snapshot(@Body() dto: OurvendSnapshotDto) {
    return this.snapshots.apply({
      ...(dto.sales ? { sales: dto.sales } : {}),
      ...(dto.stock ? { stock: dto.stock } : {}),
    });
  }

  @Get("status")
  status() {
    return this.snapshots.status();
  }

  @Get("parity")
  parityReport(@Query("days") days?: string) {
    const n = Number(days);
    return this.parity.parity(Number.isFinite(n) && n > 0 ? n : 7);
  }
}
