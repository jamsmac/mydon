import { BadRequestException, Body, Controller, Get, Param, Patch, Post, Query } from "@nestjs/common";
import { DOMAINS, type Domain } from "@mydon/shared";
import { PreordersService, type CreatePreorderInput } from "./preorders.service";

function asDomain(value: string): Domain {
  if (!(DOMAINS as readonly string[]).includes(value)) {
    throw new BadRequestException(`Неизвестное направление "${value}". Доступны: ${DOMAINS.join(", ")}`);
  }
  return value as Domain;
}

/** Предзаказы GLOBERENT (перенос pre_orders PROMACH). */
@Controller("preorders")
export class PreordersController {
  constructor(private readonly preorders: PreordersService) {}

  @Get()
  list(@Query("domain") domain?: string) {
    return this.preorders.list(asDomain(domain ?? "globerent"));
  }

  @Post()
  create(@Body() body: Partial<CreatePreorderInput> & { domain?: string; actorRef?: string }) {
    if (typeof body.name !== "string") throw new BadRequestException("Нет названия");
    return this.preorders.create(
      {
        domain: asDomain(body.domain ?? "globerent"),
        name: body.name,
        qty: body.qty,
        modelId: body.modelId,
        clientId: body.clientId,
        supplierId: body.supplierId,
        notes: body.notes,
        submitImmediately: body.submitImmediately,
      },
      body.actorRef ?? "owner",
    );
  }

  @Patch(":id/action/:action")
  action(
    @Param("id") id: string,
    @Param("action") action: string,
    @Body()
    body: { contractRef?: string; factoryPriceUsd?: number; promisedDeliveryDate?: string; actorRef?: string },
  ) {
    return this.preorders.applyAction(id, action, body, body.actorRef ?? "owner");
  }

  @Patch(":id/cancel")
  cancel(@Param("id") id: string, @Body() body: { reason?: string; actorRef?: string }) {
    return this.preorders.cancel(id, body.reason ?? "", body.actorRef ?? "owner");
  }
}
