import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Conversations } from "./conversation";
import type { PersonRow } from "./core-client";
import {
  finishAfterPhoto,
  handleAfterPhoto,
  handleCleanCallback,
  handlePartReplaceCallback,
  handlePartSerial,
  handleProblemCallback,
  handleServiceCheckCallback,
  onObjectPicked,
  parseAfterPhotoCallback,
  parseCleanCallback,
  parsePartReplaceCallback,
  parseProblemCallback,
  parseServiceCheckCallback,
  startPartReplace,
  startProblem,
} from "./field-work";
import { parsePickerCallback, searchObjects } from "./machine-picker";

const ME: PersonRow = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Володя",
  role: "техник",
  roles: ["operator", "technician", "collector", "storekeeper"],
  tgUsername: "volodya",
  tgChatId: "555",
  active: "yes",
};

const MACHINE = "22222222-2222-4222-8222-222222222222";

function stubCore(over: Record<string, unknown> = {}) {
  const calls: string[] = [];
  const core = {
    recentObjects: async () => [{ id: MACHINE, name: "Kaffit-04 · БЦ «Пойтахт»" }],
    machines: async () => [
      { id: MACHINE, name: "Kaffit-04 · БЦ «Пойтахт»" },
      { id: "33333333-3333-4333-8333-333333333333", name: "Snack-11 · ТЦ «Компас»" },
    ],
    swapPart: async (i: Record<string, unknown>) => {
      calls.push(`swap:${String(i.partKind)}:${String(i.newSerial ?? "-")}:${String(i.reason ?? "-")}`);
      return { log: { id: "log-1" }, removed: { serialNumber: "OLD-1" } };
    },
    createMaintenanceLog: async (i: Record<string, unknown>) => {
      calls.push(`log:${String(i.kind)}:${String(i.partKind ?? "-")}:${String(i.outcome ?? "-")}`);
      return { id: "log-2" };
    },
    createTask: async (i: Record<string, unknown>) => {
      calls.push(`task:${String(i.priority)}:${String(i.title)}:owner=${String(i.ownerRef ?? "-")}`);
      return { id: "task-1" };
    },
    uploadPhoto: async (i: Record<string, unknown>) => {
      calls.push(`photo:${String(i.ownerType)}:${String(i.ownerId)}:${String(i.stage)}`);
      return { id: "a1", url: "/x" };
    },
    setMachineStatus: async (entityId: string, status: string, actor: string) => {
      calls.push(`status:${entityId}:${status}:${actor}`);
      return {};
    },
    ...over,
  } as never;
  return { core, calls };
}

describe("Разбор кнопок полевых мастеров", () => {
  it("каждое пространство принимает только своё", () => {
    assert.deepEqual(parsePartReplaceCallback("pt:u:bill_acceptor"), {
      kind: "part",
      part: "bill_acceptor",
    });
    assert.deepEqual(parsePartReplaceCallback("pt:r:failure"), { kind: "reason", reason: "failure" });
    assert.equal(parsePartReplaceCallback("pt:u:выдумка"), null);
    assert.equal(parsePartReplaceCallback("pt:u:not_a_part"), null, "неизвестный узел не пройдёт");
    assert.equal(parsePartReplaceCallback("cl:w:mixer"), null);

    assert.deepEqual(parseCleanCallback("cl:w:mixer"), { kind: "target", part: "mixer" });
    assert.deepEqual(parseCleanCallback("cl:w:all"), { kind: "target", part: "all" });
    assert.equal(parseCleanCallback("cl:w:zzz"), null);

    assert.deepEqual(parseServiceCheckCallback("sv:t:metr"), { kind: "type", type: "metr" });
    assert.deepEqual(parseServiceCheckCallback("sv:r:fail"), { kind: "result", outcome: "failed" });
    assert.equal(parseServiceCheckCallback("sv:t:xxx"), null);

    assert.deepEqual(parseProblemCallback("pr:s:bill"), { kind: "symptom", symptom: "bill" });
    assert.deepEqual(parseProblemCallback("pr:u:1"), { kind: "urgency", urgency: "1" });
    assert.equal(parseProblemCallback("pr:u:9"), null);

    assert.deepEqual(parseAfterPhotoCallback("ph:ok"), { kind: "done" });
    assert.equal(parseAfterPhotoCallback("ph:no"), null);
  });

  it("callback_data укладывается в 64 байта и без кириллицы", () => {
    const samples = [
      "pt:u:payment_terminal",
      "pt:r:preventive",
      "cl:w:cooling_unit",
      "sv:t:metr",
      "pr:s:other",
      `mp:e:${MACHINE}`,
      "ph:ok",
    ];
    for (const s of samples) {
      assert.ok(Buffer.byteLength(s) <= 64, `${s} длиннее лимита`);
      assert.ok(!/[А-Яа-яЁё]/.test(s), `${s} содержит кириллицу`);
    }
  });
});

