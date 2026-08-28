import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TaskRow } from "./core-client";
import { внутриРабочихЧасов } from "./push-hours";
import { доставитьНазначения } from "./tasks-push";

const РАБОЧЕЕ = new Date("2026-08-26T10:00:00+05:00");
const НОЧЬ = new Date("2026-08-26T23:40:00+05:00");
const PERSON = "11111111-1111-4111-8111-111111111111";

const задача = (over: Partial<TaskRow> = {}): TaskRow =>
  ({
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    title: "Пополнить Olma",
    description: null,
    ownerKind: "human",
    ownerRef: PERSON,
    status: "todo",
    priority: "high",
    due: "2026-08-27T05:00:00.000Z",
    resultNote: null,
    entityId: null,
    quality: null,
    completedAt: null,
    closedBy: null,
    confirmedAt: null,
    confirmedBy: null,
    assignNotifiedAt: null,
    ...over,
  }) as TaskRow;

class Недоступен extends Error {
  readonly isUnreachable = true;
  readonly description = "bot was blocked by the user";
}

function стенд(opts: { задачи: TaskRow[]; чат?: string | null; падать?: Error; отметкаПадает?: boolean }) {
  const порядок: string[] = [];
  const отправлено: { chat: number; text: string }[] = [];
  const отмечено: string[] = [];
  const жалобы: string[] = [];
  const deps = {
    assignUnnotified: async () => opts.задачи,
    people: async () => [{ id: PERSON, tgChatId: opts.чат === undefined ? "111" : opts.чат }],
    markAssignNotified: async (id: string) => {
      if (opts.отметкаПадает) throw new Error("Core unavailable");
      порядок.push("mark");
      отмечено.push(id);
    },
    send: async (chat: number, text: string) => {
      if (opts.падать) throw opts.падать;
      порядок.push("send");
      отправлено.push({ chat, text });
    },
    reportUnreachable: async (personId: string) => {
      жалобы.push(personId);
    },
    isUnreachable: (e: unknown) => e instanceof Недоступен,
  };
  return { deps, порядок, отправлено, отмечено, жалобы };
}

describe("Пуш «тебе поручили» (П7, R-P7-10/R-P7-11)", () => {
  it("доставили → отметили, именно в таком порядке", async () => {
    const st = стенд({ задачи: [задача()] });
    await доставитьНазначения(st.deps, РАБОЧЕЕ);
    assert.deepEqual(st.порядок, ["send", "mark"]);
    assert.match(st.отправлено[0]!.text, /📌 Тебе поручили: Пополнить Olma/);
    assert.deepEqual(st.отмечено, ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"]);
  });

  it("при сбое Telegram отметки нет", async () => {
    const st = стенд({ задачи: [задача()], падать: new Error("500 from Telegram") });
    await доставитьНазначения(st.deps, РАБОЧЕЕ);
    assert.deepEqual(st.отмечено, []);
  });

  it("сбой отметки после доставки сохраняет повтор — назначение не теряется", async () => {
    const st = стенд({ задачи: [задача()], отметкаПадает: true });
    await доставитьНазначения(st.deps, РАБОЧЕЕ);
    assert.equal(st.отправлено.length, 1);
    assert.deepEqual(st.отмечено, []);
  });

  it("недоступный чат: жалоба владельцу и отметка без повторного долбления", async () => {
    const st = стенд({ задачи: [задача()], падать: new Недоступен() });
    await доставитьНазначения(st.deps, РАБОЧЕЕ);
    assert.deepEqual(st.жалобы, [PERSON]);
    assert.deepEqual(st.отмечено, ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"]);
  });

  it("вне рабочих часов пуш и отметка ждут утра", async () => {
    assert.equal(внутриРабочихЧасов(НОЧЬ), false);
    const st = стенд({ задачи: [задача()] });
    await доставитьНазначения(st.deps, НОЧЬ);
    assert.deepEqual(st.отправлено, []);
    assert.deepEqual(st.отмечено, []);
  });

  it("исполнитель без Telegram пропускается без отметки", async () => {
    const st = стенд({ задачи: [задача()], чат: null });
    await доставитьНазначения(st.deps, РАБОЧЕЕ);
    assert.deepEqual(st.отправлено, []);
    assert.deepEqual(st.отмечено, []);
  });

  it("испорченный chat_id не отправляется как NaN и не отмечается", async () => {
    const st = стенд({ задачи: [задача()], чат: "не-число" });
    await доставитьНазначения(st.deps, РАБОЧЕЕ);
    assert.deepEqual(st.отправлено, []);
    assert.deepEqual(st.отмечено, []);
  });
});
