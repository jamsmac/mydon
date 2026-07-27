import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { VerificationService, type Claim } from "./verification.service";

type Row = Record<string, unknown>;

/**
 * Заглушка базы. `rows` — что вернёт очередной select (по порядку вызовов):
 * первый select всегда ищет сам запрос на согласование.
 */
function stubDb(rows: Row[][]) {
  let i = 0;
  const next = async () => rows[i++] ?? [];
  const chain = {
    from: () => chain,
    where: next,
  } as unknown as { from: () => unknown; where: () => Promise<Row[]> };

  const tx = { insert: () => ({ values: async () => undefined }) };
  return {
    select: () => chain,
    transaction: async <T>(cb: (t: typeof tx) => Promise<T>): Promise<T> => cb(tx),
  } as never;
}

const APPROVAL = { id: "11111111-1111-1111-1111-111111111111", decision: "approved" };

describe("VerificationService — слову агента не верим", () => {
  it("подтверждает, когда карточка действительно есть", async () => {
    const s = new VerificationService(
      stubDb([[APPROVAL], [{ id: "e1", name: "ООО Ромашка", attrs: {} }]]),
    );
    const r = await s.verify({
      approvalId: APPROVAL.id,
      agent: "test",
      claims: [{ kind: "entity", id: "e1" }],
    });
    assert.equal(r.verdict, "confirmed");
    assert.equal(r.confirmed, 1);
  });

  it("опровергает, когда карточки нет, хотя агент заявил обратное", async () => {
    const s = new VerificationService(stubDb([[APPROVAL], []]));
    const r = await s.verify({
      approvalId: APPROVAL.id,
      agent: "test",
      claims: [{ kind: "entity", id: "e1" }],
    });
    assert.equal(r.verdict, "refuted");
    assert.match(r.details[0].observed, /нет/);
  });

  it("опровергает, когда поле не совпало с заявленным", async () => {
    const s = new VerificationService(
      stubDb([[APPROVAL], [{ id: "e1", name: "Х", attrs: { status: "idle" } }]]),
    );
    const r = await s.verify({
      approvalId: APPROVAL.id,
      agent: "test",
      claims: [{ kind: "entity", id: "e1", field: "status", equals: "working" }],
    });
    assert.equal(r.verdict, "refuted");
    assert.match(r.details[0].observed, /заявлено «working».*«idle»/);
  });

  it("пустой отчёт НЕ считается подтверждением", async () => {
    const s = new VerificationService(stubDb([[APPROVAL]]));
    const r = await s.verify({ approvalId: APPROVAL.id, agent: "test", claims: [] });
    assert.equal(r.verdict, "refuted", "иначе «готово» без доказательств проходит само собой");
  });

  it("выдуманный вид утверждения не проходит проверку", async () => {
    const s = new VerificationService(stubDb([[APPROVAL]]));
    const r = await s.verify({
      approvalId: APPROVAL.id,
      agent: "test",
      claims: [{ kind: "выдумка" } as unknown as Claim],
    });
    assert.equal(r.verdict, "refuted");
  });

  it("одно опровергнутое утверждение опровергает весь отчёт", async () => {
    const s = new VerificationService(
      stubDb([[APPROVAL], [{ id: "e1", name: "есть", attrs: {} }], []]),
    );
    const r = await s.verify({
      approvalId: APPROVAL.id,
      agent: "test",
      claims: [
        { kind: "entity", id: "e1" },
        { kind: "entity", id: "e2" },
      ],
    });
    assert.equal(r.verdict, "refuted");
    assert.equal(r.confirmed, 1);
    assert.equal(r.checked, 2);
  });
});