describe("Замена узла", () => {
  it("проходит путь объект → узел → серийник → причина и записывает", async () => {
    const conversations = new Conversations();
    const { core, calls } = stubCore();
    const deps = { core, conversations };

    const start = await startPartReplace(1, ME, deps);
    assert.match(start.text, /Замена детали/);
    assert.equal(conversations.get(1)?.step, "object");

    await onObjectPicked(1, MACHINE, deps);
    assert.equal(conversations.get(1)?.step, "part");

    const afterPart = await handlePartReplaceCallback(
      1,
      { kind: "part", part: "bill_acceptor" },
      ME,
      deps,
    );
    assert.match(afterPart.message!.text, /Купюроприёмник/);
    assert.equal(conversations.get(1)?.step, "serial");

    handlePartSerial(1, "SN-777", deps);
    assert.equal(conversations.get(1)?.step, "reason");

    const done = await handlePartReplaceCallback(1, { kind: "reason", reason: "failure" }, ME, deps);
    assert.equal(calls[0], "swap:bill_acceptor:SN-777:failure");
    assert.match(done.message!.text, /Записал замену/);
    assert.match(done.message!.text, /Снят: OLD-1/, "техник должен видеть, что именно сняли");
  });

  it("«не знаю номер» не блокирует запись", async () => {
    // Шильдик бывает залит кофе или заклеен. Отказ записать работу из-за
    // непрочитанного номера означает, что работу не запишут вовсе.
    const conversations = new Conversations();
    const { core, calls } = stubCore();
    const deps = { core, conversations };
    await startPartReplace(1, ME, deps);
    await onObjectPicked(1, MACHINE, deps);
    await handlePartReplaceCallback(1, { kind: "part", part: "grinder" }, ME, deps);
    await handlePartReplaceCallback(1, { kind: "noSerial" }, ME, deps);
    await handlePartReplaceCallback(1, { kind: "reason", reason: "preventive" }, ME, deps);
    assert.equal(calls[0], "swap:grinder:-:preventive");
  });

  it("первая установка объясняется словами, а не пустой строкой", async () => {
    const conversations = new Conversations();
    const { core } = stubCore({
      swapPart: async () => ({ log: { id: "log-1" }, removed: null }),
    });
    const deps = { core, conversations };
    await startPartReplace(1, ME, deps);
    await onObjectPicked(1, MACHINE, deps);
    await handlePartReplaceCallback(1, { kind: "part", part: "mixer" }, ME, deps);
    await handlePartReplaceCallback(1, { kind: "noSerial" }, ME, deps);
    const done = await handlePartReplaceCallback(1, { kind: "reason", reason: "upgrade" }, ME, deps);
    assert.match(done.message!.text, /Первая установка/);
  });

  it("редкие узлы прячутся за «ещё»", async () => {
    const conversations = new Conversations();
    const { core } = stubCore();
    const deps = { core, conversations };
    await startPartReplace(1, ME, deps);
    const picked = await onObjectPicked(1, MACHINE, deps);
    const labels = picked.keyboard!.inline_keyboard.flat().map((b) => b.text);
    assert.ok(labels.includes("Купюроприёмник"), "частое — сразу");
    assert.ok(!labels.includes("Лифт выдачи"), "редкое — за «ещё»");
    assert.ok(labels.some((l) => l.includes("Другой узел")));

    const all = await handlePartReplaceCallback(1, { kind: "morePartsPage" }, ME, deps);
    const allLabels = all.message!.keyboard!.inline_keyboard.flat().map((b) => b.text);
    assert.ok(allLabels.includes("Лифт выдачи"));
  });

  it("отмена не пишет ничего", async () => {
    const conversations = new Conversations();
    const { core, calls } = stubCore();
    const deps = { core, conversations };
    await startPartReplace(1, ME, deps);
    await handlePartReplaceCallback(1, { kind: "cancel" }, ME, deps);
    assert.equal(conversations.get(1), null);
    assert.deepEqual(calls, []);
  });
});

