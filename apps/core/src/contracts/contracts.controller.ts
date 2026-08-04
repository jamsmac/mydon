import { BadRequestException, Body, Controller, Get, Param, Patch, Post, Query } from "@nestjs/common";
import { DOMAINS, type ContractItem, type Domain } from "@mydon/shared";
import { ContractsService, type BuyerSnapshot } from "./contracts.service";

function asDomain(value: string): Domain {
  if (!(DOMAINS as readonly string[]).includes(value)) {
    throw new BadRequestException(`Неизвестное направление "${value}". Доступны: ${DOMAINS.join(", ")}`);
  }
  return value as Domain;
}

/**
 * UZS-договоры купли-продажи (перенос contracts PROMACH).
 * Мутации закрыты общим ServiceTokenGuard — договор money-домен, вход через панель.
 */
@Controller("contracts")
export class ContractsController {
  constructor(private readonly contracts: ContractsService) {}

  @Get()
  list(@Query("domain") domain?: string) {
    return this.contracts.list(asDomain(domain ?? "globerent"));
  }

  @Get(":id")
  detail(@Param("id") id: string) {
    return this.contracts.detail(id);
  }

  @Post()
  create(
    @Body()
    body: {
      domain?: string;
      contractNo?: string;
      contractDate?: string;
      clientId?: string;
      buyer?: BuyerSnapshot;
      sellerCompanyId?: string;
      items?: ContractItem[];
      payType?: "100" | "partial" | "install" | "post";
      warranty?: string;
      deliveryDays?: number;
      docParams?: Record<string, unknown>;
      agentId?: string;
      agentCommissionAmount?: number;
      agentCommissionCurrency?: string;
      actorRef?: string;
    },
  ) {
    if (typeof body.contractDate !== "string") throw new BadRequestException("Нет даты договора");
    if (!Array.isArray(body.items)) throw new BadRequestException("Нет позиций договора");
    return this.contracts.create(
      {
        domain: asDomain(body.domain ?? "globerent"),
        contractNo: body.contractNo,
        contractDate: body.contractDate,
        clientId: body.clientId,
        buyer: body.buyer,
        sellerCompanyId: body.sellerCompanyId,
        items: body.items,
        payType: body.payType,
        warranty: body.warranty,
        deliveryDays: body.deliveryDays,
        docParams: body.docParams,
        agentId: body.agentId,
        agentCommissionAmount: body.agentCommissionAmount,
        agentCommissionCurrency: body.agentCommissionCurrency,
      },
      body.actorRef ?? "owner",
    );
  }

  @Patch(":id/status")
  setStatus(@Param("id") id: string, @Body() body: { status?: string; actorRef?: string }) {
    if (typeof body.status !== "string") throw new BadRequestException("Нет статуса");
    return this.contracts.setStatus(id, body.status, body.actorRef ?? "owner");
  }

  @Post(":id/payments")
  addPayment(
    @Param("id") id: string,
    @Body()
    body: { amount?: number; currency?: string; docNo?: string; date?: string; rate?: number; actorRef?: string },
  ) {
    if (typeof body.amount !== "number") throw new BadRequestException("Сумма — число");
    return this.contracts.addPayment(
      id,
      { amount: body.amount, currency: body.currency, docNo: body.docNo, date: body.date, rate: body.rate },
      body.actorRef ?? "owner",
    );
  }

  @Post(":id/acts")
  addAct(
    @Param("id") id: string,
    @Body()
    body: {
      actNo?: string;
      actDate?: string;
      itemRefs?: { equipmentId?: string | null; name: string }[];
      signedBySeller?: string;
      signedByBuyer?: string;
      notes?: string;
      actorRef?: string;
    },
  ) {
    return this.contracts.addAct(
      id,
      {
        actNo: body.actNo ?? "",
        actDate: body.actDate ?? "",
        itemRefs: body.itemRefs,
        signedBySeller: body.signedBySeller,
        signedByBuyer: body.signedByBuyer,
        notes: body.notes,
      },
      body.actorRef ?? "owner",
    );
  }
}
