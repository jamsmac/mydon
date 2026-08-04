import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { auditLog, entity, globerentUnit, org } from "@mydon/db";
import { and, eq, inArray, sql } from "drizzle-orm";
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
}

const UNIT_STATUSES_ALLOWED = ["IN_STOCK", "DELIVERED_TO_CLIENT"] as const;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const INN_RE = /^\d{9}$|^\d{14}$/;

/** Ключ сравнения имён моделей: регистр и лишние пробелы не различаются. */
export function modelKey(name: string): string {
  return name.replace(/\s+/g, " ").trim().toLowerCase();
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
    if (!row) throw new NotFoundException("Направление globerent не заведено. Выполните pnpm db:seed.");
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
    };

    if (payload.contractors?.length) {
      summary.contractors = await this.importContractors(orgId, payload.contractors, source, actorRef);
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
    return summary;
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
    const clean = rows.filter((c) => (c.name ?? "").trim().length >= 2 && INN_RE.test((c.inn ?? "").trim()));
    if (clean.length < rows.length) {
      throw new BadRequestException(
        `Контрагенты без имени или с кривым ИНН: ${rows.length - clean.length} строк — почини сид`,
      );
    }
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
    const refs = rows.map((r) => r.ref);
    const existing = await this.db
      .select({ ref: entity.externalRef })
      .from(entity)
      .where(and(eq(entity.orgId, orgId), eq(entity.type, "invoice"), inArray(entity.externalRef, refs)));
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
            attrs: { "бренд": "HELI" },
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
        .select({ n: sql<string>`coalesce(max((substring(${globerentUnit.code} from 4))::int), 0)::text` })
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
          modelId: u.modelName !== undefined ? (modelByKey.get(modelKey(u.modelName)) ?? null) : null,
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
