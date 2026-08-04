import { BadRequestException, Body, Controller, Get, Param, Patch, Post, Query } from "@nestjs/common";
import { DOMAINS, type Domain } from "@mydon/shared";
import { ImportsService, type CreateImportInput, type ImportItem } from "./imports.service";

function asDomain(value: string): Domain {
  if (!(DOMAINS as readonly string[]).includes(value)) {
    throw new BadRequestException(`Неизвестное направление "${value}". Доступны: ${DOMAINS.join(", ")}`);
  }
  return value as Domain;
}

/** Импортные контракты GLOBERENT (перенос import_contracts PROMACH, односторонний контур). */
@Controller("imports")
export class ImportsController {
  constructor(private readonly imports: ImportsService) {}

  @Get()
  list(@Query("domain") domain?: string) {
    return this.imports.list(asDomain(domain ?? "globerent"));
  }

  @Get(":id")
  detail(@Param("id") id: string) {
    return this.imports.detail(id);
  }

  @Post()
  create(@Body() body: Partial<CreateImportInput> & { domain?: string; actorRef?: string }) {
    if (typeof body.contractNo !== "string") throw new BadRequestException("Нет номера контракта");
    if (typeof body.contractDate !== "string") throw new BadRequestException("Нет даты контракта");
    if (!Array.isArray(body.items)) throw new BadRequestException("Нет позиций");
    return this.imports.create(
      {
        domain: asDomain(body.domain ?? "globerent"),
        contractNo: body.contractNo,
        contractDate: body.contractDate,
        supplierId: body.supplierId,
        currency: body.currency,
        items: body.items as ImportItem[],
        purpose: body.purpose,
        saleContractId: body.saleContractId,
        prepaymentAmount: body.prepaymentAmount,
        prepaymentDueDate: body.prepaymentDueDate,
        balanceAmount: body.balanceAmount,
        balanceDueDate: body.balanceDueDate,
        notes: body.notes,
      },
      body.actorRef ?? "owner",
    );
  }

  /** Подписание (за обе стороны) → материализация единиц + план оплат. */
  @Patch(":id/sign")
  sign(@Param("id") id: string, @Body() body: { actorRef?: string }) {
    return this.imports.sign(id, body.actorRef ?? "owner");
  }

  /** Отметить оплату графика: prepayment | balance. */
  @Patch(":id/paid/:kind")
  markPaid(
    @Param("id") id: string,
    @Param("kind") kind: string,
    @Body() body: { actorRef?: string },
  ) {
    if (kind !== "prepayment" && kind !== "balance") {
      throw new BadRequestException("kind: prepayment | balance");
    }
    return this.imports.markPaid(id, kind, body.actorRef ?? "owner");
  }

  /** Массовое действие по единицам контракта (отгрузка, ГТД, склад). */
  @Patch(":id/bulk/:action")
  bulk(
    @Param("id") id: string,
    @Param("action") action: string,
    @Body()
    body: { declarationNumber?: string; declarationDate?: string; transportCompany?: string; actorRef?: string },
  ) {
    return this.imports.bulkUnitAction(id, action, body, body.actorRef ?? "owner");
  }

  /** Пересчитать lifecycle вручную (обычно двигается сам после действий). */
  @Patch(":id/recompute")
  recompute(@Param("id") id: string) {
    return this.imports.recomputeLifecycle(id).then((lifecycle) => ({ lifecycle }));
  }

  @Patch(":id/cancel")
  cancel(@Param("id") id: string, @Body() body: { actorRef?: string }) {
    return this.imports.cancel(id, body.actorRef ?? "owner");
  }
}
