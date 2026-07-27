import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { approval, auditLog, entity, event, moneyFlow } from "@mydon/db";
import { and, eq, gte, sql } from "drizzle-orm";
import { DB, type Db } from "../db/db.module";

/**
 * Проверка заявленного по реальным следам.
 *
 * Агент, сообщивший «готово», не является источником истины о собственной работе.
 * Слой ходит в базу и сверяет каждое утверждение с фактическим состоянием:
 * появилась ли карточка, изменилось ли поле, записалось ли движение денег.
 *
 * Правило: непроверяемое утверждение считается НЕподтверждённым. Молчаливое
 * «наверное, всё хорошо» — именно то, ради чего слой и написан.
 */

export type Claim =
  | { kind: "entity"; id: string; field?: string; equals?: string }
  | { kind: "money"; entityId: string; direction: "in" | "out"; minAmount?: number }
  | { kind: "event"; type: string; sinceMinutes?: number };

export interface ClaimVerdict {
  claim: Claim;
  confirmed: boolean;
  /** Что увидели в базе на самом деле — понятной строкой. */
  observed: string;
}

export interface Report {
  approvalId: string;
  agent: string;
  claims: Claim[];
}

export interface VerificationResult {
  approvalId: string;
  agent: string;
  verdict: "confirmed" | "refuted";
  checked: number;
  confirmed: number;
  details: ClaimVerdict[];
}

@Injectable()
export class VerificationService {
  constructor(@Inject(DB) private readonly db: Db) {}

  private async checkEntity(c: Extract<Claim, { kind: "entity" }>): Promise<ClaimVerdict> {
    const [row] = await this.db.select().from(entity).where(eq(entity.id, c.id));
    if (!row) return { claim: c, confirmed: false, observed: "карточки с таким id нет" };

    if (!c.field) {
      return { claim: c, confirmed: true, observed: `карточка есть: «${row.name}»` };
    }

    // Поле ищем и среди колонок, и внутри attrs — агенты пишут и туда, и туда.
    const attrs = (row.attrs ?? {}) as Record<string, unknown>;
    const actual =
      c.field === "name"
        ? row.name
        : c.field === "externalRef"
          ? row.externalRef
          : c.field === "type"
            ? row.type
            : attrs[c.field];

    if (actual === undefined || actual === null) {
      return { claim: c, confirmed: false, observed: `поля «${c.field}» нет` };
    }
    if (c.equals === undefined) {
      return { claim: c, confirmed: true, observed: `поле «${c.field}» = ${String(actual)}` };
    }
    const ok = String(actual) === c.equals;
    return {
      claim: c,
      confirmed: ok,
      observed: ok
        ? `поле «${c.field}» = ${c.equals}, как заявлено`
        : `заявлено «${c.equals}», в базе «${String(actual)}»`,
    };
  }

  private async checkMoney(c: Extract<Claim, { kind: "money" }>): Promise<ClaimVerdict> {
    const [row] = await this.db
      .select({
        n: sql<number>`count(*)::int`,
        total: sql<string>`coalesce(sum(${moneyFlow.amount}), 0)::text`,
      })
      .from(moneyFlow)
      .where(and(eq(moneyFlow.entityId, c.entityId), eq(moneyFlow.direction, c.direction)));

    const n = row?.n ?? 0;
    if (n === 0) {
      return { claim: c, confirmed: false, observed: "движений денег по этой карточке нет" };
    }
    const total = Number(row?.total ?? 0);
    if (c.minAmount !== undefined && total < c.minAmount) {
      return {
        claim: c,
        confirmed: false,
        observed: `записано ${total}, заявлено не меньше ${c.minAmount}`,
      };
    }
    return { claim: c, confirmed: true, observed: `движений: ${n}, сумма ${total}` };
  }

  private async checkEvent(c: Extract<Claim, { kind: "event" }>): Promise<ClaimVerdict> {
    const since = new Date(Date.now() - (c.sinceMinutes ?? 60) * 60_000);
    const [row] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(event)
      .where(and(eq(event.type, c.type), gte(event.occurredAt, since)));

    const n = row?.n ?? 0;
    return {
      claim: c,
      confirmed: n > 0,
      observed: n > 0 ? `событий «${c.type}»: ${n}` : `события «${c.type}» не было`,
    };
  }

  private async checkOne(c: Claim): Promise<ClaimVerdict> {
    switch (c.kind) {
      case "entity":
        return this.checkEntity(c);
      case "money":
        return this.checkMoney(c);
      case "event":
        return this.checkEvent(c);
      default:
        // Неизвестный вид утверждения не может быть подтверждён — только так,
        // иначе достаточно прислать выдуманный kind, чтобы «пройти проверку».
        return { claim: c, confirmed: false, observed: "неизвестный вид утверждения" };
    }
  }

  /**
   * Проверяет отчёт агента и записывает вердикт в журнал.
   * Возвращает результат независимо от исхода — опровержение это тоже результат.
   */
  async verify(report: Report): Promise<VerificationResult> {
    const [target] = await this.db
      .select()
      .from(approval)
      .where(eq(approval.id, report.approvalId));
    if (!target) {
      throw new NotFoundException(`Запрос на согласование ${report.approvalId} не найден`);
    }

    // Пустой отчёт — не подтверждение. Иначе «готово» без единого утверждения
    // проходило бы проверку автоматически.
    const details =
      report.claims.length === 0
        ? [
            {
              claim: { kind: "event", type: "—" } as Claim,
              confirmed: false,
              observed: "агент не привёл ни одного проверяемого утверждения",
            },
          ]
        : await Promise.all(report.claims.map((c) => this.checkOne(c)));

    const confirmed = details.filter((d) => d.confirmed).length;
    const verdict: VerificationResult["verdict"] =
      confirmed === details.length ? "confirmed" : "refuted";

    await this.db.transaction(async (tx) => {
      await tx.insert(event).values({
        source: `agent:${report.agent}`,
        type: verdict === "confirmed" ? "claim.confirmed" : "claim.refuted",
        payload: {
          approvalId: report.approvalId,
          checked: details.length,
          confirmed,
          details: details.map((d) => ({ confirmed: d.confirmed, observed: d.observed })),
        },
      });
      await tx.insert(auditLog).values({
        actorKind: "system",
        actorRef: "verification",
        action: `claim.${verdict}`,
        target: report.approvalId,
        after: { agent: report.agent, checked: details.length, confirmed },
      });
    });

    return {
      approvalId: report.approvalId,
      agent: report.agent,
      verdict,
      checked: details.length,
      confirmed,
      details,
    };
  }
}
