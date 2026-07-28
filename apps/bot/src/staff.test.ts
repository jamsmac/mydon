import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AwaitingReport,
  formatMyTasks,
  handleStaffCallback,
  handleStaffMessage,
  parseTaskCallback,
  taskKeyboard,
} from "./staff";
import type { PersonRow, TaskRow } from "./core-client";
import { parseIntent } from "./intent";
import { planReport } from "./reports";

const ME: PersonRow = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Рустам",
  role: "оператор",
  tgUsername: "rustam",
  tgChatId: "555",
  active: "yes",
};

function task(over: Partial<TaskRow> = {}): TaskRow {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    title: "Пополнить автомат №5",
    description: null,
    ownerKind: "human",
    ownerRef: ME.id,
    status: "todo",
    priority: "normal",
    due: null,
    resultNote: null,
    ...over,
  };
}

/** Заглушка Core: записывает вызовы, чтобы проверить, что именно сделано. */
function stubCore(over: Record<string, unknown> = {}) {
  const calls: string[] = [];
  const core = {
    myTasks: async () => [task()],
    task: async () => task(),
    setTaskStatus: async (_id: string, status: string, actor: string, note?: string) => {
      calls.push(`status:${status}:${actor}${note ? `:${note}` : ""}`);
      return task({ status: status as TaskRow["status"] });
    },
    addTaskComment: async (_id: string, body: string) => {
      calls.push(`comment:${body}`);
      return {};
    },
    ...over,
  } as never;
  return { core, calls };
}

describe("Разбор кнопок задачи", () => {
  it("принимает только свой строгий формат", () => {
    const ok = parseTaskCallback("t:22222222-2222-4222-8222-222222222222:done");
    assert.equal(ok?.action, "done");
    assert.equal(parseTaskCallback("t:не-uuid:done"), null);
    assert.equal(parseTaskCallback("ap:approved:22222222-2222-4222-8222-222222222222"), null);
    assert.equal(parseTaskCallback("t:22222222-2222-4222-8222-222222222222:drop"), null);
    assert.equal(parseTaskCallback(""), null);
  });

  it("кнопка «Взял» не показывается, если задача уже в работе", () => {
    const inWork = taskKeyboard(task({ status: "in_progress" }));
    const texts = inWork!.inline_keyboard[0].map((b) => b.text).join(" ");
    assert.ok(!texts.includes("Взял"), "лишняя кнопка сбивает с толку");
    assert.ok(texts.includes("Сделал"));
  });
});

describe("Доступ сотрудника: только свои задачи", () => {
  it("чужую задачу закрыть нельзя", async () => {
    const { core, calls } = stubCore({
      task: async () => task({ ownerRef: "99999999-9999-4999-8999-999999999999" }),
    });
    const res = await handleStaffCallback(555, `t:${task().id}:done`, ME, {
      core,
      awaiting: new AwaitingReport(),
    });
    assert.match(res.answer, /не твоя/i);
    assert.deepEqual(calls, [], "никаких изменений по чужой задаче быть не должно");
  });

  it("задачу агента сотрудник тоже не трогает", async () => {
    const { core, calls } = stubCore({
      task: async () => task({ ownerKind: "agent", ownerRef: "mydon-finance" }),
    });
    const res = await handleStaffCallback(555, `t:${task().id}:done`, ME, {
      core,
      awaiting: new AwaitingReport(),
    });
    assert.match(res.answer, /не твоя/i);
    assert.deepEqual(calls, []);
  });

  it("чужой отчёт не проходит, даже если id угадан", async () => {
    const awaiting = new AwaitingReport();
    awaiting.set(555, task().id);
    const { core, calls } = stubCore({
      task: async () => task({ ownerRef: "99999999-9999-4999-8999-999999999999" }),
    });
    const res = await handleStaffMessage(555, "сделал", ME, { core, awaiting });
    assert.match(res.reply.text, /не на тебе/i);
    assert.deepEqual(calls, []);
  });
});