describe("Чистка автомата", () => {
  it("узел пишется в partKind, «целиком» — без него", async () => {
    const conversations = new Conversations();
    const { core, calls } = stubCore();
    const deps = { core, conversations };
    conversations.start(1, "clean", "target", { entityId: MACHINE, entityName: "Kaffit-04" });
    await handleCleanCallback(1, { kind: "target", part: "mixer" }, ME, deps);
    assert.equal(calls[0], "log:cleaning:mixer:done");

    conversations.start(1, "clean", "target", { entityId: MACHINE, entityName: "Kaffit-04" });
    await handleCleanCallback(1, { kind: "target", part: "all" }, ME, deps);
    assert.equal(calls[1], "log:cleaning:-:done");
  });

  it("санобработка — отдельный вид работы, не чистка", async () => {
    // У них разная периодичность и разные требования, считать их одним
    // значит потерять срок того, что делается реже.
    const conversations = new Conversations();
    const { core, calls } = stubCore();
    const deps = { core, conversations };
    conversations.start(1, "clean", "target", { entityId: MACHINE, entityName: "Kaffit-04" });
    await handleCleanCallback(1, { kind: "sanitation" }, ME, deps);
    assert.equal(calls[0], "log:sanitation:-:done");
  });
});

describe("Технический осмотр", () => {
  it("плановое ТО, осмотр и поверка ложатся разными видами работ", async () => {
    // Иначе сроки трёх разных обязанностей считались бы как одна.
    const cases: [string, string][] = [
      ["plan", "service"],
      ["elec", "inspection"],
      ["sani", "inspection"],
      ["metr", "calibration"],
    ];
    for (const [type, kind] of cases) {
      const conversations = new Conversations();
      const { core, calls } = stubCore();
      const deps = { core, conversations };
      conversations.start(1, "service-check", "result", {
        entityId: MACHINE,
        entityName: "Kaffit-04",
        inspection: type,
      });
      await handleServiceCheckCallback(1, { kind: "result", outcome: "done" }, ME, deps);
      assert.equal(calls[0], `log:${kind}:-:done`, `${type} должен идти как ${kind}`);
    }
  });

  it("«не годен» проговаривается сотруднику", async () => {
    const conversations = new Conversations();
    const { core, calls } = stubCore();
    const deps = { core, conversations };
    conversations.start(1, "service-check", "result", {
      entityId: MACHINE,
      entityName: "Kaffit-04",
      inspection: "elec",
    });
    const res = await handleServiceCheckCallback(1, { kind: "result", outcome: "failed" }, ME, deps);
    assert.match(res.message!.text, /Не годен/);
    assert.match(res.message!.text, /брифинг/i, "человек должен знать, что владелец это увидит");
    assert.equal(calls[0], "log:inspection:-:failed");
  });
});

