import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Conversations } from "./conversation";
import type { PartCountLineRow, PersonRow } from "./core-client";
import {
  handlePartCountCallback,
  handlePartCountPhoto,
  handlePartCountText,
  isPartCountTrigger,
  parsePartCountCallback,
  startPartCount,
} from "./part-count";

const ME: PersonRow = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Рустам",
  role: "техник",
  roles: ["technician"],
  tgUsername: "rustam",
  tgChatId: "777",
  active: "yes",
};
const SESSION = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

function stubCore(over: { photoRequired?: boolean; resumed?: boolean } = {}) {
  const calls: string[] = [];
  let n = 0;
  const lines = new Map<string, PartCountLineRow>();
  const core = {
    partCountStart: async (i: { location: string }) => {
      calls.push(`start:${i.location}`);
      return { session: { id: SESSION, location: i.location, startedAt: "2026-09-04T08:00:00Z" }, resumed: over.resumed ?? false, photoRequired: over.photoRequired ?? true, expected: 4 };
    },
    partCountAddLine: async (sid: string, i: { partKind: string; inventoryNo?: string; serialNumber?: string; clientKey?: string }) => {
      calls.push(`line:${i.partKind}:${i.inventoryNo ?? "-"}:${i.serialNumber ?? "-"}:${i.clientKey ?? "-"}`);
      if (i.inventoryNo === "M-001") throw new Error("«Миксер M-001» в этой сессии уже посчитан");
      n += 1;
      const id = `dddddddd-dddd-4ddd-8ddd-00000000000${n}`;
      const found = i.inventoryNo === "M-017" || i.serialNumber === "SN-B";
      const line: PartCountLineRow = {
        id,
        sessionId: sid,
        partUnitId: found ? "u" : null,
        partKind: i.partKind,
        inventoryNoEntered: i.inventoryNo ?? null,
        serialEntered: i.serialNumber ?? null,
        photoSkippedReason: null,
        result: null,
        label: found ? `Миксер ${i.inventoryNo ?? "M-018"}` : `Миксер ${i.inventoryNo ?? "(новый, без номера)"}`,
        photoCount: 0,
        registeredAt: i.inventoryNo === "M-017" ? "Kaffit-04 · слот 1" : found ? "warehouse" : null,
      };
      lines.set(id, line);
      return { line, status: found ? "found" : "new", how: found ? "number" : null };
    },
    partCountSkipPhoto: async (id: string, reason: string) => {
      calls.push(`skip:${id.slice(-1)}:${reason}`);
      return {};
    },
    partCountRemoveLine: async (id: string) => {
      calls.push(`remove:${id.slice(-1)}`);
      lines.delete(id);
      return {};
    },
    uploadPhoto: async (i: { ownerType: string; ownerId: string; stage?: string }) => {
      calls.push(`photo:${i.ownerType}:${i.ownerId.slice(-1)}:${i.stage ?? "-"}`);
      return { id: "a1", url: "/x" };
    },
    partCountFinish: async () => {
      calls.push("finish");
      return {
        session: { id: SESSION, location: "warehouse", startedAt: "", finishedAt: "x", appliedAt: null },
        lines: [...lines.values()],
        expected: [],
        found: 1,
        fresh: 1,
        moved: 1,
        missing: [{ inventoryNo: "M-005", label: "Миксер M-005" }, { inventoryNo: null, label: "Бункер (без номера)" }],
        photoRequired: true,
      };
    },
  } as never;
  return { core, calls };
}

const FILE = { bytes: Buffer.from("jpg"), mime: "image/jpeg" };