describe("Закрытие с отчётом", () => {
  it("«Сделал» не закрывает сразу, а просит отчёт", async () => {
    const awaiting = new AwaitingReport();
    const { core, calls } = stubCore();
    const res = await handleStaffCallback(555, `t:${task().id}:done`, ME, { core, awaiting });
    assert.match(res.message ?? "", /что сделано/i);
    assert.deepEqual(calls, [], "закрытия без отчёта быть не должно");
  });

  it("следующее сообщение становится отчётом и закрывает задачу", async () => {
    const awaiting = new AwaitingReport();
    awaiting.set(555, task().id);
    const { core, calls } = stubCore();
    const res = await handleStaffMessage(555, "Пополнил, всё работает", ME, { core, awaiting });
    assert.match(res.reply.text, /закрыта/i);
    assert.equal(calls.length, 1);
    assert.match(calls[0], /status:done:person:.*:Пополнил, всё работает/);
  });

  it("«Взял» отмечает работу сразу, без отчёта", async () => {
    const { core, calls } = stubCore();
    const res = await handleStaffCallback(555, `t:${task().id}:progress`, ME, {
      core,
      awaiting: new AwaitingReport(),
    });
    assert.match(res.answer, /в работе/i);
    assert.match(calls[0] ?? "", /status:in_progress/);
  });

  it("забытое ожидание отчёта истекает и не портит следующий разговор", () => {
    const awaiting = new AwaitingReport(1000);
    awaiting.set(555, "task-1", 0);
    assert.equal(awaiting.take(555, 5000), null, "просроченное ожидание не должно срабатывать");
  });
});

describe("Что видит сотрудник", () => {
  it("пустой список — это хорошая новость, а не ошибка", () => {
    const text = formatMyTasks(ME, []);
    assert.match(text, /задач на тебе нет/i);
  });

  it("в списке видно срочность и срок", () => {
    const text = formatMyTasks(ME, [task({ priority: "urgent", due: null })]);
    assert.match(text, /🔥/);
    assert.match(text, /без срока/);
  });

  it("свободный текст при одной задаче уходит комментарием владельцу", async () => {
    const { core, calls } = stubCore();
    const res = await handleStaffMessage(555, "Ключей нет, охрана не пускает", ME, {
      core,
      awaiting: new AwaitingReport(),
    });
    assert.match(res.reply.text, /передал владельцу/i);
    assert.match(calls[0] ?? "", /comment:Ключей нет/);
  });
});

describe("Отчёты файлами", () => {
  it("«excel по дебиторке» — это просьба о файле, а не сводка", () => {
    const i = parseIntent("сделай excel по дебиторке");
    assert.equal(i.kind, "report");
    if (i.kind === "report") {
      assert.equal(i.format, "xlsx");
      assert.equal(i.topic, "receivables");
    }
  });

  it("слово «word» даёт документ, а не таблицу", () => {
    const i = parseIntent("отчёт в word по задачам");
    assert.equal(i.kind, "report");
    if (i.kind === "report") {
      assert.equal(i.format, "docx");
      assert.equal(i.topic, "tasks");
    }
  });

  it("направление из запроса попадает в отчёт", () => {
    const i = parseIntent("выгрузи таблицу по вендхаб");
    assert.equal(i.kind, "report");
    if (i.kind === "report") assert.equal(i.domain, "vendhub");
  });

  it("обычный вопрос про долги остаётся вопросом, а не файлом", () => {
    assert.equal(parseIntent("что просрочено").kind, "overdue");
  });

  it("в отчёт по дебиторке идут данные Core, а не выдумка модели", async () => {
    const core = {
      obligations: async () => ({
        domain: "globerent",
        totals: [{ status: "plan", count: 3 }],
        overdue: [{ id: "1", amount: "5000000", currency: "UZS", date: "2026-03-01" }],
        overdueTotal: 7,
        overdueTruncated: true,
      }),
    } as never;
    const plan = await planReport({ format: "xlsx", topic: "receivables" }, core);
    assert.equal(plan.kind, "xlsx");
    assert.match(plan.filename, /Дебиторка/);
    // Про урезанный список модель обязана предупредить в документе.
    assert.match(plan.instruction, /список неполный/i);
    const data = plan.data as Record<string, unknown>;
    assert.equal(data.всего_просрочено_позиций, 7);
  });

  it("нет просрочек — файл не строим, объясняем словами", async () => {
    const core = {
      obligations: async () => ({
        domain: "globerent",
        totals: [],
        overdue: [],
        overdueTotal: 0,
        overdueTruncated: false,
      }),
    } as never;
    const plan = await planReport({ format: "xlsx", topic: "receivables" }, core);
    assert.match(plan.emptyReason ?? "", /просрочек нет/i);
  });
});