describe("Поломка", () => {
  it("создаёт свободную задачу, а не запись в журнале", async () => {
    // Работа ещё не сделана: это заявка. И она ничья — кто освободится,
    // тот и возьмёт, потому что закрепления за объектами нет.
    const conversations = new Conversations();
    const { core, calls } = stubCore();
    const deps = { core, conversations };
    await startProblem(1, ME, deps);
    await onObjectPicked(1, MACHINE, deps);
    await handleProblemCallback(1, { kind: "symptom", symptom: "bill" }, ME, deps);
    const res = await handleProblemCallback(1, { kind: "urgency", urgency: "1" }, ME, deps);

    assert.match(calls[0], /^task:urgent:Не принимает купюры/);
    assert.match(calls[0], /owner=-$/, "исполнителя быть не должно");
    assert.ok(
      !calls.some((c) => c.startsWith("log:")),
      "заявка — не выполненная работа",
    );
    assert.match(res.message!.text, /общем списке/i);
  });

  it("срочность переводится в приоритет задачи", async () => {
    const expected: [string, string][] = [
      ["1", "urgent"],
      ["2", "high"],
      ["3", "normal"],
    ];
    for (const [urgency, priority] of expected) {
      const conversations = new Conversations();
      const { core, calls } = stubCore();
      const deps = { core, conversations };
      conversations.start(1, "problem", "urgency", {
        entityId: MACHINE,
        entityName: "Kaffit-04",
        symptom: "jam",
      });
      await handleProblemCallback(1, { kind: "urgency", urgency: urgency as "1" | "2" | "3" }, ME, deps);
      assert.match(calls[0], new RegExp(`^task:${priority}:`));
    }
  });
});

describe("Фото после записи", () => {
  it("прикладывается к сохранённой записи, а не к мастеру", async () => {
    // Записываем сначала, снимаем потом: на точке рвётся связь, и при обрыве
    // должен теряться снимок, а не факт работы.
    const conversations = new Conversations();
    const { core, calls } = stubCore();
    const deps = { core, conversations };
    conversations.start(1, "clean", "target", { entityId: MACHINE, entityName: "Kaffit-04" });
    await handleCleanCallback(1, { kind: "target", part: "brewer" }, ME, deps);
    assert.equal(conversations.get(1)?.flow, "after-photo", "запись уже сохранена, фото — необязательно");

    const r = await handleAfterPhoto(1, { bytes: Buffer.from("x"), mime: "image/jpeg" }, ME, deps);
    assert.match(r!.text, /Приложил \(1\)/);
    assert.equal(calls[1], "photo:maintenance_log:log-2:after");

    const fin = finishAfterPhoto(1, deps);
    assert.match(fin.message!.text, /Фото по чистке: 1/);
    assert.equal(conversations.get(1), null);
  });

  it("без активного шага фото не перехватывается", async () => {
    const { core } = stubCore();
    const deps = { core, conversations: new Conversations() };
    assert.equal(await handleAfterPhoto(1, { bytes: Buffer.from("x"), mime: null }, ME, deps), null);
  });

  it("«Готово» без единого фото не выглядит ошибкой", async () => {
    const conversations = new Conversations();
    const { core } = stubCore();
    const deps = { core, conversations };
    conversations.start(1, "after-photo", "photo", { ownerType: "task", ownerId: "t1", what: "заявке" });
    const fin = finishAfterPhoto(1, deps);
    assert.equal(fin.message!.text, "Готово.");
  });
});

