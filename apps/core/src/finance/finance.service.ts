import { BadGatewayException, BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { cbu } from "@mydon/connectors";
import { auditLog, collection, entity, fxRate, moneyFlow, org } from "@mydon/db";
import { MONEY_CATEGORIES, TZ, type Domain } from "@mydon/shared";
import { and, desc, eq, gte, inArray, lte, ne, sql } from "drizzle-orm";
import { DB, type Db } from "../db/db.module";
import {
  aging,
  byMonth,
  cashReconcile as cashReconcileMath,
  concentration,
  dayKey,
  dueSoon,
  fxRefreshPlan,
  uzsEquivalent,
  type AgingReport,
  type CashReconcileReport,
  type ConcentrationReport,
  type FlowForMath,
  type FxRefreshSkip,
  type MonthCash,
} from "./finance.math";

type FlowRow = typeof moneyFlow.$inferSelect;
type FxRow = typeof fxRate.$inferSelect;

/**
 * Категории — ЕДИНЫЙ словарь MONEY_CATEGORIES из packages/shared: у донора
 * четыре платёжных контура несли каждый свой словарь, здесь источник один.
 */
export const FLOW_CATEGORIES = MONEY_CATEGORIES;

const METHODS = ["bank", "cash"] as const;
const CURRENCY_RE = /^[A-Z]{3}$/;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

export interface CreateFlowInput {
  /**
   * Направление бизнеса. Необязательно (срез К, задача 4): импорт банковской
   * выписки покрывает счёт компании целиком, а не один домен — навязывать ему
   * домен значило бы выдумывать привязку, которой нет. Не задан — запись
   * ложится без домена и без orgId (обе колонки в БД nullable); все СУЩЕСТВУЮЩИЕ
   * вызовы domain передают всегда, и для них ничего не меняется.
   */
  domain?: Domain;
  direction: "in" | "out";
  /** planned — обязательство (долг/счёт), actual — свершившийся платёж. */
  status: "planned" | "actual";
  amount: number;
  currency?: string;
  category?: string;
  method?: "bank" | "cash";
  isOfficial?: boolean;
  /** Курс к суму на дату операции. Не задан — берётся действующий из fx_rate. */
  rate?: number;
  counterpartyId?: string;
  counterparty?: string;
  docNo?: string;
  purpose?: string;
  /** Дата операции (ISO). По умолчанию — сейчас. */
  date?: string;
  /** Срок оплаты YYYY-MM-DD — для planned. */
  dueDate?: string;
  /** Единица техники: из привязанных записей считается её себестоимость. */
  unitId?: string;
  /**
   * Откуда операция: click | payme | uzum | bank | cash | manual (факт 4 плана
   * среза К). Не задан — как и раньше, `'manual'`: поведение существующих
   * вызовов не меняется.
   */
  source?: string;
  /**
   * Идентификатор операции у источника — идемпотентность массового импорта
   * (уникальный индекс `money_flow_source_ext_key` на паре `(source, extId)`).
   * Задан и запись с таким `(source, extId)` уже есть — `createFlow` вернёт
   * СУЩЕСТВУЮЩУЮ строку, а не создаст дубль и не упадёт на ограничении БД.
   */
  extId?: string | null;
  /** Связь с инкассацией: наличные из автомата → сдача в банк. */
  collectionId?: string | null;
  /** Кассовый символ банка («0200» — взнос наличной выручки). */
  cashSymbol?: string | null;
}

/** Строка списка: с именем контрагента из реестра — панель не делает лишних запросов. */
export interface FlowListRow extends FlowRow {
  counterpartyEntityName: string | null;
  /** Эквивалент в сумах (null — курса нет). */
  uzs: number | null;
}

/**
 * Одна строка массового импорта банковской выписки (срез К, задача 4): вход
 * для `POST /finance/bank-statement`. Разбор строки (дата, дебет/кредит,
 * назначение, кассовый символ, `extId`) — забота `parseBankStatement`
 * (`@mydon/shared`), сюда приходит уже готовый результат.
 */
export interface ImportBankStatementItem {
  /** Дата операции, ISO YYYY-MM-DD (уже проверенная разбором). */
  date: string;
  /** Оборот дебет — null/не задан, если по этой строке дебета нет. */
  debit?: number | null;
  /** Оборот кредит — null/не задан, если по этой строке кредита нет. */
  credit?: number | null;
  purpose?: string | null;
  /** Кассовый символ банка («0200» — взнос наличной выручки). */
  cashSymbol?: string | null;
  docNo?: string | null;
  /** Ключ идемпотентности — номер документа + дата (из разбора). */
  extId: string;
  /** Номер строки в исходном файле — только для отчёта об отклонении. */
  fileRow?: number;
}

/** Строка отчёта импорта, отклонённая с причиной (та же граница ДТО/сервис, что в срезе D). */
export interface ImportBankStatementRejection {
  extId: string;
  fileRow?: number;
  reason: string;
}

/** Отчёт массового импорта выписки — одинаковый и в dryRun, и в настоящем прогоне (R-D7). */
export interface ImportBankStatementReport {
  dryRun: boolean;
  created: number;
  /** Пропущено как повтор — запись с этим (source='bank', extId) уже существует. */
  skippedRepeat: number;
  rejected: ImportBankStatementRejection[];
}

export interface FxCurrent {
  currency: string;
  rate: string;
  source: string;
  note: string | null;
  setBy: string | null;
  createdAt: Date;
}

export interface FinanceSummary {
  domain: Domain;
  today: string;
  receivables: AgingReport;
  payables: AgingReport;
  dueSoonIn: FlowListRow[];
  dueSoonOut: FlowListRow[];
  concentration: ConcentrationReport;
  months: MonthCash[];
  fx: FxCurrent[];
}

/**
 * Финансовый контур GLOBERENT — перенос модели PROMACH на реестр MYDON.
 *
 * money_flow держит и план (обязательство со сроком), и факт (платёж).
 * Агинг, «к сроку ≤ 7 дней», термометр концентрации и кэш-флоу считаются
 * чистыми функциями (finance.math.ts) — их покрывают golden-тесты: главная
 * слабость донора (деньги без тестов) не переезжает вместе с кодом.
 */
@Injectable()
export class FinanceService {
  constructor(@Inject(DB) private readonly db: Db) {}

  private async orgId(domain: Domain): Promise<string> {
    const [row] = await this.db.select({ id: org.id }).from(org).where(eq(org.code, domain));
    if (!row) {
      throw new NotFoundException(`Направление "${domain}" не заведено. Выполните pnpm db:seed.`);
    }
    return row.id;
  }

  /** Действующий курс каждой валюты — последняя запись истории. */
  async fxCurrent(): Promise<FxCurrent[]> {
    const rows = await this.db
      .select()
      .from(fxRate)
      .orderBy(desc(fxRate.createdAt))
      .limit(200);
    const latest = new Map<string, FxRow>();
    for (const r of rows) {
      if (!latest.has(r.currency)) latest.set(r.currency, r);
    }
    return [...latest.values()].map((r) => ({
      currency: r.currency,
      rate: r.rate,
      source: r.source,
      note: r.note,
      setBy: r.setBy,
      createdAt: r.createdAt,
    }));
  }

  /**
   * Задать курс вручную (PROMACH: manual override — у нас основной путь).
   * История не переписывается: каждая установка — новая строка.
   */
  async setFx(input: { currency: string; rate: number; note?: string }, actorRef = "owner"): Promise<FxCurrent[]> {
    const currency = (input.currency ?? "").toUpperCase().trim();
    if (!CURRENCY_RE.test(currency)) {
      throw new BadRequestException("Валюта — трёхбуквенный код: USD, CNY, EUR…");
    }
    if (currency === "UZS") {
      throw new BadRequestException("Курс сума к суму всегда 1 — задавать его не нужно");
    }
    if (!Number.isFinite(input.rate) || input.rate <= 0) {
      throw new BadRequestException("Курс — положительное число сумов за единицу валюты");
    }
    await this.db.transaction(async (tx) => {
      const [created] = await tx
        .insert(fxRate)
        .values({
          currency,
          rate: String(input.rate),
          source: "manual",
          note: input.note ?? null,
          setBy: actorRef,
        })
        .returning();
      await tx.insert(auditLog).values({
        actorKind: "human",
        actorRef,
        action: "finance.fx_set",
        target: currency,
        after: created,
      });
    });
    return this.fxCurrent();
  }

  /**
   * Подтянуть курсы из ЦБ РУз (коннектор cbu.uz, открытый JSON без ключа).
   * Правила решает чистый план fxRefreshPlan: ручной курс за сегодня главнее,
   * неизменившийся курс не плодит строк. История дополняется, не переписывается.
   */
  async refreshFxFromCbu(actorRef = "owner"): Promise<{
    updated: string[];
    skipped: FxRefreshSkip[];
    fx: FxCurrent[];
  }> {
    let rates: Awaited<ReturnType<typeof cbu.fetchRates>>;
    try {
      rates = await cbu.fetchRates();
    } catch (err) {
      throw new BadGatewayException(
        `ЦБ РУз (cbu.uz) не ответил: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const latest = await this.fxCurrent();
    const today = dayKey(new Date(), TZ);
    const plan = fxRefreshPlan(rates, latest, today, TZ);

    if (plan.inserts.length > 0) {
      await this.db.transaction(async (tx) => {
        for (const ins of plan.inserts) {
          await tx.insert(fxRate).values({
            currency: ins.currency,
            rate: String(ins.rate),
            source: "cbu",
            note: ins.note,
            setBy: actorRef,
          });
        }
        await tx.insert(auditLog).values({
          actorKind: actorRef.startsWith("agent") ? "agent" : "human",
          actorRef,
          action: "finance.fx_refresh",
          target: plan.inserts.map((i) => i.currency).join(","),
          after: { inserts: plan.inserts, skipped: plan.skipped },
        });
      });
    }

    return {
      updated: plan.inserts.map((i) => i.currency),
      skipped: plan.skipped,
      fx: await this.fxCurrent(),
    };
  }

  /**
   * Проверки и идемпотентность записи ДО первой записи — общая для одиночного
   * `createFlow` и массового `importBankStatement` (тот же принцип, что у
   * `StockService.prepareBatch`/`importBatches`, срез D): `dryRun` обязан
   * видеть ТОЧНО то же основание, по которому настоящий прогон решит
   * «уже была» / «создать», не дублируя проверки в двух местах.
   *
   * Идемпотентность — по `(source, extId)` (уникальный индекс
   * `money_flow_source_ext_key`, факт 4 плана среза К): не задан `extId` —
   * поведение НЕ МЕНЯЕТСЯ для всех существующих вызовов (проверка просто не
   * выполняется, до базы за ней не ходим).
   */
  private async prepareFlow(input: CreateFlowInput): Promise<
    | { kind: "existing"; row: FlowRow }
    | {
        kind: "new";
        orgId: string | null;
        currency: string;
        source: string;
        rate: number | null;
        amountUzs: number | null;
      }
  > {
    const currency = (input.currency ?? "UZS").toUpperCase().trim();
    if (!CURRENCY_RE.test(currency)) {
      throw new BadRequestException("Валюта — трёхбуквенный код: UZS, USD, CNY…");
    }
    if (!Number.isFinite(input.amount) || input.amount <= 0) {
      throw new BadRequestException("Сумма — положительное число");
    }
    if (input.status !== "planned" && input.status !== "actual") {
      throw new BadRequestException("Статус — planned (обязательство) или actual (платёж)");
    }
    if (input.category !== undefined && !(FLOW_CATEGORIES as readonly string[]).includes(input.category)) {
      throw new BadRequestException(`Категория — одна из: ${FLOW_CATEGORIES.join(", ")}`);
    }
    if (input.method !== undefined && !(METHODS as readonly string[]).includes(input.method)) {
      throw new BadRequestException("Способ — bank или cash");
    }
    if (input.dueDate !== undefined && !ISO_DAY.test(input.dueDate)) {
      throw new BadRequestException("Срок оплаты — дата в формате ГГГГ-ММ-ДД");
    }
    if (input.rate !== undefined && (!Number.isFinite(input.rate) || input.rate <= 0)) {
      throw new BadRequestException("Курс — положительное число");
    }
    // domain не задан (импорт без привязки к направлению) — orgId остаётся
    // null, а не падает NotFoundException за несуществующий "домен undefined".
    const orgId = input.domain !== undefined ? await this.orgId(input.domain) : null;

    if (input.counterpartyId !== undefined) {
      const [cp] = await this.db
        .select({ id: entity.id })
        .from(entity)
        .where(eq(entity.id, input.counterpartyId))
        .limit(1);
      if (!cp) throw new NotFoundException("Контрагент не найден в реестре");
    }

    const source = input.source ?? "manual";
    if (input.extId) {
      const [already] = await this.db
        .select()
        .from(moneyFlow)
        .where(and(eq(moneyFlow.source, source), eq(moneyFlow.extId, input.extId)))
        .limit(1);
      if (already) return { kind: "existing", row: already };
    }

    // Курс на дату операции фиксируется В ЗАПИСИ (PROMACH, миграция 083):
    // исторические суммы не плавают при смене действующего курса.
    let rate: number | null = input.rate ?? null;
    if (rate === null && currency !== "UZS") {
      const current = await this.fxCurrent();
      const found = current.find((r) => r.currency === currency);
      if (found) rate = Number(found.rate);
    }
    const amountUzs = currency === "UZS" ? null : rate !== null ? input.amount * rate : null;

    return { kind: "new", orgId, currency, source, rate, amountUzs };
  }

  /** Записать проверенную (prepareFlow → "new") заявку — вставка и след в auditLog. */
  private async writeFlow(
    input: CreateFlowInput,
    prep: Extract<Awaited<ReturnType<FinanceService["prepareFlow"]>>, { kind: "new" }>,
    actorRef: string,
  ): Promise<FlowRow> {
    return this.db.transaction(async (tx) => {
      const [created] = await tx
        .insert(moneyFlow)
        .values({
          orgId: prep.orgId,
          domain: input.domain ?? null,
          direction: input.direction,
          amount: String(input.amount),
          currency: prep.currency,
          source: prep.source,
          extId: input.extId ?? null,
          purpose: input.purpose ?? null,
          collectionId: input.collectionId ?? null,
          cashSymbol: input.cashSymbol ?? null,
          category: input.category ?? null,
          method: input.method ?? null,
          isOfficial: input.isOfficial ?? input.method !== "cash",
          rate: prep.rate !== null ? String(prep.rate) : null,
          amountUzs: prep.amountUzs !== null ? String(prep.amountUzs) : null,
          counterpartyId: input.counterpartyId ?? null,
          counterparty: input.counterparty ?? null,
          docNo: input.docNo ?? null,
          date: input.date !== undefined ? new Date(input.date) : new Date(),
          status: input.status,
          dueDate: input.dueDate ?? null,
          paidAt: input.status === "actual" ? new Date() : null,
          unitId: input.unitId ?? null,
        })
        .returning();
      await tx.insert(auditLog).values({
        actorKind: "human",
        actorRef,
        action: "finance.flow_created",
        target: created.id,
        after: created,
      });
      return created;
    });
  }

  /**
   * Завести обязательство или платёж. Курс не задан — подставляется
   * действующий. `extId` задан и запись с таким `(source, extId)` уже есть —
   * возвращается СУЩЕСТВУЮЩАЯ строка (идемпотентность массового импорта,
   * факт 4 плана среза К); для вызовов без `extId` (весь остальной код
   * сегодня) поведение не меняется ни на шаг.
   */
  async createFlow(input: CreateFlowInput, actorRef = "owner"): Promise<FlowRow> {
    const prep = await this.prepareFlow(input);
    if (prep.kind === "existing") return prep.row;
    return this.writeFlow(input, prep, actorRef);
  }

  /**
   * Массовый импорт банковской выписки (срез К, задача 4, R-K3): строки уже
   * разобраны `parseBankStatement` (`@mydon/shared`) на стороне вызывающего —
   * сюда приходят конкретные приход/расход, а не сырые ячейки. `dryRun` не
   * пишет ничего и отдаёт тот же отчёт, что настоящий прогон (принцип R-D7
   * среза D).
   *
   * ДВЕ ловушки, о которые уже спотыкался этот проект (срез D):
   *  - DTO проверяет только ТИП, не семантику — одна кривая строка не должна
   *    ронять пачку из тысяч (2440 строк живой выписки). Построчный `try`
   *    ниже — это и есть граница: `rejected` копит причины, остальные строки
   *    проходят.
   *  - Идемпотентность — ДО вставки (через `prepareFlow`/`(source, extId)`),
   *    а не через отлов ошибки уникального индекса ПОСЛЕ: иначе повторный
   *    импорт того же файла удвоил бы аудит-лог наполовину написанными
   *    транзакциями.
   */
  async importBankStatement(
    input: { dryRun?: boolean; items: ImportBankStatementItem[] },
    actorRef = "owner",
  ): Promise<ImportBankStatementReport> {
    if (input.items.length > 3000) {
      // Называем фактическое число строк — тот самый «человеческий язык»
      // из брифа. Этот отказ проверяется УЖЕ ПОСЛЕ того, как тело запроса
      // прошло лимит байт (main.ts) — там своё сообщение, там строк ещё не
      // знаем: JSON на тот момент не разобран.
      throw new BadRequestException(
        `Пачка не может быть больше 3000 строк за раз (пришло ${input.items.length})`,
      );
    }
    const dryRun = input.dryRun === true;

    let created = 0;
    let skippedRepeat = 0;
    const rejected: ImportBankStatementRejection[] = [];

    for (const item of input.items) {
      // Семантика («что считать оборотом строки») — забота сервиса, не DTO
      // (тот же урок, что и в срезе D): дебет и кредит одновременно пустые —
      // строка без движения денег, отклоняем с причиной, а не молча пропускаем.
      let direction: "in" | "out";
      let amount: number;
      // `!= null` — не только против `null`, но и против `undefined` (DTO
      // помечает оба поля необязательными: контроллер их не подставляет).
      if (item.credit != null && item.credit > 0) {
        direction = "in";
        amount = item.credit;
      } else if (item.debit != null && item.debit > 0) {
        direction = "out";
        amount = item.debit;
      } else {
        rejected.push({
          extId: item.extId,
          fileRow: item.fileRow,
          reason: "нет оборота ни по дебету, ни по кредиту — строку не с чем сопоставить",
        });
        continue;
      }

      const flowInput: CreateFlowInput = {
        direction,
        status: "actual",
        amount,
        currency: "UZS",
        source: "bank",
        extId: item.extId,
        cashSymbol: item.cashSymbol ?? null,
        purpose: item.purpose ?? undefined,
        docNo: item.docNo ?? undefined,
        date: item.date,
      };

      try {
        const prep = await this.prepareFlow(flowInput);
        if (prep.kind === "existing") {
          skippedRepeat += 1;
          continue;
        }
        if (!dryRun) await this.writeFlow(flowInput, prep, actorRef);
        created += 1;
      } catch (e) {
        rejected.push({
          extId: item.extId,
          fileRow: item.fileRow,
          reason: e instanceof Error ? e.message : String(e),
        });
      }
    }

    return { dryRun, created, skippedRepeat, rejected };
  }

  private static readonly ДАТА_RE = /^\d{4}-\d{2}-\d{2}$/;

  /**
   * Сверка кассы за период (R-K6, шаг 3 задачи 4): изъято по системе
   * (инкассации, `collection.status <> 'cancelled'`, по `collectedAt` —
   * деньги покидают автомат в момент сбора, тот же выбор, что в
   * `CollectionsService.reconcile`) против сдано в банк (`money_flow` с
   * `cashSymbol = '0200'`, по дате операции). Математика — чистая функция
   * `cashReconcile` (`finance.math.ts`): периоды помесячно, разрыв — там, где
   * ровно ОДНА сторона пуста (факт 9 плана среза К).
   *
   * `amount is not null` здесь БЫЛ фильтром запроса — и это ровно тот баг из
   * ревью 1.2 (симптом 3): месяц, где инкассации ЕСТЬ, но ВСЕ ещё «ждут
   * приёма» (сумма не введена), терял их из выборки целиком и кодировался как
   * `noWithdrawn` («инкассаций нет вовсе») на здоровой системе. Фильтр снят —
   * инкассации с `amount = null` идут в `cashReconcileMath` как есть (`amount:
   * null`), а различать «не собирали» от «собрали, но не приняли» — забота
   * чистой функции (см. `CashMovement`/`pendingReceipt`).
   */
  async cashReconcile(from: string, to: string): Promise<CashReconcileReport> {
    if (!FinanceService.ДАТА_RE.test(from) || !FinanceService.ДАТА_RE.test(to)) {
      throw new BadRequestException("Период задаётся датами вида ГГГГ-ММ-ДД: ?from=2026-06-01&to=2026-08-21");
    }
    if (from > to) {
      throw new BadRequestException(`Начало периода (${from}) позже конца (${to})`);
    }
    const fromTs = new Date(`${from}T00:00:00+05:00`);
    const toTs = new Date(`${to}T23:59:59.999+05:00`);

    const [collections, deposits] = await Promise.all([
      this.db
        .select({ collectedAt: collection.collectedAt, amount: collection.amount })
        .from(collection)
        .where(
          and(
            ne(collection.status, "cancelled"),
            gte(collection.collectedAt, fromTs),
            lte(collection.collectedAt, toTs),
          ),
        ),
      this.db
        .select({ date: moneyFlow.date, amount: moneyFlow.amount })
        .from(moneyFlow)
        .where(and(eq(moneyFlow.cashSymbol, "0200"), gte(moneyFlow.date, fromTs), lte(moneyFlow.date, toTs))),
    ]);

    return cashReconcileMath(
      collections.map((c) => ({ date: c.collectedAt, amount: c.amount !== null ? Number(c.amount) : null })),
      deposits.map((d) => ({ date: d.date, amount: Number(d.amount) })),
      from,
      to,
      TZ,
    );
  }

  /** Отметить обязательство оплаченным: план становится фактом, след — в журнале. */
  async markPaid(id: string, opts: { rate?: number } = {}, actorRef = "owner"): Promise<FlowRow> {
    if (opts.rate !== undefined && (!Number.isFinite(opts.rate) || opts.rate <= 0)) {
      throw new BadRequestException("Курс — положительное число");
    }
    return this.db.transaction(async (tx) => {
      const [row] = await tx.select().from(moneyFlow).where(eq(moneyFlow.id, id)).for("update");
      if (!row) throw new NotFoundException("Запись не найдена");
      if (row.status !== "planned") {
        throw new BadRequestException(`Запись уже закрыта (${row.status})`);
      }
      const rate = opts.rate !== undefined ? opts.rate : row.rate !== null ? Number(row.rate) : null;
      const amountUzs =
        row.currency === "UZS"
          ? null
          : rate !== null
            ? Number(row.amount) * rate
            : row.amountUzs !== null
              ? Number(row.amountUzs)
              : null;
      const [updated] = await tx
        .update(moneyFlow)
        .set({
          status: "actual",
          paidAt: new Date(),
          rate: rate !== null ? String(rate) : null,
          amountUzs: amountUzs !== null ? String(amountUzs) : null,
        })
        .where(eq(moneyFlow.id, id))
        .returning();
      await tx.insert(auditLog).values({
        actorKind: "human",
        actorRef,
        action: "finance.flow_paid",
        target: id,
        before: row,
        after: updated,
      });
      return updated;
    });
  }

  /** Отмена ошибочной записи. Строка остаётся — из сводов уходит. */
  async cancelFlow(id: string, actorRef = "owner"): Promise<FlowRow> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx.select().from(moneyFlow).where(eq(moneyFlow.id, id)).for("update");
      if (!row) throw new NotFoundException("Запись не найдена");
      if (row.status === "cancelled") {
        throw new BadRequestException("Запись уже отменена");
      }
      const [updated] = await tx
        .update(moneyFlow)
        .set({ status: "cancelled" })
        .where(eq(moneyFlow.id, id))
        .returning();
      await tx.insert(auditLog).values({
        actorKind: "human",
        actorRef,
        action: "finance.flow_cancelled",
        target: id,
        before: row,
        after: updated,
      });
      return updated;
    });
  }

  /** Лента записей направления с именами контрагентов. */
  async flows(
    domain: Domain,
    opts: { status?: "planned" | "actual" | "cancelled"; direction?: "in" | "out"; limit?: number } = {},
  ): Promise<FlowListRow[]> {
    const orgId = await this.orgId(domain);
    const conditions = [eq(moneyFlow.orgId, orgId)];
    if (opts.status !== undefined) conditions.push(eq(moneyFlow.status, opts.status));
    if (opts.direction !== undefined) conditions.push(eq(moneyFlow.direction, opts.direction));
    const limit = Math.min(Math.max(opts.limit ?? 200, 1), 500);
    const rows = await this.db
      .select({ flow: moneyFlow, counterpartyEntityName: entity.name })
      .from(moneyFlow)
      .leftJoin(entity, eq(entity.id, moneyFlow.counterpartyId))
      .where(and(...conditions))
      .orderBy(desc(moneyFlow.date))
      .limit(limit);
    return rows.map((r) => ({
      ...r.flow,
      counterpartyEntityName: r.counterpartyEntityName,
      uzs: uzsEquivalent(r.flow),
    }));
  }

  /** Финансовый свод направления: агинг, «к сроку», термометр, кэш-флоу, курс. */
  async summary(domain: Domain): Promise<FinanceSummary> {
    const orgId = await this.orgId(domain);
    const today = dayKey(new Date(), TZ);
    const yearAgo = new Date();
    yearAgo.setDate(yearAgo.getDate() - 366);

    // Открытые планы нужны все (долг живёт годами), факты — за 12 месяцев.
    const rows = await this.db
      .select({ flow: moneyFlow, counterpartyEntityName: entity.name })
      .from(moneyFlow)
      .leftJoin(entity, eq(entity.id, moneyFlow.counterpartyId))
      .where(
        and(
          eq(moneyFlow.orgId, orgId),
          sql`(${moneyFlow.status} = 'planned' or (${moneyFlow.status} = 'actual' and ${moneyFlow.date} >= ${yearAgo}))`,
        ),
      )
      .orderBy(desc(moneyFlow.date))
      .limit(5000);

    const forMath: (FlowForMath & { row: FlowListRow })[] = rows.map((r) => ({
      id: r.flow.id,
      direction: r.flow.direction,
      status: r.flow.status,
      amount: r.flow.amount,
      currency: r.flow.currency,
      rate: r.flow.rate,
      amountUzs: r.flow.amountUzs,
      dueDate: r.flow.dueDate,
      date: r.flow.date,
      counterpartyKey: r.flow.counterpartyId ?? r.flow.counterparty,
      counterpartyName: r.counterpartyEntityName ?? r.flow.counterparty,
      row: { ...r.flow, counterpartyEntityName: r.counterpartyEntityName, uzs: uzsEquivalent(r.flow) },
    }));

    const soonIn = dueSoon(forMath, "in", today, 7);
    const soonOut = dueSoon(forMath, "out", today, 7);
    const pick = (list: FlowForMath[]): FlowListRow[] =>
      list.map((f) => (f as FlowForMath & { row: FlowListRow }).row);

    return {
      domain,
      today,
      receivables: aging(forMath, "in", today),
      payables: aging(forMath, "out", today),
      dueSoonIn: pick(soonIn),
      dueSoonOut: pick(soonOut),
      concentration: concentration(forMath),
      months: byMonth(forMath, TZ, 12),
      fx: await this.fxCurrent(),
    };
  }

  /** Контрагенты направления — кандидаты привязки записи. */
  async counterpartyCandidates(domain: Domain): Promise<{ id: string; name: string; inn: string | null }[]> {
    const orgId = await this.orgId(domain);
    const rows = await this.db
      .select({ id: entity.id, name: entity.name, inn: entity.externalRef })
      .from(entity)
      .where(and(eq(entity.orgId, orgId), inArray(entity.type, ["contractor", "counterparty", "supplier"])))
      .orderBy(entity.name)
      .limit(500);
    return rows;
  }
}
