import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Conversations } from "./conversation";
import type { PersonRow, TaskRow } from "./core-client";
import {
  attachBeforePhoto,
  handleTaskDoneCallback,
  handleTaskDonePhoto,
  handleTaskDoneReport,
  parseTaskDoneCallback,
  startTaskDone,
} from "./task-done";

const ME: PersonRow = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Рустам",
  role: "оператор",
  // Оба действующих сотрудника делают всю работу.
  roles: ["operator", "technician", "collector", "storekeeper"],
  tgUsername: "rustam",
  tgChatId: "555",
  active: "yes",
};

const TASK: TaskRow = {
  id: "22222222-2222-4222-8222-222222222222",
  title: "Помыть миксер на Kaffit-04",
  description: null,
  ownerKind: "human",
  ownerRef: ME.id,
  status: "in_progress",
  priority: "normal",
  due: null,
  resultNote: null,
  entityId: null,
};

const FILE = { bytes: Buffer.from("jpeg"), mime: "image/jpeg" };

/** Заглушка Core: копит вызовы, чтобы проверить, что именно ушло. */
function stubCore(over: Record<string, unknown> = {}) {
  const calls: string[] = [];
  const core = {
    uploadPhoto: async (i: { ownerType: string; ownerId: string; stage?: string; filename: string }) => {
      calls.push(`photo:${i.ownerType}:${i.ownerId}:${i.stage ?? "-"}:${i.filename}`);
      return { id: "a1", url: "/x" };
    },
    setTaskStatus: async (id: string, status: string, actor: string, note?: string) => {
      calls.push(`status:${id}:${status}:${actor}:${note ?? ""}`);
      return TASK;
    },
    attachmentsOfOwner: async () => [],
    ...over,
  } as never;
  return { core, calls };
}

describe("Разбор кнопок закрытия задачи", () => {
  it("принимает только своё пространство dn:", () => {
    assert.deepEqual(parseTaskDoneCallback("dn:ok"), { kind: "send" });
    assert.deepEqual(parseTaskDoneCallback("dn:np"), { kind: "noPhoto" });
    assert.deepEqual(parseTaskDoneCallback("dn:x"), { kind: "cancel" });
    assert.equal(parseTaskDoneCallback("dn:"), null);
    assert.equal(parseTaskDoneCallback("t:22222222-2222-4222-8222-222222222222:done"), null);
    assert.equal(parseTaskDoneCallback("r:cancel"), null);
    assert.equal(parseTaskDoneCallback(""), null);
  });
});