describe("Пикер объекта", () => {
  it("принимает только свой формат", () => {
    assert.deepEqual(parsePickerCallback(`mp:e:${MACHINE}`), { kind: "picked", id: MACHINE });
    assert.deepEqual(parsePickerCallback("mp:q"), { kind: "search" });
    assert.deepEqual(parsePickerCallback("mp:all"), { kind: "all" });
    assert.equal(parsePickerCallback("mp:e:не-uuid"), null);
    assert.equal(parsePickerCallback("t:tasks"), null);
  });

  it("поиск по подстроке находит без учёта регистра", async () => {
    const { core } = stubCore();
    const deps = { core, conversations: new Conversations() };
    const r = await searchObjects("КОМПАС", deps);
    assert.match(r.text, /Нашёл 1/);
    assert.match(r.keyboard!.inline_keyboard[0][0].text, /Snack-11/);
  });

  it("одна буква — просим больше, а не показываем весь парк", async () => {
    const { core } = stubCore();
    const deps = { core, conversations: new Conversations() };
    const r = await searchObjects("к", deps);
    assert.match(r.text, /две буквы/i);
  });

  it("ничего не нашлось — даём выход, а не тупик", async () => {
    const { core } = stubCore();
    const deps = { core, conversations: new Conversations() };
    const r = await searchObjects("щщщ", deps);
    assert.match(r.text, /ничего/i);
    assert.ok(r.keyboard!.inline_keyboard.flat().some((b) => b.callback_data === "mp:all"));
  });

  it("недоступные «недавние» не ломают выбор — падаем на общий список", async () => {
    const { core } = stubCore({
      recentObjects: async () => {
        throw new Error("Core недоступен");
      },
    });
    const conversations = new Conversations();
    const deps = { core, conversations };
    const r = await startPartReplace(1, ME, deps);
    assert.ok(r.keyboard, "выбор должен остаться возможным");
  });
});

describe("Заявка о поломке предлагает перевести автомат в ремонт", () => {
  it("после заявки появляется кнопка перевода, но не срабатывает сама", async () => {
    // Перевод — ПРЕДЛОЖЕНИЕ, а не следствие заявки: отказ купюроприёмника не
    // значит, что автомат не работает — он продолжает продавать за монеты.
    const { core, calls } = stubCore();
    const conversations = new Conversations();
    const deps = { core, conversations };

    await startProblem(1, ME, deps);
    await onObjectPicked(1, MACHINE, deps);
    await handleProblemCallback(1, { kind: "symptom", symptom: "dead" }, ME, deps);
    const итог = await handleProblemCallback(1, { kind: "urgency", urgency: "1" }, ME, deps);

    assert.ok(calls.some((c: string) => c.startsWith("task:")), "заявка должна быть создана");
    assert.ok(!calls.some((c: string) => c.startsWith("status:")), "состояние само меняться не должно");

    const кнопки = JSON.stringify(итог.message!.keyboard);
    assert.match(кнопки, new RegExp(`pr:rep:${MACHINE}`), "кнопка перевода обязана быть");
    assert.match(кнопки, /ph:ok/, "фото остаётся первой кнопкой");
  });

  it("нажатие переводит автомат в ремонт от имени сотрудника", async () => {
    const { core, calls } = stubCore();
    const conversations = new Conversations();
    const res = await handleProblemCallback(1, { kind: "repair", entityId: MACHINE }, ME, {
      core,
      conversations,
    });
    assert.ok(calls.includes(`status:${MACHINE}:repair:person:${ME.id}`));
    assert.match(res.message!.text, /в ремонте/i);
    assert.match(res.message!.text, /закрыт/i, "последствие надо назвать");
  });

  it("кнопка работает и когда мастер уже завершился", async () => {
    // Она висит под готовым сообщением: проверка живого разговора отвечала бы
    // «начни заново» на действие, которому разговор не нужен.
    const { core, calls } = stubCore();
    const res = await handleProblemCallback(1, { kind: "repair", entityId: MACHINE }, ME, {
      core,
      conversations: new Conversations(),
    });
    assert.ok(calls.some((c: string) => c.startsWith("status:")));
    assert.doesNotMatch(res.message!.text, /начни заново/i);
  });

  it("отказ Core не выдаётся за успех", async () => {
    const { core } = stubCore({
      setMachineStatus: async () => {
        throw new Error("Core недоступен");
      },
    });
    const res = await handleProblemCallback(1, { kind: "repair", entityId: MACHINE }, ME, {
      core,
      conversations: new Conversations(),
    });
    assert.match(res.message!.text, /Не смог/);
    assert.match(res.message!.text, /Заявка при этом создана/);
  });

  it("разбор кнопки перевода узнаёт только валидный uuid", () => {
    assert.deepEqual(parseProblemCallback(`pr:rep:${MACHINE}`), { kind: "repair", entityId: MACHINE });
    assert.equal(parseProblemCallback("pr:rep:не-uuid"), null);
  });
});

