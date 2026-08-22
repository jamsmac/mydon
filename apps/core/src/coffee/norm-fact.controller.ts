import { Controller, Get, Query } from "@nestjs/common";
import { NormFactService } from "./norm-fact.service";

/** Норма против факта по периодам бункера (срез F, задача 3) — отдельный маршрут, не растим и без того большой `CoffeeController`. */
@Controller("coffee")
export class NormFactController {
  constructor(private readonly normFact: NormFactService) {}

  @Get("norm-fact")
  report(@Query("from") from: string, @Query("to") to: string) {
    return this.normFact.report(from, to);
  }
}
