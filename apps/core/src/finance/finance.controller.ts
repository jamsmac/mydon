import { BadRequestException, Body, Controller, Get, Param, Patch, Post, Put, Query } from "@nestjs/common";
import { DOMAINS, type Domain } from "@mydon/shared";
import { Type } from "class-transformer";
import { ArrayMaxSize, IsArray, IsBoolean, IsNumber, IsOptional, IsString, MaxLength, ValidateNested } from "class-validator";
import { FinanceService, type CreateFlowInput } from "./finance.service";

function asDomain(value: string): Domain {
  if (!(DOMAINS as readonly string[]).includes(value)) {
    throw new BadRequestException(`Неизвестное направление "${value}". Доступны: ${DOMAINS.join(", ")}`);
  }
  return value as Domain;
}

/**
 * Одна строка массового импорта банковской выписки (срез К, задача 4). ДТО
 * следит только за ТИПОМ — семантику («есть ли оборот») проверяет сервис
 * построчно (урок среза D: одна кривая строка не должна ронять пачку из
 * тысяч; здесь их до 2440 в живом файле).
 *
 * ⚠️ ДТО обязано объявлять ВСЕ поля, которые реально отдаёт `parseBankStatement`
 * (`@mydon/shared`, `BankStatementRow` — 13 полей), а не только те, что
 * использует `importBankStatement`. `main.ts` ставит `forbidNonWhitelisted:
 * true` — лишнее поле в теле отбивает ВЕСЬ запрос 400, а не эту одну строку
 * (ревью среза К, 1.5: раньше здесь было объявлено только 8 из 13 полей —
 * `account`/`name`/`docType`/`branch`/`inn` роняли импорт целиком, 0 строк из
 * 2440 живого файла). Проверено тестом через настоящий `ValidationPipe` с
 * теми же опциями, что в `main.ts` (`finance.controller.test.ts`).
 */
export class ImportBankStatementItemDto {
  @IsString() @MaxLength(10)
  date!: string;

  @IsString() @MaxLength(64)
  account!: string;

  @IsString() @MaxLength(255)
  name!: string;

  @IsOptional() @IsNumber()
  debit?: number | null;

  @IsOptional() @IsNumber()
  credit?: number | null;

  @IsOptional() @IsString() @MaxLength(1000)
  purpose?: string | null;

  @IsOptional() @IsString() @MaxLength(16)
  cashSymbol?: string | null;

  @IsOptional() @IsString() @MaxLength(64)
  docNo?: string | null;

  @IsString() @MaxLength(64)
  docType!: string;

  @IsString() @MaxLength(255)
  branch!: string;

  @IsString() @MaxLength(32)
  inn!: string;

  @IsString() @MaxLength(128)
  extId!: string;

  @IsOptional()
  fileRow?: number;
}

/** Массовый импорт банковской выписки с предпросмотром — тот же контракт `dryRun`, что у импорта закупок (срез D). */
export class ImportBankStatementDto {
  @IsOptional() @IsBoolean()
  dryRun?: boolean;

  @IsArray() @ArrayMaxSize(3000) @ValidateNested({ each: true }) @Type(() => ImportBankStatementItemDto)
  items!: ImportBankStatementItemDto[];
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

  /** Подтянуть курсы из ЦБ РУз. Ручной курс, заданный сегодня, не перекрывается. */
  @Post("fx/refresh")
  refreshFx(@Body() body: { actorRef?: string }) {
    return this.finance.refreshFxFromCbu(body?.actorRef ?? "owner");
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

  /**
   * Массовый импорт банковской выписки с предпросмотром (срез К, задача 4):
   * `dryRun` ничего не пишет и возвращает тот же отчёт, что настоящий прогон
   * (R-D7 среза D). Строки — уже разобранные `parseBankStatement` (`@mydon/shared`).
   */
  @Post("bank-statement")
  importBankStatement(@Body() dto: ImportBankStatementDto, @Query("actorRef") actorRef?: string) {
    return this.finance.importBankStatement(dto, actorRef ?? "owner");
  }

  /**
   * Сверка кассы за период (R-K6): изъято по системе (инкассации) против
   * сдано в банк (взносы с кассовым символом `0200`), помесячно, с отдельным
   * списком периодов, где ровно одна сторона пуста.
   */
  @Get("cash-reconcile")
  cashReconcile(@Query("from") from?: string, @Query("to") to?: string) {
    return this.finance.cashReconcile(from ?? "", to ?? "");
  }
}
