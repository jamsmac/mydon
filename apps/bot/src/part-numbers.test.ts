import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Conversations } from "./conversation";
import type { PartUnitRow, PersonRow } from "./core-client";
import {
  handlePartNumberCallback,
  handlePartNumberText,
  isPartNumberTrigger,
  parsePartNumberCallback,
  startPartNumbers,
} from "./part-numbers";

const ME: PersonRow = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Рустам",
  role: "техник",
  roles: ["technician"],
  tgUsername: "rustam",
  tgChatId: "777",
  active: "yes",
};

const U1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const U2 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
const U3 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3";

function unit(over: Partial<PartUnitRow>): PartUnitRow {
  return {
    id: U1,
    partKind: "mixer",
    inventoryNo: "M-001",
    labelPending: true,
    serialNumber: null,
    setNumber: null,
    hopperPosition: null,
    tareWeight: null,
    retiredAt: null,
    where: { location: "machine", machineId: "m1", machineName: "Kaffit-04", slot: 1, since: "2026-09-04" },
    attention: ["label_pending", "no_photo"],
    label: "Миксер M-001",
    photoCount: 0,
    ...over,
  };
}

function stubCore() {
  const units = new Map<string, PartUnitRow>([
    [U1, unit({ id: U1 })],
    [U2, unit({ id: U2, partKind: "hopper", inventoryNo: null, labelPending: false, attention: ["no_number", "no_tare"], label: "Бункер (без номера)" })],
    [U3, unit({ id: U3, partKind: "grinder", inventoryNo: "G-002", attention: ["no_photo"], labelPending: false, label: "Гриндер G-002" })],
  ]);
  const calls: string[] = [];
  const core = {
    partsQueue: async () => ({ counts: {}, items: [...units.values()] }),
    partUnit: async (id: string) => {
      const u = units.get(id);
      if (!u) throw new Error("нет узла");
      return u;
    },
    partSetNumber: async (id: string, input: { inventoryNo?: string; confirmLabel?: boolean }) => {
      calls.push(`number:${id.slice(-1)}:${input.inventoryNo ?? "-"}:${input.confirmLabel ? "confirm" : "-"}`);
      const u = units.get(id)!;
      if (input.inventoryNo === "M-001") throw new Error("Номер M-001 уже у узла «Миксер M-001»");
      const next = {
        ...u,
        inventoryNo: input.inventoryNo ?? u.inventoryNo ?? "H-007",
        labelPending: input.confirmLabel || input.inventoryNo ? false : true,
        attention: [] as string[],
      };
      units.set(id, next);
      return next;
    },
  } as never;
  return { core, calls };
}

describe("Мастер «🔢 Номера узлов» (pn:)", () => {
  it("триггеры: «номера узлов», «наклеить», «инвентарный»", () => {
    assert.equal(isPartNumberTrigger("номера узлов"), true);
    assert.equal(isPartNumberTrigger("наклеить номер"), true);
    assert.equal(isPartNumberTrigger("инвентарные номера"), true);
    assert.equal(isPartNumberTrigger("залил кофе"), false);
  });

  it("разбор callback: ok/edit/skip/assign с uuid, done без", () => {
    assert.deepEqual(parsePartNumberCallback(`pn:ok:${U1}`), { kind: "ok", unitId: U1 });
    assert.deepEqual(parsePartNumberCallback(`pn:as:${U2}`), { kind: "assign", unitId: U2 });
    assert.deepEqual(parsePartNumberCallback("pn:x"), { kind: "done" });
    assert.equal(parsePartNumberCallback("pn:ok:not-a-uuid"), null);
    assert.equal(parsePartNumberCallback("pt:x"), null);
  });

  it("очередь берёт только узлы без номера и с неподтверждённой наклейкой; идёт по одному", async () => {
    const { core, calls } = stubCore();
    const conversations = new Conversations();
    const start = await startPartNumbers(777, ME, { core, conversations });
    assert.match(start.text, /ждут наклейки: 2/, "G-002 только без фото — не в очереди номеров");
    assert.match(start.text, /1 из 2/);
    assert.match(start.text, /Миксер — номер M-001/);
    assert.ok(start.keyboard && JSON.stringify(start.keyboard).includes("pn:ok:"));

    // Наклеил → подтверждение, следующий узел (бункер без номера)
    const ok = await handlePartNumberCallback(777, { kind: "ok", unitId: U1 }, ME, { core, conversations });
    assert.deepEqual(calls, ["number:1:-:confirm"]);
    assert.match(ok.message?.text ?? "", /M-001 — наклейка подтверждена/);
    assert.match(ok.message?.text ?? "", /2 из 2/);
    assert.match(ok.message?.text ?? "", /Присвоить/);

    // Присвоить → система дала номер, та же карточка с «Наклеил»
    const assigned = await handlePartNumberCallback(777, { kind: "assign", unitId: U2 }, ME, { core, conversations });
    assert.equal(calls[1], "number:2:-:-");
    assert.match(assigned.message?.text ?? "", /номер H-007/);

    // Свой номер текстом: занятый — честный отказ и повтор шага; свободный — принят, очередь пуста
    await handlePartNumberCallback(777, { kind: "edit", unitId: U2 }, ME, { core, conversations });
    const busy = await handlePartNumberText(777, "M-001", ME, { core, conversations });
    assert.match(busy.text, /уже у узла/);
    assert.equal(conversations.get(777)?.step, "number", "после отказа остаёмся на шаге ввода");
    const done = await handlePartNumberText(777, "H-27-3", ME, { core, conversations });
    assert.match(done.text, /теперь H-27-3/);
    assert.match(done.text, /Готово: номеров проставлено\/подтверждено 2/);
    assert.equal(conversations.get(777), null, "очередь кончилась — мастер закрыт");
  });

  it("пропуск не запоминается: узел возвращается при следующем запуске", async () => {
    const { core, calls } = stubCore();
    const conversations = new Conversations();
    await startPartNumbers(777, ME, { core, conversations });
    const skipped = await handlePartNumberCallback(777, { kind: "skip", unitId: U1 }, ME, { core, conversations });
    assert.match(skipped.message?.text ?? "", /2 из 2/);
    const fin = await handlePartNumberCallback(777, { kind: "done" }, ME, { core, conversations });
    assert.match(fin.message?.text ?? "", /очередь никуда не денется/);
    assert.deepEqual(calls, [], "пропуск и выход ничего не пишут");
    const again = await startPartNumbers(777, ME, { core, conversations });
    assert.match(again.text, /ждут наклейки: 2/, "пропущенный вернулся");
  });

  it("кнопка от чужого/устаревшего мастера не действует", async () => {
    const { core } = stubCore();
    const conversations = new Conversations();
    const res = await handlePartNumberCallback(777, { kind: "ok", unitId: U1 }, ME, { core, conversations });
    assert.equal(res.answer, "Кнопка устарела");
  });
});