describe("Идемпотентность полевых мастеров: повтор той же кнопки несёт тот же ключ", () => {
  it("замена узла: ретрай после сбоя шлёт тот же clientKey, Core дедупит", async () => {
    const conversations = new Conversations();
    const keys: string[] = [];
    let fail = true;
    const { core } = stubCore({
      swapPart: async (i: Record<string, unknown>) => {
        keys.push(String(i.clientKey ?? ""));
        if (fail) throw new Error("таймаут");
        return { log: { id: "log-1" }, removed: null };
      },
    });
    const deps = { core, conversations };
    await startPartReplace(1, ME, deps);
    await onObjectPicked(1, MACHINE, deps);
    await handlePartReplaceCallback(1, { kind: "part", part: "grinder" }, ME, deps);
    await handlePartReplaceCallback(1, { kind: "noSerial" }, ME, deps);
    await assert.rejects(handlePartReplaceCallback(1, { kind: "reason", reason: "failure" }, ME, deps));

    fail = false;
    await handlePartReplaceCallback(1, { kind: "reason", reason: "failure" }, ME, deps);
    assert.equal(keys.length, 2);
    assert.match(keys[0], /^pt:.+:failure$/);
    assert.equal(keys[0], keys[1], "повтор ТОГО ЖЕ нажатия — тот же ключ");
  });

  it("другая кнопка после сбоя — ДРУГОЙ ключ: это другое действие, не повтор", async () => {
    const conversations = new Conversations();
    const keys: string[] = [];
    const { core } = stubCore({
      createMaintenanceLog: async (i: Record<string, unknown>) => {
        keys.push(String(i.clientKey ?? ""));
        return { id: "log-2" };
      },
    });
    const deps = { core, conversations };
    const { startClean } = await import("./field-work");
    await startClean(2, ME, deps);
    await onObjectPicked(2, MACHINE, deps);
    await handleCleanCallback(2, { kind: "target", part: "mixer" }, ME, deps);
    // Второй заход мастера — новый runId, санобработка — свой суффикс.
    await startClean(2, ME, deps);
    await onObjectPicked(2, MACHINE, deps);
    await handleCleanCallback(2, { kind: "sanitation" }, ME, deps);
    assert.equal(keys.length, 2);
    assert.match(keys[0], /^cl:.+:mixer$/);
    assert.match(keys[1], /^cl:.+:san$/);
    assert.notEqual(keys[0].split(":")[1], keys[1].split(":")[1], "runId у заходов разный");
  });

  it("заявка о поломке уходит с ключом pr:", async () => {
    const conversations = new Conversations();
    const keys: string[] = [];
    const { core } = stubCore({
      createTask: async (i: Record<string, unknown>) => {
        keys.push(String(i.clientKey ?? ""));
        return { id: "task-1" };
      },
    });
    const deps = { core, conversations };
    await startProblem(3, ME, deps);
    await onObjectPicked(3, MACHINE, deps);
    await handleProblemCallback(3, { kind: "symptom", symptom: "dead" }, ME, deps);
    await handleProblemCallback(3, { kind: "urgency", urgency: "1" }, ME, deps);
    assert.equal(keys.length, 1);
    assert.match(keys[0], /^pr:.+:1$/);
  });
});
