import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { auditLog, brvValue, tnvedRate } from "@mydon/db";
import { desc, eq } from "drizzle-orm";
import { DB, type Db } from "../db/db.module";

type TnvedRow = typeof tnvedRate.$inferSelect;
type BrvRow = typeof brvValue.$inferSelect;

export interface SaveTnvedInput {
  id?: string;
  code: string;
  nameRu: string;
  vehicleCategory?: "autotransport" | "spec_tech";
  importDutyRate?: number;
  customsFeeRate?: number;
  exciseRate?: number;
  vatRate?: number;
  utilizationBrvCount?: number;
  extraDutyPerCcUsd?: number;
  registrationType?: "gibdd" | "gostechnadzor";
  certCashDefaultUzs?: number;
  certBankDefaultUzs?: number;
  grossMassMinKg?: number;
  grossMassMaxKg?: number;
  engineTypeConstraint?: string;
  isActive?: boolean;
  notes?: string;
  validFrom?: string;
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Доля 0..1: ставки хранятся долями (0.05 = 5%), как у донора PROMACH. */
function checkShare(name: string, v: number | undefined): void {
  if (v === undefined) return;
  if (!Number.isFinite(v) || v < 0 || v > 1) {
    throw new BadRequestException(`${name}: ставка задаётся долей от 0 до 1 (0.05 = 5%)`);
  }
}

function checkNonNegative(name: string, v: number | undefined): void {
  if (v === undefined) return;
  if (!Number.isFinite(v) || v < 0) {
    throw new BadRequestException(`${name}: число не меньше нуля`);
  }
}

/**
 * Расчётные справочники GLOBERENT: ставки ТН ВЭД и БРВ.
 * Перенос tnved_codes/brv_values PROMACH: числовая основа калькулятора
 * растаможки живёт таблицами, не EAV (решение сверки переноса).
 */
@Injectable()
export class CatalogService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async tnvedList(all = false): Promise<TnvedRow[]> {
    const q = this.db.select().from(tnvedRate).orderBy(tnvedRate.code);
    if (all) return q;
    return q.where(eq(tnvedRate.isActive, true));
  }

