import { Body, Controller, Get, Param, Patch, Post, Put, Query } from "@nestjs/common";
import { CatalogService, type SaveTnvedInput } from "./catalog.service";

/**
 * Расчётные справочники GLOBERENT (перенос tnved_codes/brv_values PROMACH).
 * Чтения открыты внутри сети, мутации закрыты общим ServiceTokenGuard.
 */
@Controller("catalog")
export class CatalogController {
  constructor(private readonly catalog: CatalogService) {}

  /** Ставки ТН ВЭД (действующие; ?all=1 — вместе с выключенными). */
  @Get("tnved")
  tnved(@Query("all") all?: string) {
    return this.catalog.tnvedList(all === "1");
  }

  /** Создать или обновить ставку (с id — обновление). */
  @Post("tnved")
  saveTnved(@Body() body: SaveTnvedInput & { actorRef?: string }) {
    return this.catalog.saveTnved(body, body.actorRef ?? "owner");
  }

  /** Убрать ставку из работы (строка остаётся). */
  @Patch("tnved/:id/deactivate")
  deactivate(@Param("id") id: string, @Body() body: { actorRef?: string }) {
    return this.catalog.deactivateTnved(id, body.actorRef ?? "owner");
  }

  /** История БРВ. */
  @Get("brv")
  brv() {
    return this.catalog.brvList();
  }

  /** Задать БРВ с даты. */
  @Put("brv")
  setBrv(@Body() body: { valueUzs?: number; validFrom?: string; note?: string; actorRef?: string }) {
    return this.catalog.setBrv(
      { valueUzs: body.valueUzs ?? Number.NaN, validFrom: body.validFrom ?? "", note: body.note },
      body.actorRef ?? "owner",
    );
  }
}
