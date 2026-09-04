import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Conversations } from "./conversation";
import type { PartUnitRow, PersonRow } from "./core-client";
import { handlePartWashCallback, isPartWashTrigger, parsePartWashCallback, startPartWash } from "./part-wash";

const ME: PersonRow = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Рустам",
  role: "техник",
  roles: ["technician"],
  tgUsername: "rustam",
  tgChatId: "777",
  active: "yes",
};

const W1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const W2 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
const D1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3";

function unit(id: string, location: string, over: Partial<PartUnitRow> = {}): PartUnitRow {
  return {
    id,
    partKind: "mixer",
    inventoryNo: `M-00${id.slice(-1)}`,
    labelPending: false,
    serialNumber: null,
    setNumber: null,
    hopperPosition: null,
    tareWeight: null,
    retiredAt: null,
    where: { location, machineId: null, machineName: null, slot: null, since: "2026-09-01" },
    attention: [],
    label: `Миксер M-00${id.slice(-1)}`,
    photoCount: 0,
    ...over,
  };
}

/** Core-заглушка с настоящим «состоянием»: движения меняют списки. */
function stubCore(drying = true) {
  const where = new Map<string, string>([
    [W1, "washing"],
    [W2, "washing"],
    [D1, "drying"],
  ]);
  const calls: string[] = [];
  const core = {
    partsAt: async (loc: string) => [...where.entries()].filter(([, l]) => l === loc).map(([id, l]) => unit(id, l)),
    partWashed: async (id: string, input: { clientKey?: string }) => {
      calls.push(`washed:${id.slice(-1)}:${input.clientKey ?? "-"}`);
      if (id === W2) throw new Error("Узел стоит на автомате");
      const to = drying ? "drying" : "warehouse";
      where.set(id, to);
      return { unit: unit(id, to), from: "washing", logId: "log-1" };
    },
    partMove: async (id: string, input: { to: string; clientKey?: string }) => {
      calls.push(`move:${id.slice(-1)}:${input.to}:${input.clientKey ?? "-"}`);
      where.set(id, input.to);
      return { unit: unit(id, input.to), from: "drying", logId: "log-2" };
    },
  } as never;
  return { core, calls, where };
}

describe("Мастер «🚿 Помыл узлы» (pw:)", () => {
  it("триггеры не отбирают «помыл» у мойки бункера", () => {
    assert.equal(isPartWashTrigger("помыл узлы"), true);
    assert.equal(isPartWashTrigger("с мойки на склад"), true);
    assert.equal(isPartWashTrigger("сушка"), true);
    assert.equal(isPartWashTrigger("помыл"), false, "одиночное «помыл» — мойка бункера на точке");
    assert.equal(isPartWashTrigger("помыл бункер 3"), false);
  });

  it("разбор кнопок: ok/st с uuid, all/stall/x без", () => {
    assert.deepEqual(parsePartWashCallback(`pw:ok:${W1}`), { kind: "washed", unitId: W1 });
    assert.deepEqual(parsePartWashCallback(`pw:st:${D1}`), { kind: "stored", unitId: D1 });
    assert.deepEqual(parsePartWashCallback("pw:all"), { kind: "washedAll" });
    assert.deepEqual(parsePartWashCallback("pw:stall"), { kind: "storedAll" });
    assert.deepEqual(parsePartWashCallback("pw:x"), { kind: "done" });
    assert.equal(parsePartWashCallback("pw:ok:nope"), null);
    assert.equal(parsePartWashCallback("pn:x"), null);
  });

  it("экран показывает оба списка; «Помыл» уводит на сушку, «На склад» — со сушки", async () => {
    const { core, calls } = stubCore();
    const conversations = new Conversations();
    const start = await startPartWash(777, ME, { core, conversations });
    assert.match(start.text, /На мойке: 2/);
    assert.match(start.text, /На сушке: 1/);
    const labels = start.keyboard!.inline_keyboard.flat().map((b) => b.text);
    assert.ok(labels.some((l) => l.startsWith("✅ Помыл M-001")));
    assert.ok(labels.some((l) => l.startsWith("📦 На склад M-003")));
    assert.ok(labels.includes("✅ Помыл все (2)"), "«все» есть, когда узлов больше одного");
    assert.equal(conversations.get(777)?.flow, "part-wash");

    const washed = await handlePartWashCallback(777, { kind: "washed", unitId: W1 }, ME, { core, conversations });
    assert.match(calls[0], /^washed:1:pw:.+:w:aaaaaaaa/);
    assert.match(washed.message!.text, /M-001 — на сушке/);
    assert.match(washed.message!.text, /На мойке: 1/, "список пересчитан после движения");
    assert.match(washed.message!.text, /На сушке: 2/);

    const stored = await handlePartWashCallback(777, { kind: "stored", unitId: D1 }, ME, { core, conversations });
    assert.match(calls[1], /^move:3:warehouse:pw:.+:s:aaaaaaaa/, "ключ идемпотентности несёт узел и вид движения");
    assert.match(stored.message!.text, /M-003 — на складе/);
  });

  it("отказ Core по одному узлу не роняет «все»: остальные отмечены, ошибка названа", async () => {
    const { core, where } = stubCore();
    const conversations = new Conversations();
    await startPartWash(777, ME, { core, conversations });
    const all = await handlePartWashCallback(777, { kind: "washedAll" }, ME, { core, conversations });
    assert.match(all.message!.text, /M-001 — на сушке/);
    assert.match(all.message!.text, /⚠️ aaaaaaaa: Узел стоит на автомате/);
    assert.equal(where.get(W2), "washing", "проблемный остался на мойке");
    assert.match(all.message!.text, /На мойке: 1/);
  });

  it("без сушки «Помыл» ведёт сразу на склад; когда всё пусто — мастер закрывается", async () => {
    const { core, where } = stubCore(false);
    where.delete(W2);
    where.delete(D1);
    const conversations = new Conversations();
    await startPartWash(777, ME, { core, conversations });
    const res = await handlePartWashCallback(777, { kind: "washed", unitId: W1 }, ME, { core, conversations });
    assert.match(res.message!.text, /M-001 — на складе/);
    assert.match(res.message!.text, /всё на складе/);
    assert.equal(conversations.get(777), null);
  });

  it("пустая мойка — честный текст без мастера; чужая кнопка — «устарела»", async () => {
    const { core, where } = stubCore();
    where.clear();
    const conversations = new Conversations();
    const start = await startPartWash(777, ME, { core, conversations });
    assert.match(start.text, /пусто/);
    assert.equal(conversations.get(777), null);
    const res = await handlePartWashCallback(777, { kind: "washed", unitId: W1 }, ME, { core, conversations });
    assert.equal(res.answer, "Кнопка устарела");
  });

  it("узел, отмеченный кем-то раньше, не отмечается второй раз", async () => {
    const { core, calls, where } = stubCore();
    const conversations = new Conversations();
    await startPartWash(777, ME, { core, conversations });
    where.set(W1, "drying"); // коллега успел раньше
    const res = await handlePartWashCallback(777, { kind: "washed", unitId: W1 }, ME, { core, conversations });
    assert.equal(res.answer, "Уже не там");
    assert.deepEqual(calls, []);
    assert.match(res.message!.text, /кто-то отметил раньше/);
  });
});
