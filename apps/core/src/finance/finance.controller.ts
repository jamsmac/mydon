import { BadRequestException, Body, Controller, Get, Param, Patch, Post, Put, Query } from "@nestjs/common";
import { DOMAINS, type Domain } from "@mydon/shared";
import { FinanceService, type CreateFlowInput } from "./finance.service";

function asDomain(value: string): Domain {
  if (!(DOMAINS as readonly string[]).includes(value)) {
    throw new BadRequestException(`Неизвестное направление "${value}". Доступны: ${DOMAINS.join(", ")}`);
  }
  return value as Domain;
}

/**
 * Финансовый контур направления (модель PROMACH поверх money_flow).
 * Чтения открыты внутри сети, мутации закрыты общим ServiceTokenGuard —
 * деньги вводятся только через панель (принцип money-доменов MYDON).
 */
@Controller("finance")
export class FinanceController {
  constructor(private readonly finance: FinanceService) {}

  /** Действующие курсы валют к суму. Специфичный маршрут — выше параметрических. */
  @Get("fx")
  fx() {
    return this.finance.fxCurrent();
  }

  /** Задать курс вручную. Каждая установка — новая строка истории. */
  @Put("fx")
  setFx(@Body() body: { currency?: string; rate?: number; note?: string; actorRef?: string }) {
    if (typeof body.currency !== "string" || typeof body.rate !== "number") {
      throw new BadRequestException("Нужны currency (код валюты) и rate (сумов за единицу)");
    }
    return this.finance.setFx(
      { currency: body.currency, rate: body.rate, note: body.note },
      body.actorRef ?? "owner",
    );
  }

  /** Финансовый свод: агинг, «к сроку ≤ 7 дней», термометр, кэш-флоу. */
  @Get("summary/:domain")
  summary(@Param("domain") domain: string) {
    return this.finance.summary(asDomain(domain));
  }

  /** Контрагенты направления — кандидаты для привязки записи. */
  @Get("counterparties/:domain")
  counterparties(@Param("domain") domain: string) {
    return this.finance.counterpartyCandidates(asDomain(domain));
  }

  /** Лента записей направления. */
  @Get("flows/:domain")
  flows(
    @Param("domain") domain: string,
    @Query("status") status?: string,
    @Query("direction") direction?: string,
    @Query("limit") limit?: string,
  ) {
    const st =
      status === "planned" || status === "actual" || status === "cancelled" ? status : undefined;
    const dir = direction === "in" || direction === "out" ? direction : undefined;
    const lim = limit !== undefined ? Number(limit) : undefined;
    return this.finance.flows(asDomain(domain), {
      status: st,
      direction: dir,
      limit: lim !== undefined && Number.isFinite(lim) ? lim : undefined,
    });
  }

  /** Завести обязательство (planned) или платёж (actual). */
  @Post("flows")
  create(@Body() body: Partial<CreateFlowInput> & { domain?: string; actorRef?: string }) {
    if (typeof body.domain !== "string") throw new BadRequestException("Не указано направление");
    if (body.direction !== "in" && body.direction !== "out") {
      throw new BadRequestException("Направление движения — in (нам) или out (мы)");
    }
    if (typeof body.amount !== "number") throw new BadRequestException("Сумма — число");
    if (body.status !== "planned" && body.status !== "actual") {
      throw new BadRequestException("Статус — planned или actual");
    }
    const input: CreateFlowInput = {
      domain: asDomain(body.domain),
      direction: body.direction,
      status: body.status,
      amount: body.amount,
      currency: body.currency,
      category: body.category,
      method: body.method,
      isOfficial: body.isOfficial,
      rate: body.rate,
      counterpartyId: body.counterpartyId,
      counterparty: body.counterparty,
      docNo: body.docNo,
      purpose: body.purpose,
      date: body.date,
      dueDate: body.dueDate,
    };
    return this.finance.createFlow(input, body.actorRef ?? "owner");
  }

  /** Отметить обязательство оплаченным. */
  @Patch("flows/:id/pay")
  pay(@Param("id") id: string, @Body() body: { rate?: number; actorRef?: string }) {
    return this.finance.markPaid(id, { rate: body.rate }, body.actorRef ?? "owner");
  }

  /** Отменить ошибочную запись — строка остаётся в журнале. */
  @Patch("flows/:id/cancel")
  cancel(@Param("id") id: string, @Body() body: { actorRef?: string }) {
    return this.finance.cancelFlow(id, body.actorRef ?? "owner");
  }
}
