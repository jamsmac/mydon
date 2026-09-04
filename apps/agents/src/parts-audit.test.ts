import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { WASHING_STALE_DAYS, partsAuditProposal, type PartsQueueSnapshot } from "./parts-audit";

const NOW = new Date("2026-09-10T08:00:00Z");

function item(label: string, attention: string[], where: PartsQueueSnapshot["items"][number]["where"] = null) {
  return { id: label, label, attention, where };
}

describe("Навык parts-audit: очередь узлов → одно предложение", () => {
  it("пустая очередь и чистая мойка — повода нет", () => {
    assert.equal(partsAuditProposal({ counts: {}, items: [] }, NOW), null);
  });

  it("счётчики складываются в текст, примеры — до пяти, next — по делу", () => {
    const queue: PartsQueueSnapshot = {
      counts: { label_pending: 27, no_number: 2, unknown_location: 1, no_tare: 3, no_photo: 30 },
      items: [
        item("Миксер M-017", ["label_pending", "no_photo"]),
        item("Бункер H-27-3", ["no_tare"]),
        item("Гриндер (без номера)", ["no_number"], { location: "unknown", machineName: null, since: "2026-08-01" }),
        item("M-018", ["label_pending"]),
        item("M-019", ["label_pending"]),
        item("M-020", ["label_pending"]),
      ],
    };
    const p = partsAuditProposal(queue, NOW)!;
    assert.match(p.action, /^Узлы: 6 требуют внимания — наклеить 27, без номера 2, неизвестно где 1, без тары 3, без фото 30$/);
    assert.equal((p.facts.examples as string[]).length, 5);
    assert.equal((p.facts.examples as string[])[0], "Миксер M-017 — наклеить, без фото");
    assert.ok(p.next!.some((n) => /parts\/queue/.test(n)));
    assert.ok(p.next!.some((n) => /инвентаризацию/.test(n)), "«неизвестно где» → инвентаризация");
    assert.ok(p.next!.some((n) => /тары/.test(n)), "«без тары» → взвесить");
    assert.deepEqual(p.signatureFacts, { counts: queue.counts, staleWashing: 0 });
  });

  it("зависшая мойка — сигнал даже при пустой очереди; свежая — нет", () => {
    const stale = item("Миксер M-005", ["no_photo"], { location: "washing", machineName: null, since: "2026-09-01" });
    const fresh = item("Миксер M-006", ["no_photo"], { location: "washing", machineName: null, since: "2026-09-09" });
    const p = partsAuditProposal({ counts: { no_photo: 2 }, items: [stale, fresh] }, NOW)!;
    assert.match(p.action, new RegExp(`на мойке дольше ${WASHING_STALE_DAYS} дней: 1`));
    assert.ok(p.next!.some((n) => n.includes("M-005") && !n.includes("M-006")));
    assert.equal((p.signatureFacts as { staleWashing: number }).staleWashing, 1);
  });

  it("та же картина неделю спустя даёт ту же сигнатуру — дельта-память подавит повтор", () => {
    const queue: PartsQueueSnapshot = { counts: { label_pending: 3 }, items: [item("A", ["label_pending"])] };
    const a = partsAuditProposal(queue, NOW)!;
    const b = partsAuditProposal(queue, new Date("2026-09-17T08:00:00Z"))!;
    assert.deepEqual(a.signatureFacts, b.signatureFacts);
  });
});