describe("Мастер закрытия: отчёт → фото → отправка", () => {
  it("проходит целиком и закрывает задачу с отчётом и фото", async () => {
    const conversations = new Conversations();
    const { core, calls } = stubCore();
    const deps = { core, conversations };

    const start = startTaskDone(1, TASK, deps);
    assert.match(start.text, /Что сделано/i);
    assert.equal(conversations.get(1)?.step, "report");

    const afterReport = handleTaskDoneReport(1, "Промыл миксер и бункер", deps);
    assert.match(afterReport.text, /Промыл миксер/);
    assert.equal(conversations.get(1)?.step, "photo");

    const afterPhoto = await handleTaskDonePhoto(1, FILE, ME, deps);
    assert.match(afterPhoto!.text, /Фото принято \(1\)/);
    assert.equal(calls[0], `photo:task:${TASK.id}:after:after-1.jpg`);

    const sent = await handleTaskDoneCallback(1, { kind: "send" }, ME, deps);
    assert.match(sent.message!.text, /Закрыл/);
    assert.match(sent.message!.text, /Фото: 1/);
    assert.equal(conversations.get(1), null, "мастер должен закрыться");
    assert.match(calls[1], /status:.*:done:person:.*:Промыл миксер и бункер/);
  });

  it("«без фото» проговаривается в отчёте, а не теряется", async () => {
    // Владелец должен видеть отсутствие доказательства, не заходя в галерею.
    const conversations = new Conversations();
    const { core, calls } = stubCore();
    const deps = { core, conversations };
    startTaskDone(1, TASK, deps);
    handleTaskDoneReport(1, "Заменил фильтр", deps);

    const sent = await handleTaskDoneCallback(1, { kind: "noPhoto" }, ME, deps);
    assert.match(sent.message!.text, /Без фото/i);
    assert.match(calls[0], /:Заменил фильтр \(без фото\)/);
  });

  it("слишком короткий отчёт не принимается и шаг не двигается", () => {
    const conversations = new Conversations();
    const { core } = stubCore();
    const deps = { core, conversations };
    startTaskDone(1, TASK, deps);

    const res = handleTaskDoneReport(1, "ок", deps);
    assert.match(res.text, /Слишком коротко/i);
    assert.equal(conversations.get(1)?.step, "report", "остаёмся на отчёте");
  });

  it("отмена не закрывает задачу", async () => {
    const conversations = new Conversations();
    const { core, calls } = stubCore();
    const deps = { core, conversations };
    startTaskDone(1, TASK, deps);
    handleTaskDoneReport(1, "Что-то сделал", deps);

    const res = await handleTaskDoneCallback(1, { kind: "cancel" }, ME, deps);
    assert.match(res.message!.text, /осталась в работе/i);
    assert.deepEqual(calls, [], "отмена не должна ничего записывать");
    assert.equal(conversations.get(1), null);
  });

  it("кнопка на истёкшем мастере просит начать заново, а не падает", async () => {
    const conversations = new Conversations();
    const { core, calls } = stubCore();
    const res = await handleTaskDoneCallback(1, { kind: "send" }, ME, { core, conversations });
    assert.match(res.message!.text, /заново/i);
    assert.deepEqual(calls, []);
  });

  it("отправка без отчёта невозможна — задача не закроется молча", async () => {
    const conversations = new Conversations();
    const { core, calls } = stubCore();
    const deps = { core, conversations };
    startTaskDone(1, TASK, deps);
    // Пропускаем шаг отчёта и сразу жмём «Отправить».
    conversations.advance(1, "photo", {});

    const res = await handleTaskDoneCallback(1, { kind: "send" }, ME, deps);
    assert.match(res.answer, /Нет отчёта/i);
    assert.deepEqual(calls, [], "закрытие без отчёта ничего не объясняет владельцу");
  });

  it("несколько фото копятся, счётчик растёт", async () => {
    const conversations = new Conversations();
    const { core, calls } = stubCore();
    const deps = { core, conversations };
    startTaskDone(1, TASK, deps);
    handleTaskDoneReport(1, "Промыл бункеры", deps);

    await handleTaskDonePhoto(1, FILE, ME, deps);
    const second = await handleTaskDonePhoto(1, FILE, ME, deps);
    assert.match(second!.text, /\(2\)/);
    assert.equal(calls[1], `photo:task:${TASK.id}:after:after-2.jpg`);

    const sent = await handleTaskDoneCallback(1, { kind: "send" }, ME, deps);
    assert.match(sent.message!.text, /Фото: 2/);
  });

  it("фото вне шага «photo» этот мастер не забирает", async () => {
    // Иначе снимок на шаге отчёта улетел бы в задачу вместо карточки, которую
    // сотрудник в этот момент заводит.
    const conversations = new Conversations();
    const { core } = stubCore();
    const deps = { core, conversations };
    startTaskDone(1, TASK, deps);
    assert.equal(await handleTaskDonePhoto(1, FILE, ME, deps), null);
  });
});

describe("Фото «до» вне мастера", () => {
  it("прикладывается к задаче в работе со стадией before", async () => {
    const { core, calls } = stubCore();
    const reply = await attachBeforePhoto(TASK, FILE, ME, { core, conversations: new Conversations() });
    assert.match(reply.text, /как «до»/);
    assert.equal(calls[0], `photo:task:${TASK.id}:before:before-1.jpg`);
  });

  it("нумеруется с учётом уже приложенных «до»", async () => {
    const { core, calls } = stubCore({
      attachmentsOfOwner: async () => [
        { id: "a1", kind: "photo", stage: "before" },
        { id: "a2", kind: "photo", stage: "after" },
      ],
    });
    await attachBeforePhoto(TASK, FILE, ME, { core, conversations: new Conversations() });
    assert.equal(calls[0], `photo:task:${TASK.id}:before:before-2.jpg`, "«после» не должно сдвигать нумерацию «до»");
  });

  it("недоступный список вложений не срывает загрузку", async () => {
    // Фото важнее точного номера в имени файла: терять снимок из-за сбоя
    // вспомогательного запроса нельзя.
    const { core, calls } = stubCore({
      attachmentsOfOwner: async () => {
        throw new Error("Core недоступен");
      },
    });
    const reply = await attachBeforePhoto(TASK, FILE, ME, { core, conversations: new Conversations() });
    assert.match(reply.text, /как «до»/);
    assert.equal(calls[0], `photo:task:${TASK.id}:before:before-1.jpg`);
  });
});
