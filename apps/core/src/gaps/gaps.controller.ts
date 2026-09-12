import { Body, Controller, Get, Post, Query } from "@nestjs/common";
import { IsISO8601, IsOptional } from "class-validator";
import { GapSignalService, type GapDigest } from "./gap-signal.service";
import { GapsService, type Gap } from "./gaps.service";

class ReconcileGapsDto {
  /** День сверки; нет — сегодняшний ташкентский. Нужен сценариям и разбору задним числом. */
  @IsOptional() @IsISO8601()
  day?: string;
}

/**
 * Реестр пробелов (срез К, задача 5): что нельзя посчитать прямо сейчас,
 * явным адресным списком. Пустой массив — хорошая новость, а не ошибка.
 */
@Controller("gaps")
export class GapsController {
  constructor(
    private readonly gaps: GapsService,
    private readonly signal: GapSignalService,
  ) {}

  @Get()
  list(): Promise<Gap[]> {
    return this.gaps.list();
  }

  /**
   * Сводка за сутки: что стало известно, что появилось, что вернулось, что
   * висит давно. Читается из журнала переходов — считать реестр заново тут
   * нельзя: сводка о ПРОШЕДШЕМ дне, а реестр всегда о «сейчас».
   */
  @Get("digest")
  digest(@Query("day") day?: string): Promise<GapDigest> {
    return day === undefined || day === "" ? this.signal.digest() : this.signal.digest(day);
  }

  /** Ручная сверка — та же, что идёт по расписанию в 06:00 Ташкента. Идемпотентна. */
  @Post("reconcile")
  reconcile(@Body() dto: ReconcileGapsDto): Promise<{ seen: number; closed: number; appeared: number; returned: number }> {
    return dto.day === undefined ? this.signal.reconcile() : this.signal.reconcile(dto.day);
  }
}
