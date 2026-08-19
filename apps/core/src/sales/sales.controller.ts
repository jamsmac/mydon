import { Controller, Get, Query } from "@nestjs/common";
import { SalesService } from "./sales.service";

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

  /** Продажи одного товара (по имени) — для карточки. Объявлен ВЫШЕ @Get(). */
  @Get("by-product")
  byProduct(@Query("name") name?: string, @Query("days") days?: string) {
    const n = Number(days);
    return this.sales.byProduct(
      (name ?? "").trim(),
      Number.isFinite(n) && n > 0 ? Math.min(n, 365) : 90,
    );
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