  async saveTnved(input: SaveTnvedInput, actorRef = "owner"): Promise<TnvedRow> {
    const code = (input.code ?? "").trim();
    if (!/^\d{4,10}$/.test(code)) {
      throw new BadRequestException("Код ТН ВЭД — от 4 до 10 цифр, например 8429519900");
    }
    if ((input.nameRu ?? "").trim().length < 3) {
      throw new BadRequestException("Впиши название товара по-русски");
    }
    checkShare("Пошлина", input.importDutyRate);
    checkShare("Сбор за оформление", input.customsFeeRate);
    checkShare("Акциз", input.exciseRate);
    checkShare("НДС", input.vatRate);
    checkNonNegative("Утильсбор (БРВ)", input.utilizationBrvCount);
    checkNonNegative("Доп. пошлина $/см³", input.extraDutyPerCcUsd);
    checkNonNegative("Сертификация нал", input.certCashDefaultUzs);
    checkNonNegative("Сертификация безнал", input.certBankDefaultUzs);
    if (input.validFrom !== undefined && !ISO_DAY.test(input.validFrom)) {
      throw new BadRequestException("Дата «действует с» — в формате ГГГГ-ММ-ДД");
    }
    if (
      input.grossMassMinKg !== undefined &&
      input.grossMassMaxKg !== undefined &&
      input.grossMassMinKg > input.grossMassMaxKg
    ) {
      throw new BadRequestException("Диапазон массы: минимум больше максимума");
    }

    const values = {
      code,
      nameRu: input.nameRu.trim(),
      ...(input.vehicleCategory !== undefined ? { vehicleCategory: input.vehicleCategory } : {}),
      ...(input.importDutyRate !== undefined ? { importDutyRate: String(input.importDutyRate) } : {}),
      ...(input.customsFeeRate !== undefined ? { customsFeeRate: String(input.customsFeeRate) } : {}),
      ...(input.exciseRate !== undefined ? { exciseRate: String(input.exciseRate) } : {}),
      ...(input.vatRate !== undefined ? { vatRate: String(input.vatRate) } : {}),
      ...(input.utilizationBrvCount !== undefined ? { utilizationBrvCount: input.utilizationBrvCount } : {}),
      ...(input.extraDutyPerCcUsd !== undefined
        ? { extraDutyPerCcUsd: String(input.extraDutyPerCcUsd) }
        : {}),
      ...(input.registrationType !== undefined ? { registrationType: input.registrationType } : {}),
      ...(input.certCashDefaultUzs !== undefined
        ? { certCashDefaultUzs: String(input.certCashDefaultUzs) }
        : {}),
      ...(input.certBankDefaultUzs !== undefined
        ? { certBankDefaultUzs: String(input.certBankDefaultUzs) }
        : {}),
      ...(input.grossMassMinKg !== undefined ? { grossMassMinKg: input.grossMassMinKg } : {}),
      ...(input.grossMassMaxKg !== undefined ? { grossMassMaxKg: input.grossMassMaxKg } : {}),
      ...(input.engineTypeConstraint !== undefined
        ? { engineTypeConstraint: input.engineTypeConstraint }
        : {}),
      ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
      ...(input.notes !== undefined ? { notes: input.notes } : {}),
      ...(input.validFrom !== undefined ? { validFrom: input.validFrom } : {}),
      setBy: actorRef,
    };

    return this.db.transaction(async (tx) => {
      if (input.id !== undefined) {
        const [before] = await tx.select().from(tnvedRate).where(eq(tnvedRate.id, input.id)).for("update");
        if (!before) throw new NotFoundException("Ставка не найдена");
        const [updated] = await tx
          .update(tnvedRate)
          .set({ ...values, updatedAt: new Date() })
          .where(eq(tnvedRate.id, input.id))
          .returning();
        await tx.insert(auditLog).values({
          actorKind: "human",
          actorRef,
          action: "catalog.tnved_updated",
          target: input.id,
          before,
          after: updated,
        });
        return updated;
      }
      const [created] = await tx.insert(tnvedRate).values(values).returning();
      await tx.insert(auditLog).values({
        actorKind: "human",
        actorRef,
        action: "catalog.tnved_created",
        target: created.id,
        after: created,
      });
      return created;
    });
  }

  /** Убрать ставку из работы. Строка остаётся — расчёты на неё уже ссылались. */
  async deactivateTnved(id: string, actorRef = "owner"): Promise<TnvedRow> {
    return this.db.transaction(async (tx) => {
      const [before] = await tx.select().from(tnvedRate).where(eq(tnvedRate.id, id)).for("update");
      if (!before) throw new NotFoundException("Ставка не найдена");
      const [updated] = await tx
        .update(tnvedRate)
        .set({ isActive: false, updatedAt: new Date() })
        .where(eq(tnvedRate.id, id))
        .returning();
      await tx.insert(auditLog).values({
        actorKind: "human",
        actorRef,
        action: "catalog.tnved_deactivated",
        target: id,
        before,
        after: updated,
      });
      return updated;
    });
  }

  /** История БРВ, свежие сверху. */
  async brvList(): Promise<BrvRow[]> {
    return this.db.select().from(brvValue).orderBy(desc(brvValue.validFrom)).limit(100);
  }

  /** Задать БРВ с даты. История не переписывается — каждая установка новой строкой. */
  async setBrv(input: { valueUzs: number; validFrom: string; note?: string }, actorRef = "owner"): Promise<BrvRow[]> {
    if (!Number.isFinite(input.valueUzs) || input.valueUzs <= 0) {
      throw new BadRequestException("БРВ — положительное число сумов");
    }
    if (!ISO_DAY.test(input.validFrom ?? "")) {
      throw new BadRequestException("Дата «действует с» — в формате ГГГГ-ММ-ДД");
    }
    await this.db.transaction(async (tx) => {
      const [created] = await tx
        .insert(brvValue)
        .values({
          valueUzs: String(input.valueUzs),
          validFrom: input.validFrom,
          note: input.note ?? null,
          setBy: actorRef,
        })
        .returning();
      await tx.insert(auditLog).values({
        actorKind: "human",
        actorRef,
        action: "catalog.brv_set",
        target: created.id,
        after: created,
      });
    });
    return this.brvList();
  }
}
