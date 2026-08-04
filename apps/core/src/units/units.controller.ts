import { BadRequestException, Body, Controller, Get, Param, Patch, Post, Query } from "@nestjs/common";
import { DOMAINS, type Domain } from "@mydon/shared";
import { UnitsService, type CreateUnitInput } from "./units.service";

function asDomain(value: string): Domain {
  if (!(DOMAINS as readonly string[]).includes(value)) {
    throw new BadRequestException(`Неизвестное направление "${value}". Доступны: ${DOMAINS.join(", ")}`);
  }
  return value as Domain;
}

/** Склад техники GLOBERENT (перенос warehouse_vehicles PROMACH). */
@Controller("units")
export class UnitsController {
  constructor(private readonly units: UnitsService) {}

  @Get("summary")
  summary(@Query("domain") domain?: string) {
    return this.units.pipelineSummary(asDomain(domain ?? "globerent"));
  }

  @Get()
  list(@Query("domain") domain?: string, @Query("group") group?: string) {
    return this.units.list(asDomain(domain ?? "globerent"), group);
  }

  @Post()
  create(@Body() body: Partial<CreateUnitInput> & { domain?: string; actorRef?: string }) {
    if (typeof body.name !== "string") throw new BadRequestException("Нет названия единицы");
    return this.units.create(
      {
        domain: asDomain(body.domain ?? "globerent"),
        name: body.name,
        modelId: body.modelId,
        year: body.year,
        vin: body.vin,
        inStock: body.inStock,
        salesPrice: body.salesPrice,
        notes: body.notes,
      },
      body.actorRef ?? "owner",
    );
  }

  /** Себестоимость единицы: корзины донора + маржа. */
  @Get(":id/cost")
  cost(@Param("id") id: string) {
    return this.units.cost(id);
  }

  /** Семантический переход конвейера: действие из единой матрицы shared. */
  @Patch(":id/action/:action")
  action(
    @Param("id") id: string,
    @Param("action") action: string,
    @Body()
    body: {
      transportCompany?: string;
      declarationNumber?: string;
      declarationDate?: string;
      arrivalDate?: string;
      actorRef?: string;
    },
  ) {
    return this.units.applyAction(id, action, body, body.actorRef ?? "owner");
  }

  @Patch(":id/vin")
  setVin(@Param("id") id: string, @Body() body: { vin?: string; actorRef?: string }) {
    if (typeof body.vin !== "string") throw new BadRequestException("Нет VIN");
    return this.units.setVin(id, body.vin, body.actorRef ?? "owner");
  }

  @Patch(":id/vin/unbind")
  unbindVin(@Param("id") id: string, @Body() body: { actorRef?: string }) {
    return this.units.unbindVin(id, body.actorRef ?? "owner");
  }

  @Post(":id/reserve")
  reserve(
    @Param("id") id: string,
    @Body() body: { endDate?: string; clientId?: string; note?: string; actorRef?: string },
  ) {
    return this.units.reserve(
      id,
      { endDate: body.endDate ?? "", clientId: body.clientId, note: body.note },
      body.actorRef ?? "owner",
    );
  }

  @Patch(":id/reserve/cancel")
  cancelReserve(@Param("id") id: string, @Body() body: { actorRef?: string }) {
    return this.units.cancelReserve(id, body.actorRef ?? "owner");
  }

  @Patch(":id/sales-stage")
  salesStage(
    @Param("id") id: string,
    @Body()
    body: { stage?: string; lostReason?: string; salesPrice?: number; clientId?: string; actorRef?: string },
  ) {
    if (typeof body.stage !== "string") throw new BadRequestException("Нет стадии");
    return this.units.setSalesStage(
      id,
      body.stage,
      { lostReason: body.lostReason, salesPrice: body.salesPrice, clientId: body.clientId },
      body.actorRef ?? "owner",
    );
  }
}