describe("Мастер «🗂 Инвентаризация узлов» (pc:)", () => {
  it("триггер не отбирает «инвентаризацию» у склада и узнаёт узлы", () => {
    assert.equal(isPartCountTrigger("инвентаризация узлов"), true);
    assert.equal(isPartCountTrigger("посчитать узлы на мойке"), true);
    assert.equal(isPartCountTrigger("инвентаризация"), false, "без «узлов» — складская инвентаризация");
    assert.equal(isPartCountTrigger("инвентарные номера"), false);
  });

  it("разбор кнопок: место и вид с проверкой, простые — таблицей", () => {
    assert.deepEqual(parsePartCountCallback("pc:l:washing"), { kind: "location", location: "washing" });
    assert.equal(parsePartCountCallback("pc:l:machine"), null, "автомат сессией не считают");
    assert.deepEqual(parsePartCountCallback("pc:k:mixer"), { kind: "part", part: "mixer" });
    assert.equal(parsePartCountCallback("pc:k:nope"), null);
    assert.deepEqual(parsePartCountCallback("pc:f"), { kind: "finish" });
    assert.equal(parsePartCountCallback("pt:x"), null);
  });

  it("место → вид → номер → серийник → запись ДО фото → фото → следующий; финиш даёт сводку", async () => {
    const { core, calls } = stubCore();
    const conversations = new Conversations();
    const deps = { core, conversations };
    const start = await startPartCount(777, ME, deps);
    assert.match(start.text, /Где считаем/);
    const loc = await handlePartCountCallback(777, { kind: "location", location: "warehouse" }, ME, deps);
    assert.equal(calls[0], "start:warehouse");
    assert.match(loc.message!.text, /По учёту здесь 4 узлов/);
    assert.equal(conversations.get(777)?.step, "kind");

    await handlePartCountCallback(777, { kind: "part", part: "mixer" }, ME, deps);
    assert.equal(conversations.get(777)?.step, "number");
    const afterNo = await handlePartCountText(777, "M-017", ME, deps);
    assert.match(afterNo.text, /Серийник/);
    const recorded = await handlePartCountCallback(777, { kind: "noSerial" }, ME, deps);
    assert.match(calls[1], /^line:mixer:M-017:-:pc:.+:1$/, "строка ушла в Core до фото, с ключом идемпотентности");
    assert.match(recorded.message!.text, /найден, но числился на «Kaffit-04 · слот 1»/);
    assert.match(recorded.message!.text, /фото обязательно/);
    assert.equal(conversations.get(777)?.step, "photo");

    const photo = await handlePartCountPhoto(777, FILE, ME, deps);
    assert.equal(calls[2], "photo:part_count_line:1:count");
    assert.match(photo!.text, /Фото есть/);
    assert.match(photo!.text, /введено 1/);
    assert.equal(conversations.get(777)?.step, "kind");

    // второй узел: без номера, по серийнику
    await handlePartCountCallback(777, { kind: "part", part: "mixer" }, ME, deps);
    await handlePartCountCallback(777, { kind: "noNumber" }, ME, deps);
    const rec2 = await handlePartCountText(777, "SN-B", ME, deps);
    assert.match(calls[3], /^line:mixer:-:SN-B:pc:.+:2$/);
    assert.match(rec2.text, /найден\./);
    // без фото — причина
    const why = await handlePartCountCallback(777, { kind: "noPhoto" }, ME, deps);
    assert.match(why.message!.text, /Почему без фото/);
    assert.equal(conversations.get(777)?.step, "reason");
    await handlePartCountText(777, "телефон сел", ME, deps);
    assert.equal(calls[4], "skip:2:телефон сел");
    assert.equal(conversations.get(777)?.step, "kind");

    const fin = await handlePartCountCallback(777, { kind: "finish" }, ME, deps);
    assert.equal(calls[5], "finish");
    assert.match(fin.message!.text, /найдено 1, новых 1, числились не здесь 1/);
    assert.match(fin.message!.text, /Не найдено 2: M-005, Бункер \(без номера\)/);
    assert.match(fin.message!.text, /Владелец применит/);
    assert.equal(conversations.get(777), null);
  });

  it("отказ Core по строке возвращает на ввод номера, а не роняет мастер", async () => {
    const { core } = stubCore();
    const conversations = new Conversations();
    const deps = { core, conversations };
    await startPartCount(777, ME, deps);
    await handlePartCountCallback(777, { kind: "location", location: "washing" }, ME, deps);
    await handlePartCountCallback(777, { kind: "part", part: "mixer" }, ME, deps);
    await handlePartCountText(777, "M-001", ME, deps);
    const res = await handlePartCountCallback(777, { kind: "noSerial" }, ME, deps);
    assert.match(res.message!.text, /уже посчитан/);
    assert.equal(conversations.get(777)?.step, "number");
  });

  it("фото не обязательно — «Без фото» идёт дальше без причины; «Убрать строку» зовёт Core", async () => {
    const { core, calls } = stubCore({ photoRequired: false });
    const conversations = new Conversations();
    const deps = { core, conversations };
    await startPartCount(777, ME, deps);
    await handlePartCountCallback(777, { kind: "location", location: "drying" }, ME, deps);
    await handlePartCountCallback(777, { kind: "part", part: "grinder" }, ME, deps);
    await handlePartCountCallback(777, { kind: "noNumber" }, ME, deps);
    const rec = await handlePartCountCallback(777, { kind: "noSerial" }, ME, deps);
    assert.match(rec.message!.text, /в реестре нет, карточка заведётся/);
    assert.match(rec.message!.text, /если есть чем/);
    await handlePartCountCallback(777, { kind: "noPhoto" }, ME, deps);
    assert.equal(conversations.get(777)?.step, "kind");
    assert.ok(!calls.some((c) => c.startsWith("skip:")));

    await handlePartCountCallback(777, { kind: "part", part: "grinder" }, ME, deps);
    await handlePartCountCallback(777, { kind: "noNumber" }, ME, deps);
    await handlePartCountCallback(777, { kind: "noSerial" }, ME, deps);
    const rm = await handlePartCountCallback(777, { kind: "removeLine" }, ME, deps);
    assert.equal(calls.at(-1), "remove:2");
    assert.match(rm.message!.text, /введено 1/, "счётчик откатился");
  });

  it("продолжение начатой сессии называется своими словами; фото вне шага не перехватывается", async () => {
    const { core } = stubCore({ resumed: true });
    const conversations = new Conversations();
    const deps = { core, conversations };
    await startPartCount(777, ME, deps);
    const loc = await handlePartCountCallback(777, { kind: "location", location: "warehouse" }, ME, deps);
    assert.match(loc.message!.text, /Продолжаем начатую сессию/);
    assert.equal(await handlePartCountPhoto(777, FILE, ME, deps), null);
    const cancel = await handlePartCountCallback(777, { kind: "cancel" }, ME, deps);
    assert.match(cancel.message!.text, /сессия ждёт в Core/);
    assert.equal(conversations.get(777), null);
  });
});
