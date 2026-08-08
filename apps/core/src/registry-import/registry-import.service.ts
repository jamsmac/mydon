import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import {
  auditLog,
  contractAct,
  entity,
  globerentUnit,
  grContract,
  moneyFlow,
  org,
} from "@mydon/db";
import { MONEY_CATEGORIES,
  entityNameProblem,
} from "@mydon/shared";
import { and, eq, inArray, isNotNull, isNull, like, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { DB, type Db } from "../db/db.module";

/**
 * Импорт реестра GLOBERENT из рабочей книги владельца (xlsx «2020–2025»).
 *
 * Книга — источник владельца, поэтому карточки создаются УТВЕРЖДЁННЫМИ
 * (approvedBy: owner), но с createdFrom — провенанс «откуда запись» остаётся
 * виден в карточке и аудите.
 *
 * Идемпотентность — на стороне SQL, а не клиента: контрагент по ИНН,
 * счёт-фактура по externalRef, модель по нормализованному имени, единица
 * по VIN. Повторный прогон импортёра ничего не задваивает.
 *
 * Исторические единицы входят сразу в конечном статусе (IN_STOCK /
 * DELIVERED_TO_CLIENT) — конвейерные события по прошлому не эмитятся,
 * след остаётся в audit_log одной записью на партию.
 */

export interface ImportContractor {
  name: string;
  inn: string;
  /** Другие написания из книги («АГМК», «OLMALIQ KON-METALLURGIYA…»). */
  aliases?: string[];
  clientType?: "legal" | "individual";
}

export interface ImportInvoice {
  /** Ключ идемпотентности, например «СФ 2026-12». */
  ref: string;
  name: string;
  attrs: Record<string, unknown>;
}

export interface ImportUnit {
  name: string;
  vin: string;
  modelName?: string;
  status: "IN_STOCK" | "DELIVERED_TO_CLIENT";
  /** YYYY-MM-DD. */
  arrivalDate?: string;
  declarationNumber?: string;
  /** YYYY-MM-DD. */
  declarationDate?: string;
  salesPrice?: number;
  /** ИНН покупателя — свяжем по карточке контрагента, не по строке. */
  clientInn?: string;
  notes?: string;
}

export interface ImportPayload {
  /** Откуда данные — попадает в createdFrom каждой карточки. */
  source?: string;
  contractors?: ImportContractor[];
  invoices?: ImportInvoice[];
  models?: { name: string }[];
  units?: ImportUnit[];
  /**
   * Реквизиты своей компании (продавец договорного DOCX). Карточка
   * own_company в направлении одна: существующая НЕ перезаписывается —
   * правки владельца из панели важнее сида.
   */
  ownCompany?: { name: string; attrs: Record<string, unknown> };
  flows?: ImportFlow[];
  contracts?: ImportContract[];
  /**
   * «Партии кончились, можно убирать устаревшее». Ставится на последней
   * партии. САМ ПО СЕБЕ НЕ ЗАДАЁТ НАБОР: последняя партия — это её сотня
   * договоров, а не все. Что считать набором, говорит contractsKeep.
   */
  contractsFinal?: boolean;
  /**
   * Полный список номеров договоров во ВСЕЙ выгрузке — по нему решается,
   * какие свои карточки устарели. Без него набором считается сама партия:
   * это верно, только когда партия одна. Импортёр обязан передавать список,
   * иначе разбиение на партии превращается в снос всего, кроме последней.
   */
  contractsKeep?: string[];
}

/**
 * Историческая денежная запись (money_flow, status=actual): приход по
 * счетам-фактурам книги и сервисные расходы. Суммы всегда в сумах —
 * валютных операций реестр счетов не несёт.
 */
export interface ImportFlow {
  direction: "in" | "out";
  amount: number;
  /** Из словаря MONEY_CATEGORIES (sale | service | rent | other…). */
  category: string;
  /** YYYY-MM-DD — дата документа. */
  date: string;
  purpose: string;
  /** Ключ идемпотентности вместе с purpose, например «СФ 2026-5». */
  docNo: string;
  method?: "bank" | "cash";
  isOfficial?: boolean;
  counterpartyInn?: string;
  counterpartyName?: string;
  /** Серийник машины — свяжем по карточке единицы, не по строке. */
  unitVin?: string;
}

/**
 * Договор с покупателем из реестра Didox (исходящие «Договор (НК)»).
 * Статус проставляет генератор сида: closed — отгрузка по СФ покрыла сумму,
 * active — остаток виден владельцу. flowDocNos — docNo приходов money_flow
 * (СФ по этому договору): импорт привяжет их через contract_id, чтобы
 * paidUzs договора и сигнал брифинга «без оплаты» считались по факту.
 */
export interface ImportContract {
  contractNo: string;
  /** YYYY-MM-DD. */
  contractDate: string;
  buyerName: string;
  buyerInn?: string;
  totalWithVat: number;
  totalVat?: number;
  status?: "active" | "closed";
  /** Из «Номер документа» Didox: «купля-продажа», «на сервисное обслуживание»… */
  subject?: string | null;
  /** Строки Didox, из которых собрана сумма, — провенанс в docParams. */
  didoxRows?: { doc: string; date: string | null; totalWithVat: number }[];
  didoxDuplicatesDropped?: number;
  extraDates?: string[];
  invoicedTotal?: number;
  flowDocNos?: string[];
}

/**
 * Связка «приход → договор», у которой плательщик и покупатель — разные
 * компании. Импорт такие больше не ставит (запрет в WHERE привязки), но
 * старые остались от прошлого разбора: их видно отчётом и снимают отдельно.
 * Обе стороны названы поимённо с ИНН — иначе решать, что снимать, не по чему.
 */
export interface ForeignContractLink {
  flowId: string;
  docNo: string | null;
  /** ГГГГ-ММ-ДД. */
  date: string;
  /** В сумах: amountUzs, если запись валютная, иначе amount. */
  amountUzs: string;
  currency: string;
  purpose: string | null;
  payer: { name: string; inn: string | null };
  contractId: string;
  contractNo: string;
  contractDate: string;
  buyer: { name: string; inn: string | null };
}

export interface UnlinkForeignResult {
  /** Снятые связки — поимённо, чтобы отчёт инструмента совпадал с фактом. */
  unlinked: { docNo: string | null; contractNo: string }[];
  /** Просьбы, под которые в базе не нашлось чужой связки (уже сняли, ошибка id). */
  skipped: number;
}

export interface ImportCount {
  created: number;
  skipped: number;
}

export interface ImportSummary {
  contractors: ImportCount;
  invoices: ImportCount;
  models: ImportCount;
  units: ImportCount & { errors: string[] };
  ownCompany: ImportCount;
  flows: ImportCount & { errors: string[] };
  contracts: ImportCount & {
    errors: string[];
    flowsLinked: number;
    updated: number;
    deleted: number;
  };
}

const UNIT_STATUSES_ALLOWED = ["IN_STOCK", "DELIVERED_TO_CLIENT"] as const;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const INN_RE = /^\d{9}$|^\d{14}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** День операции строкой: в отчёт уходит дата, а не момент с зоной. */
function isoDay(value: Date | string): string {
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
}

/** Ключ сравнения имён моделей: регистр и лишние пробелы не различаются. */
export function modelKey(name: string): string {
  return name.replace(/\s+/g, " ").trim().toLowerCase();
}

/** Проверка денежной записи ДО базы: null — можно, строка — почему нельзя. */
export function flowImportError(f: ImportFlow): string | null {
  const tag = `«${f.docNo ?? "?"}»`;
  if (f.direction !== "in" && f.direction !== "out") return `${tag}: направление in или out`;
  if (!Number.isFinite(f.amount) || f.amount <= 0) return `${tag}: сумма — число больше нуля`;
  if (!(MONEY_CATEGORIES as readonly string[]).includes(f.category)) {
    return `${tag}: категория «${f.category}» не из словаря MONEY_CATEGORIES`;
  }
  if (!ISO_DAY.test(f.date ?? "")) return `${tag}: дата не ГГГГ-ММ-ДД: «${f.date}»`;
  if ((f.docNo ?? "").trim().length === 0) return "запись без docNo — идемпотентности не будет";
  if ((f.purpose ?? "").trim().length === 0) return `${tag}: пустое назначение`;
  return null;
}

/** Проверка договора ДО базы: null — можно, строка — почему нельзя. */
export function contractImportError(c: ImportContract): string | null {
  const tag = `«${c.contractNo ?? "?"}»`;
  if ((c.contractNo ?? "").trim().length === 0)
    return "договор без номера — идемпотентности не будет";
  if (!ISO_DAY.test(c.contractDate ?? "")) return `${tag}: дата не ГГГГ-ММ-ДД: «${c.contractDate}»`;
  if ((c.buyerName ?? "").trim().length < 2) return `${tag}: нет покупателя`;
  if (!Number.isFinite(c.totalWithVat) || c.totalWithVat <= 0)
    return `${tag}: сумма — число больше нуля`;
  if (c.status !== undefined && c.status !== "active" && c.status !== "closed") {
    return `${tag}: статус импорта только active или closed, а не «${c.status}»`;
  }
  return null;
}

/** Проверка единицы ДО базы: null — можно, строка — почему нельзя (словами). */
export function unitImportError(u: ImportUnit): string | null {
  if ((u.name ?? "").trim().length < 2) return "нет названия";
  if ((u.vin ?? "").trim().length === 0) return `«${u.name}»: пустой серийник`;
  if (!(UNIT_STATUSES_ALLOWED as readonly string[]).includes(u.status)) {
    return `«${u.name}»: статус импорта только IN_STOCK или DELIVERED_TO_CLIENT, а не «${u.status}»`;
  }
  if (u.arrivalDate !== undefined && !ISO_DAY.test(u.arrivalDate)) {
    return `«${u.name}»: дата прихода не ГГГГ-ММ-ДД: «${u.arrivalDate}»`;
  }
  if (u.declarationDate !== undefined && !ISO_DAY.test(u.declarationDate)) {
    return `«${u.name}»: дата ГТД не ГГГГ-ММ-ДД: «${u.declarationDate}»`;
  }
  if (u.salesPrice !== undefined && (!Number.isFinite(u.salesPrice) || u.salesPrice <= 0)) {
    return `«${u.name}»: цена продажи — число больше нуля`;
  }
  return null;
}

@Injectable()
export class RegistryImportService {
  constructor(@Inject(DB) private readonly db: Db) {}

  private async orgId(): Promise<string> {
    const [row] = await this.db.select({ id: org.id }).from(org).where(eq(org.code, "globerent"));
    if (!row)
      throw new NotFoundException("Направление globerent не заведено. Выполните pnpm db:seed.");
    return row.id;
  }

  async importGloberent(payload: ImportPayload, actorRef = "owner"): Promise<ImportSummary> {
    const source = (payload.source ?? "").trim() || "импорт книги владельца";
    const orgId = await this.orgId();
    const summary: ImportSummary = {
      contractors: { created: 0, skipped: 0 },
      invoices: { created: 0, skipped: 0 },
      models: { created: 0, skipped: 0 },
      units: { created: 0, skipped: 0, errors: [] },
      ownCompany: { created: 0, skipped: 0 },
      flows: { created: 0, skipped: 0, errors: [] },
      contracts: { created: 0, skipped: 0, errors: [], flowsLinked: 0, updated: 0, deleted: 0 },
    };

    if (payload.contractors?.length) {
      summary.contractors = await this.importContractors(
        orgId,
        payload.contractors,
        source,
        actorRef,
      );
    }
    if (payload.invoices?.length) {
      summary.invoices = await this.importInvoices(orgId, payload.invoices, source, actorRef);
    }
    if (payload.models?.length) {
      summary.models = await this.importModels(orgId, payload.models, source, actorRef);
    }
    if (payload.units?.length) {
      const r = await this.importUnits(orgId, payload.units, source, actorRef);
      summary.units = r;
    }
    if (payload.ownCompany !== undefined) {
      summary.ownCompany = await this.importOwnCompany(orgId, payload.ownCompany, source, actorRef);
    }
    if (payload.flows?.length) {
      summary.flows = await this.importFlows(orgId, payload.flows, source, actorRef);
    }
    // Договоры — после flows: привязка приходов ждёт сами записи денег.
    if (payload.contracts?.length) {
      summary.contracts = await this.importContracts(
        orgId,
        payload.contracts,
        source,
        actorRef,
        payload.contractsFinal ?? false,
        payload.contractsKeep,
      );
    }
    return summary;
  }

  /**
   * Договоры покупателей из Didox.
   *
   * Своя запись (createdFrom начинается с источника Didox) — обновляется:
   * сумма, статус, покупатель и провенанс пересчитываются при каждом прогоне,
   * потому что разбор выгрузки уточняется. Заведённая владельцем вручную
   * (createdFrom пуст или другой) — не трогается никогда.
   *
   * contractsFinal=true — «партии кончились, убирай устаревшее». НАБОР при
   * этом задаёт keepNos (полный список номеров всей выгрузки), а не сама
   * партия: партия — это её сотня договоров, и считать набором её значит
   * снести всё остальное. Удаление щадящее: договор с актами или
   * привязанными единицами остаётся жить (с ним уже работали).
   */
  private async importContracts(
    orgId: string,
    rows: ImportContract[],
    source: string,
    actorRef: string,
    final: boolean,
    keepNos: string[] | undefined,
  ): Promise<
    ImportCount & { errors: string[]; flowsLinked: number; updated: number; deleted: number }
  > {
    const errors: string[] = [];
    const valid: ImportContract[] = [];
    for (const c of rows) {
      const err = contractImportError(c);
      if (err !== null) errors.push(err);
      else valid.push(c);
    }

    // Метка своих записей: провенанс начинается с названия источника до двоеточия
    // («Didox»), поэтому уточнение текста источника не рвёт связь с прошлым прогоном.
    const ownPrefix = `${source.split(":")[0].trim()}%`;
    const mine = await this.db
      .select({ id: grContract.id, no: grContract.contractNo })
      .from(grContract)
      .where(
        and(
          eq(grContract.orgId, orgId),
          isNotNull(grContract.createdFrom),
          like(grContract.createdFrom, ownPrefix),
        ),
      );
    const mineIds = new Set(mine.map((e) => e.id));

    const nos = valid.map((c) => c.contractNo.trim());
    const existing = nos.length
      ? await this.db
          .select({ id: grContract.id, no: grContract.contractNo })
          .from(grContract)
          .where(and(eq(grContract.orgId, orgId), inArray(grContract.contractNo, nos)))
      : [];
    const idByNo = new Map(existing.map((e) => [e.no, e.id]));

    const inns = [...new Set(valid.map((c) => c.buyerInn).filter((s): s is string => !!s))];
    const clientRows = inns.length
      ? await this.db
          .select({ id: entity.id, ref: entity.externalRef })
          .from(entity)
          .where(and(eq(entity.type, "contractor"), inArray(entity.externalRef, inns)))
      : [];
    const clientByInn = new Map(clientRows.map((c) => [c.ref, c.id]));

    const [seller] = await this.db
      .select({ id: entity.id })
      .from(entity)
      .where(and(eq(entity.orgId, orgId), eq(entity.type, "own_company")));

    let created = 0;
    let updated = 0;
    let skipped = 0;
    let deleted = 0;
    let flowsLinked = 0;
    await this.db.transaction(async (tx) => {
      // Уборка идёт ПЕРВОЙ: карточки прошлого разбора держат на себе приходы,
      // и пока они живы, привязка ниже видит эти приходы занятыми и проходит
      // мимо. Снести сначала — значит вернуть приходы в оборот к тому же
      // прогону, а не оставить их без договора до следующего.
      if (final) {
        // Набор — весь список выгрузки, а не эта партия. Без списка набором
        // считается партия: верно только когда партия одна.
        const keep = new Set(
          (keepNos ?? valid.map((c) => c.contractNo)).map((no) => no.trim()).filter((no) => no),
        );
        const stale = mine.filter((m) => !keep.has(m.no));
        // Признак потерянного набора: он и сам мал против того, что уже есть,
        // И снёс бы больше половины карточек. Именно так выглядит неполный
        // список — оборванная выгрузка, партия вместо всего набора. Уточнение
        // разбора выглядит иначе: набор остаётся большим, лишними становятся
        // мусорные карточки прошлой версии. Такое чинят, а не применяют.
        const lostSet = keep.size < mine.length / 2 && stale.length > mine.length / 2;
        if (lostSet && stale.length > 10) {
          errors.push(
            `уборка отменена: набор из ${keep.size} договоров оставил бы ${stale.length} ` +
              `из ${mine.length} карточек лишними — так выглядит неполная выгрузка, а не уточнение`,
          );
        } else {
          for (const s of stale) {
            const [{ n: acts }] = await tx
              .select({ n: sql<number>`count(*)::int` })
              .from(contractAct)
              .where(eq(contractAct.contractId, s.id));
            const [{ n: units }] = await tx
              .select({ n: sql<number>`count(*)::int` })
              .from(globerentUnit)
              .where(eq(globerentUnit.contractId, s.id));
            if (acts > 0 || units > 0) {
              errors.push(`«${s.no}»: карточка устарела, но с ней работали — оставлена`);
              continue;
            }
            await tx
              .update(moneyFlow)
              .set({ contractId: null })
              .where(eq(moneyFlow.contractId, s.id));
            await tx.delete(grContract).where(eq(grContract.id, s.id));
            deleted += 1;
          }
        }
      }

      for (const c of valid) {
        const no = c.contractNo.trim();
        const fields = {
          contractDate: c.contractDate,
          clientId: c.buyerInn !== undefined ? (clientByInn.get(c.buyerInn) ?? null) : null,
          buyer: {
            name: c.buyerName.trim(),
            ...(c.buyerInn !== undefined ? { inn: c.buyerInn } : {}),
          },
          totalWithVat: String(c.totalWithVat),
          totalVat: String(c.totalVat ?? 0),
          status: c.status ?? "active",
          docParams: {
            didox: {
              ...(c.subject !== undefined && c.subject !== null ? { subject: c.subject } : {}),
              ...(c.didoxRows !== undefined ? { rows: c.didoxRows } : {}),
              ...(c.didoxDuplicatesDropped !== undefined
                ? { duplicatesDropped: c.didoxDuplicatesDropped }
                : {}),
              ...(c.extraDates !== undefined ? { extraDates: c.extraDates } : {}),
              ...(c.invoicedTotal !== undefined ? { invoicedTotal: c.invoicedTotal } : {}),
            },
          },
        };
        let contractId = idByNo.get(no);
        if (contractId === undefined) {
          const [inserted] = await tx
            .insert(grContract)
            .values({
              orgId,
              domain: "globerent",
              contractNo: no,
              sellerCompanyId: seller?.id ?? null,
              createdFrom: source,
              ...fields,
            })
            .returning({ id: grContract.id });
          contractId = inserted.id;
          idByNo.set(no, contractId);
          created += 1;
        } else if (mineIds.has(contractId)) {
          await tx
            .update(grContract)
            .set({ ...fields, createdFrom: source, updatedAt: new Date() })
            .where(eq(grContract.id, contractId));
          updated += 1;
        } else {
          skipped += 1;
        }
        if (c.flowDocNos?.length) {
          // Приход одной компании на договоре другой — неверная дебиторка
          // сразу у обоих: у одного долг из воздуха, у второго закрытый.
          // Сид такие связки уже приносил, поэтому запрет живёт здесь, а не
          // только в разборе: данные можно пересобрать любым инструментом,
          // инвариант базы — нельзя. Приход без контрагента не противоречит
          // договору, его привязать можно.
          const ownMoney =
            fields.clientId !== null
              ? or(isNull(moneyFlow.counterpartyId), eq(moneyFlow.counterpartyId, fields.clientId))
              : undefined;
          const linked = await tx
            .update(moneyFlow)
            .set({ contractId })
            .where(
              and(
                eq(moneyFlow.orgId, orgId),
                inArray(moneyFlow.docNo, c.flowDocNos),
                isNull(moneyFlow.contractId),
                ...(ownMoney !== undefined ? [ownMoney] : []),
              ),
            )
            .returning({ id: moneyFlow.id });
          flowsLinked += linked.length;
        }
      }

      // Запрет выше не пускает НОВЫЕ чужие связки, но старые он не расцепит:
      // их ставил прошлый разбор, и в базе они остались. Молча снимать нельзя —
      // руками владельца могла быть проставлена любая из них. Поэтому импорт
      // не чинит, а называет: приход такой-то стоит на договоре чужой компании.
      // Только на последней партии: проверка смотрит на всю базу, и на каждой
      // партии она повторила бы один и тот же список слово в слово.
      const foreign = final
        ? await tx
            .select({ docNo: moneyFlow.docNo, no: grContract.contractNo })
            .from(moneyFlow)
            .innerJoin(grContract, eq(moneyFlow.contractId, grContract.id))
            .where(
              and(
                eq(moneyFlow.orgId, orgId),
                isNotNull(moneyFlow.counterpartyId),
                isNotNull(grContract.clientId),
                sql`${moneyFlow.counterpartyId} <> ${grContract.clientId}`,
              ),
            )
        : [];
      for (const f of foreign) {
        errors.push(`приход «${f.docNo}» стоит на договоре «${f.no}» другой компании — проверьте`);
      }

      if (created > 0 || updated > 0 || deleted > 0 || flowsLinked > 0) {
        await tx.insert(auditLog).values({
          actorKind: "human",
          actorRef,
          action: "registry_import.contracts",
          target: source,
          after: {
            created,
            updated,
            deleted,
            skipped,
            flowsLinked,
            foreignLinks: foreign.length,
            errors: errors.length,
          },
        });
      }
    });

    return { created, updated, deleted, skipped, errors, flowsLinked };
  }

  /**
   * Чужие связки «приход → договор», которые уже лежат в базе.
   *
   * Импорт про них говорит одной строкой на каждую — этого хватает заметить,
   * но не хватает решить. Здесь обе стороны названы с ИНН и суммой: видно,
   * у кого долг из воздуха, а у кого закрытый, и на какие деньги.
   *
   * Чтение — не чинит ничего. Снятие отдельной ручкой и отдельным решением.
   */
  async foreignContractLinks(): Promise<ForeignContractLink[]> {
    return this.foreignLinks(await this.orgId());
  }

  private async foreignLinks(orgId: string): Promise<ForeignContractLink[]> {
    const payer = alias(entity, "payer");
    const buyer = alias(entity, "buyer");
    const rows = await this.db
      .select({
        flowId: moneyFlow.id,
        docNo: moneyFlow.docNo,
        date: moneyFlow.date,
        amount: moneyFlow.amount,
        amountUzs: moneyFlow.amountUzs,
        currency: moneyFlow.currency,
        purpose: moneyFlow.purpose,
        payerName: payer.name,
        payerInn: payer.externalRef,
        contractId: grContract.id,
        contractNo: grContract.contractNo,
        contractDate: grContract.contractDate,
        buyerName: buyer.name,
        buyerInn: buyer.externalRef,
      })
      .from(moneyFlow)
      // Обе стороны — через inner join: связка «чужая» только когда известны
      // и плательщик прихода, и покупатель договора. Одна сторона без карточки
      // ничему не противоречит, и в отчёте ей делать нечего.
      .innerJoin(grContract, eq(moneyFlow.contractId, grContract.id))
      .innerJoin(payer, eq(moneyFlow.counterpartyId, payer.id))
      .innerJoin(buyer, eq(grContract.clientId, buyer.id))
      .where(
        and(eq(moneyFlow.orgId, orgId), sql`${moneyFlow.counterpartyId} <> ${grContract.clientId}`),
      );
    return rows.map((r) => ({
      flowId: r.flowId,
      docNo: r.docNo,
      date: isoDay(r.date),
      amountUzs: r.amountUzs ?? r.amount,
      currency: r.currency,
      purpose: r.purpose,
      payer: { name: r.payerName, inn: r.payerInn },
      contractId: r.contractId,
      contractNo: r.contractNo,
      contractDate: isoDay(r.contractDate),
      buyer: { name: r.buyerName, inn: r.buyerInn },
    }));
  }

  /**
   * Снять названные связки — только те, что действительно чужие.
   *
   * Инвариант проверяется в самом UPDATE, а не перед ним: список id приходит
   * снаружи и мог устареть между отчётом и решением. Промах по id должен
   * оказаться ничем (skipped), а не расцепленным нормальным приходом.
   *
   * Отвязка не удаляет деньги: приход остаётся, у него лишь пропадает
   * contract_id — и следующий импорт поставит его на верный договор сам,
   * потому что привязка ищет записи именно с пустым contract_id.
   */
  async unlinkForeignContractLinks(
    flowIds: string[],
    actorRef = "owner",
  ): Promise<UnlinkForeignResult> {
    const ids = [...new Set(flowIds.map((s) => String(s).trim()))].filter((s) => s.length > 0);
    const bad = ids.filter((s) => !UUID_RE.test(s));
    if (bad.length > 0) {
      throw new BadRequestException(`Не идентификаторы приходов: ${bad.slice(0, 3).join(", ")}`);
    }
    if (ids.length === 0) return { unlinked: [], skipped: 0 };

    const orgId = await this.orgId();
    // Номер договора нужен для отчёта, а после UPDATE его уже не спросить —
    // contract_id к тому моменту пуст. Поэтому снимок берётся до.
    const before = new Map(
      (await this.foreignLinks(orgId)).map((l) => [l.flowId, l.contractNo] as const),
    );

    const unlinked = await this.db.transaction(async (tx) => {
      const rows = await tx
        .update(moneyFlow)
        .set({ contractId: null })
        .where(
          and(
            eq(moneyFlow.orgId, orgId),
            inArray(moneyFlow.id, ids),
            isNotNull(moneyFlow.counterpartyId),
            sql`exists (select 1 from ${grContract} where ${grContract.id} = ${moneyFlow.contractId}
                 and ${grContract.clientId} is not null
                 and ${grContract.clientId} <> ${moneyFlow.counterpartyId})`,
          ),
        )
        .returning({ id: moneyFlow.id, docNo: moneyFlow.docNo });
      if (rows.length > 0) {
        await tx.insert(auditLog).values({
          actorKind: "human",
          actorRef,
          action: "registry_import.unlink_foreign",
          target: "globerent",
          after: {
            unlinked: rows.map((r) => ({
              docNo: r.docNo,
              contractNo: before.get(r.id) ?? null,
            })),
            asked: ids.length,
          },
        });
      }
      return rows;
    });

    return {
      unlinked: unlinked.map((r) => ({ docNo: r.docNo, contractNo: before.get(r.id) ?? "" })),
      skipped: ids.length - unlinked.length,
    };
  }

  /**
   * Исторические денежные записи (приход по счетам, сервисные расходы).
   * Идемпотентность — по паре docNo+purpose: повторный прогон не задваивает
   * кэш-флоу. Всё в сумах, status=actual, связи контрагент/машина — по FK.
   */
  private async importFlows(
    orgId: string,
    rows: ImportFlow[],
    source: string,
    actorRef: string,
  ): Promise<ImportCount & { errors: string[] }> {
    const errors: string[] = [];
    const valid: ImportFlow[] = [];
    for (const f of rows) {
      const err = flowImportError(f);
      if (err !== null) errors.push(err);
      else valid.push(f);
    }

    const docNos = [...new Set(valid.map((f) => f.docNo))];
    const existing = docNos.length
      ? await this.db
          .select({ docNo: moneyFlow.docNo, purpose: moneyFlow.purpose })
          .from(moneyFlow)
          .where(and(eq(moneyFlow.orgId, orgId), inArray(moneyFlow.docNo, docNos)))
      : [];
    const seen = new Set(existing.map((e) => `${e.docNo}|${e.purpose}`));

    const inns = [...new Set(valid.map((f) => f.counterpartyInn).filter((s): s is string => !!s))];
    const cpRows = inns.length
      ? await this.db
          .select({ id: entity.id, ref: entity.externalRef })
          .from(entity)
          .where(and(eq(entity.type, "contractor"), inArray(entity.externalRef, inns)))
      : [];
    const cpByInn = new Map(cpRows.map((c) => [c.ref, c.id]));

    const vins = [...new Set(valid.map((f) => f.unitVin).filter((s): s is string => !!s))];
    const unitRows = vins.length
      ? await this.db
          .select({ id: globerentUnit.id, vin: globerentUnit.vin })
          .from(globerentUnit)
          .where(and(eq(globerentUnit.orgId, orgId), inArray(globerentUnit.vin, vins)))
      : [];
    const unitByVin = new Map(unitRows.map((u) => [u.vin, u.id]));

    let created = 0;
    let skipped = 0;
    await this.db.transaction(async (tx) => {
      for (const f of valid) {
        const key = `${f.docNo}|${f.purpose}`;
        if (seen.has(key)) {
          skipped += 1;
          continue;
        }
        seen.add(key);
        await tx.insert(moneyFlow).values({
          orgId,
          domain: "globerent",
          direction: f.direction,
          status: "actual",
          amount: String(f.amount),
          currency: "UZS",
          category: f.category,
          method: f.method ?? null,
          ...(f.isOfficial !== undefined ? { isOfficial: f.isOfficial } : {}),
          // Дата документа — полночь по Ташкенту, не по поясу сервера.
          date: new Date(`${f.date}T00:00:00+05:00`),
          paidAt: new Date(`${f.date}T00:00:00+05:00`),
          purpose: f.purpose,
          docNo: f.docNo,
          counterpartyId:
            f.counterpartyInn !== undefined ? (cpByInn.get(f.counterpartyInn) ?? null) : null,
          counterparty: f.counterpartyName ?? null,
          unitId: f.unitVin !== undefined ? (unitByVin.get(f.unitVin) ?? null) : null,
        });
        created += 1;
      }
      if (created > 0) {
        await tx.insert(auditLog).values({
          actorKind: "human",
          actorRef,
          action: "registry_import.flows",
          target: source,
          after: { created, skipped, errors: errors.length },
        });
      }
    });

    return { created, skipped, errors };
  }

  /** Карточка своей компании — одна на направление; существующая не трогается. */
  private async importOwnCompany(
    orgId: string,
    input: { name: string; attrs: Record<string, unknown> },
    source: string,
    actorRef: string,
  ): Promise<ImportCount> {
    if ((input.name ?? "").trim().length < 2) {
      throw new BadRequestException("У своей компании нет названия — почини сид");
    }
    const existing = await this.db
      .select({ id: entity.id })
      .from(entity)
      .where(and(eq(entity.orgId, orgId), eq(entity.type, "own_company")));
    if (existing.length > 0) return { created: 0, skipped: 1 };
    const inn = typeof input.attrs["inn"] === "string" ? (input.attrs["inn"] as string) : null;
    await this.db.transaction(async (tx) => {
      await tx.insert(entity).values({
        orgId,
        type: "own_company",
        name: input.name.trim(),
        externalRef: inn,
        attrs: input.attrs,
        ...this.approvedRow(source, actorRef),
      });
      await tx.insert(auditLog).values({
        actorKind: "human",
        actorRef,
        action: "registry_import.own_company",
        target: source,
        after: { name: input.name },
      });
    });
    return { created: 1, skipped: 0 };
  }

  /** Общие поля утверждённой карточки импорта: слово владельца + провенанс. */
  private approvedRow(source: string, actorRef: string) {
    return { createdFrom: source, approvedAt: new Date(), approvedBy: actorRef };
  }

  private async importContractors(
    orgId: string,
    rows: ImportContractor[],
    source: string,
    actorRef: string,
  ): Promise<ImportCount> {
    // Имя проверяем и СВЕРХУ. Раньше был только нижний предел, и 04.08.2026
    // сюда прошла карточка, у которой в имени лежала склейка строк накладной
    // от нескольких контрагентов сразу — 1223 знака. Из такой склейки
    // настоящее имя не восстановить, поэтому её надо ловить на входе.
    const плохие = rows
      .map((c) => ({ c, беда: entityNameProblem(c.name) ?? (INN_RE.test((c.inn ?? "").trim()) ? null : "кривой ИНН") }))
      .filter((x) => x.беда !== null);
    if (плохие.length > 0) {
      const примеры = плохие.slice(0, 3).map((x) => `«${(x.c.name ?? "").trim().slice(0, 40)}…» — ${x.беда}`);
      throw new BadRequestException(
        `Контрагенты не прошли проверку: ${плохие.length} строк — почини сид. ${примеры.join("; ")}`,
      );
    }
    const clean = rows;
    const inns = clean.map((c) => c.inn.trim());
    const existing = await this.db
      .select({ ref: entity.externalRef })
      .from(entity)
      .where(and(eq(entity.type, "contractor"), inArray(entity.externalRef, inns)));
    const seen = new Set(existing.map((e) => e.ref));
    const fresh = clean.filter((c) => !seen.has(c.inn.trim()));
    // Дубль ИНН внутри самой партии — тоже пропуск, а не второй insert.
    const batch = new Map<string, ImportContractor>();
    for (const c of fresh) if (!batch.has(c.inn.trim())) batch.set(c.inn.trim(), c);

    if (batch.size > 0) {
      await this.db.transaction(async (tx) => {
        await tx.insert(entity).values(
          [...batch.values()].map((c) => ({
            orgId,
            type: "contractor",
            name: c.name.trim(),
            externalRef: c.inn.trim(),
            attrs: {
              roles: ["client"],
              client_type: c.clientType ?? (c.inn.trim().length === 14 ? "individual" : "legal"),
              ...(c.aliases?.length ? { "варианты названия": c.aliases.join("; ") } : {}),
            },
            ...this.approvedRow(source, actorRef),
          })),
        );
        await tx.insert(auditLog).values({
          actorKind: "human",
          actorRef,
          action: "registry_import.contractors",
          target: source,
          after: { created: batch.size, skipped: rows.length - batch.size },
        });
      });
    }
    return { created: batch.size, skipped: rows.length - batch.size };
  }

  private async importInvoices(
    orgId: string,
    rows: ImportInvoice[],
    source: string,
    actorRef: string,
  ): Promise<ImportCount> {
    // Тот же вход, та же беда: у счёта СФ 2025-48 имя оказалось длиной 1246
    // знаков — заголовок счёта и следом весь список позиций нескольких
    // контрагентов. Проверяем до вставки, а не после.
    const кривые = rows
      .map((r) => ({ r, беда: entityNameProblem(r.name) }))
      .filter((x) => x.беда !== null);
    if (кривые.length > 0) {
      const примеры = кривые.slice(0, 3).map((x) => `«${(x.r.name ?? "").trim().slice(0, 40)}…» — ${x.беда}`);
      throw new BadRequestException(
        `Счета не прошли проверку: ${кривые.length} строк — почини сид. ${примеры.join("; ")}`,
      );
    }
    const refs = rows.map((r) => r.ref);
    const existing = await this.db
      .select({ ref: entity.externalRef })
      .from(entity)
      .where(
        and(eq(entity.orgId, orgId), eq(entity.type, "invoice"), inArray(entity.externalRef, refs)),
      );
    const seen = new Set(existing.map((e) => e.ref));
    const batch = new Map<string, ImportInvoice>();
    for (const r of rows) if (!seen.has(r.ref) && !batch.has(r.ref)) batch.set(r.ref, r);

    if (batch.size > 0) {
      await this.db.transaction(async (tx) => {
        await tx.insert(entity).values(
          [...batch.values()].map((r) => ({
            orgId,
            type: "invoice",
            name: r.name,
            externalRef: r.ref,
            attrs: r.attrs,
            ...this.approvedRow(source, actorRef),
          })),
        );
        await tx.insert(auditLog).values({
          actorKind: "human",
          actorRef,
          action: "registry_import.invoices",
          target: source,
          after: { created: batch.size, skipped: rows.length - batch.size },
        });
      });
    }
    return { created: batch.size, skipped: rows.length - batch.size };
  }

  private async importModels(
    orgId: string,
    rows: { name: string }[],
    source: string,
    actorRef: string,
  ): Promise<ImportCount> {
    const existing = await this.db
      .select({ name: entity.name })
      .from(entity)
      .where(and(eq(entity.orgId, orgId), eq(entity.type, "equipment_model")));
    const seen = new Set(existing.map((e) => modelKey(e.name)));
    const batch = new Map<string, string>();
    for (const r of rows) {
      const name = (r.name ?? "").replace(/\s+/g, " ").trim();
      if (name.length < 2) continue;
      const key = modelKey(name);
      if (!seen.has(key) && !batch.has(key)) batch.set(key, name);
    }
    if (batch.size > 0) {
      await this.db.transaction(async (tx) => {
        await tx.insert(entity).values(
          [...batch.values()].map((name) => ({
            orgId,
            type: "equipment_model",
            name,
            attrs: { бренд: "HELI" },
            ...this.approvedRow(source, actorRef),
          })),
        );
        await tx.insert(auditLog).values({
          actorKind: "human",
          actorRef,
          action: "registry_import.models",
          target: source,
          after: { created: batch.size, skipped: rows.length - batch.size },
        });
      });
    }
    return { created: batch.size, skipped: rows.length - batch.size };
  }

  private async importUnits(
    orgId: string,
    rows: ImportUnit[],
    source: string,
    actorRef: string,
  ): Promise<ImportCount & { errors: string[] }> {
    const errors: string[] = [];
    const valid: ImportUnit[] = [];
    for (const u of rows) {
      const err = unitImportError(u);
      if (err !== null) errors.push(err);
      else valid.push(u);
    }

    const vins = valid.map((u) => u.vin.trim());
    const existing = vins.length
      ? await this.db
          .select({ vin: globerentUnit.vin })
          .from(globerentUnit)
          .where(and(eq(globerentUnit.orgId, orgId), inArray(globerentUnit.vin, vins)))
      : [];
    const seenVins = new Set(existing.map((e) => e.vin));

    // Карты связей — по FK, никогда по строке имени (правило сверки переноса).
    const modelRows = await this.db
      .select({ id: entity.id, name: entity.name })
      .from(entity)
      .where(and(eq(entity.orgId, orgId), eq(entity.type, "equipment_model")));
    const modelByKey = new Map(modelRows.map((m) => [modelKey(m.name), m.id]));

    const clientInns = [...new Set(valid.map((u) => u.clientInn).filter((s): s is string => !!s))];
    const clientRows = clientInns.length
      ? await this.db
          .select({ id: entity.id, ref: entity.externalRef })
          .from(entity)
          .where(and(eq(entity.type, "contractor"), inArray(entity.externalRef, clientInns)))
      : [];
    const clientByInn = new Map(clientRows.map((c) => [c.ref, c.id]));

    let created = 0;
    let skipped = 0;
    const batchVins = new Set<string>();
    await this.db.transaction(async (tx) => {
      const [m] = await tx
        .select({
          n: sql<string>`coalesce(max((substring(${globerentUnit.code} from 4))::int), 0)::text`,
        })
        .from(globerentUnit)
        .where(eq(globerentUnit.orgId, orgId));
      let next = Number(m?.n ?? "0");
      for (const u of valid) {
        const vin = u.vin.trim();
        if (seenVins.has(vin) || batchVins.has(vin)) {
          skipped += 1;
          continue;
        }
        batchVins.add(vin);
        next += 1;
        await tx.insert(globerentUnit).values({
          orgId,
          domain: "globerent",
          code: `WH-${String(next).padStart(4, "0")}`,
          name: u.name.trim(),
          modelId:
            u.modelName !== undefined ? (modelByKey.get(modelKey(u.modelName)) ?? null) : null,
          vin,
          status: u.status,
          arrivalDate: u.arrivalDate ?? null,
          declarationNumber: u.declarationNumber ?? null,
          declarationDate: u.declarationDate ?? null,
          salesPrice: u.salesPrice !== undefined ? String(u.salesPrice) : null,
          clientId: u.clientInn !== undefined ? (clientByInn.get(u.clientInn) ?? null) : null,
          notes: u.notes ?? null,
          createdFrom: source,
        });
        created += 1;
      }
      if (created > 0) {
        await tx.insert(auditLog).values({
          actorKind: "human",
          actorRef,
          action: "registry_import.units",
          target: source,
          after: { created, skipped, errors: errors.length },
        });
      }
    });

    return { created, skipped, errors };
  }
}
