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
      calls.push(
        `task:${String(i.priority)}:${String(i.title)}:owner=${String(i.ownerRef ?? "-")}:domain=${String(i.domain ?? "-")}`,
      );
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
    machineParts: async () => [
      { id: "p-1", partKind: "hopper", slot: 3, serialNumber: "HOP-33", removedOn: null },
      { id: "p-0", partKind: "grinder", slot: null, serialNumber: null, removedOn: "2026-01-01" },
    ],
    storageParts: async () => [
      { id: "44444444-4444-4444-8444-444444444444", partKind: "grinder", serialNumber: "GR-9", location: "washing" },
    ],
    installPart: async (i: Record<string, unknown>) => {
      calls.push(`install:${String(i.partKind)}:${String(i.partId ?? "-")}:${String(i.serialNumber ?? "-")}:${String(i.slot ?? "-")}`);
      return { log: { id: "log-3" }, installed: { serialNumber: (i.serialNumber as string) ?? "GR-9" } };
    },
    removePart: async (i: Record<string, unknown>) => {
      calls.push(`remove:${String(i.partKind)}:${String(i.slot ?? "-")}:${String(i.toLocation)}`);
      return { log: { id: "log-4" }, removed: { serialNumber: "HOP-33" } };
    },
    // Карточек узлов на автомате нет (автомат до автозаведения) — замена идёт прежним путём.
    partsInstalled: async () => [],
    partsSpares: async () => [],
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
    assert.equal(conversations.get(1)?.step, "action", "после автомата — выбор действия");

    await handlePartReplaceCallback(1, { kind: "action", action: "swap" }, ME, deps);
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
    await onObjectPicked(1, MACHINE, deps);
    const picked = (await handlePartReplaceCallback(1, { kind: "action", action: "swap" }, ME, deps)).message!;
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

    assert.match(calls[0], /^task:urgent:Купюры не берёт/);
    assert.match(calls[0], /owner=-:/, "исполнителя быть не должно");
    assert.match(calls[0], /domain=vendhub$/, "поломка должна попасть в VendHub");
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

describe("Снятие и установка узла", () => {
  const SPARE = "44444444-4444-4444-8444-444444444444";

  it("парсер принимает новые кнопки и отвергает мусор", () => {
    assert.deepEqual(parsePartReplaceCallback("pt:a:rm"), { kind: "action", action: "remove" });
    assert.deepEqual(parsePartReplaceCallback("pt:rm:hopper:3"), { kind: "removePick", part: "hopper", slot: 3 });
    assert.deepEqual(parsePartReplaceCallback("pt:rm:grinder:0"), { kind: "removePick", part: "grinder", slot: null });
    assert.deepEqual(parsePartReplaceCallback("pt:to:washing"), { kind: "removeTo", to: "washing" });
    assert.equal(parsePartReplaceCallback("pt:to:machine"), null, "«на автомат» снять нельзя");
    assert.deepEqual(parsePartReplaceCallback(`pt:in:${SPARE}`), { kind: "installFrom", partId: SPARE });
    assert.deepEqual(parsePartReplaceCallback("pt:sl:0"), { kind: "slot", slot: null });
    assert.equal(parsePartReplaceCallback("pt:rm:выдумка:1"), null);
  });

  it("снятие: реальные узлы автомата → куда увёз → запись", async () => {
    const conversations = new Conversations();
    const { core, calls } = stubCore();
    const deps = { core, conversations };
    await startPartReplace(1, ME, deps);
    await onObjectPicked(1, MACHINE, deps);

    const list = await handlePartReplaceCallback(1, { kind: "action", action: "remove" }, ME, deps);
    const labels = list.message!.keyboard!.inline_keyboard.flat().map((b) => b.text);
    assert.ok(labels.some((l) => l.includes("Бункер №3")), "показывается стоящий узел со слотом");
    assert.ok(!labels.some((l) => l.includes("Кофемолка")), "снятый в историю узел не предлагается");

    await handlePartReplaceCallback(1, { kind: "removePick", part: "hopper", slot: 3 }, ME, deps);
    const done = await handlePartReplaceCallback(1, { kind: "removeTo", to: "washing" }, ME, deps);
    assert.equal(calls[0], "remove:hopper:3:washing");
    assert.match(done.message!.text, /Записал снятие/);
    assert.match(done.message!.text, /мойка/i, "техник видит, где узел теперь числится");
  });

  it("снимать нечего — честный ответ и подсказка про «Заменить»", async () => {
    const conversations = new Conversations();
    const { core } = stubCore({ machineParts: async () => [] });
    const deps = { core, conversations };
    await startPartReplace(1, ME, deps);
    await onObjectPicked(1, MACHINE, deps);
    const res = await handlePartReplaceCallback(1, { kind: "action", action: "remove" }, ME, deps);
    assert.match(res.message!.text, /не заведены/);
    assert.equal(conversations.get(1), null, "мастер завершён, а не завис");
  });

  it("установка со склада: инстанс наследуется по partId", async () => {
    const conversations = new Conversations();
    const { core, calls } = stubCore();
    const deps = { core, conversations };
    await startPartReplace(1, ME, deps);
    await onObjectPicked(1, MACHINE, deps);

    const src = await handlePartReplaceCallback(1, { kind: "action", action: "install" }, ME, deps);
    const labels = src.message!.keyboard!.inline_keyboard.flat().map((b) => b.text);
    assert.ok(labels.some((l) => l.includes("Кофемолка") && l.includes("GR-9")), "учтённый узел виден с серийником");

    await handlePartReplaceCallback(1, { kind: "installFrom", partId: SPARE }, ME, deps);
    const done = await handlePartReplaceCallback(1, { kind: "slot", slot: null }, ME, deps);
    assert.equal(calls[0], `install:grinder:${SPARE}:-:-`);
    assert.match(done.message!.text, /Записал установку/);
  });

  it("установка нового: узел → серийник → номер места → запись", async () => {
    const conversations = new Conversations();
    const { core, calls } = stubCore();
    const deps = { core, conversations };
    await startPartReplace(1, ME, deps);
    await onObjectPicked(1, MACHINE, deps);
    await handlePartReplaceCallback(1, { kind: "action", action: "install" }, ME, deps);
    await handlePartReplaceCallback(1, { kind: "installNew" }, ME, deps);
    await handlePartReplaceCallback(1, { kind: "part", part: "mixer" }, ME, deps);
    assert.equal(conversations.get(1)?.step, "inserial", "узел на установке спрашивает серийник, не причину");
    handlePartSerial(1, "MX-55", deps);
    assert.equal(conversations.get(1)?.step, "inslot");
    const done = await handlePartReplaceCallback(1, { kind: "slot", slot: 2 }, ME, deps);
    assert.equal(calls[0], "install:mixer:-:MX-55:2");
    assert.match(done.message!.text, /№2/);
  });

  it("занятое место — честная ошибка, мастер не зависает", async () => {
    const conversations = new Conversations();
    const { core } = stubCore({
      installPart: async () => {
        throw new Error("Место занято — снимите узел или оформите замену");
      },
    });
    const deps = { core, conversations };
    await startPartReplace(1, ME, deps);
    await onObjectPicked(1, MACHINE, deps);
    await handlePartReplaceCallback(1, { kind: "action", action: "install" }, ME, deps);
    await handlePartReplaceCallback(1, { kind: "installNew" }, ME, deps);
    await handlePartReplaceCallback(1, { kind: "part", part: "grinder" }, ME, deps);
    await handlePartReplaceCallback(1, { kind: "noSerial" }, ME, deps);
    const res = await handlePartReplaceCallback(1, { kind: "slot", slot: null }, ME, deps);
    assert.match(res.message!.text, /Место занято/);
    assert.equal(conversations.get(1), null);
  });
});

// ── Замена по узлам (У3): узлы автомата заведены карточками ────────────────

const U_OLD = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const U_OLD2 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
const U_SPARE = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";

function unitRow(id: string, no: string, slot: number | null, location = "machine") {
  return {
    id,
    partKind: "mixer",
    inventoryNo: no,
    labelPending: false,
    serialNumber: null,
    setNumber: null,
    hopperPosition: null,
    tareWeight: null,
    retiredAt: null,
    where: { location, machineId: location === "machine" ? MACHINE : null, machineName: null, slot, since: "2026-09-01" },
    attention: [],
    label: `Миксер ${no}`,
    photoCount: 0,
  };
}

function stubUnits(over: Record<string, unknown> = {}) {
  const swaps: Record<string, unknown>[] = [];
  const base = stubCore({
    partsInstalled: async () => [unitRow(U_OLD, "M-017", 1), unitRow(U_OLD2, "M-018", 2)],
    partsSpares: async () => [unitRow(U_SPARE, "M-031", null, "warehouse")],
    swapPart: async (i: Record<string, unknown>) => {
      swaps.push(i);
      return { log: { id: "log-1" }, removed: { serialNumber: null, partUnitId: U_OLD }, installed: { partUnitId: U_SPARE, serialNumber: null } };
    },
    ...over,
  });
  return { ...base, swaps };
}

describe("Замена по узлам (У3): снятый по номеру, запасной со склада", () => {
  it("парсер узнаёт pt:old / pt:sp и «нет в списке»", () => {
    assert.deepEqual(parsePartReplaceCallback(`pt:old:${U_OLD}`), { kind: "swapOld", unitId: U_OLD });
    assert.deepEqual(parsePartReplaceCallback("pt:old:0"), { kind: "swapOld", unitId: null });
    assert.deepEqual(parsePartReplaceCallback(`pt:sp:${U_SPARE}`), { kind: "swapSpare", unitId: U_SPARE });
    assert.equal(parsePartReplaceCallback("pt:old:xyz"), null);
  });

  it("узел → какой снял (по номеру) → куда увёз (мойка первой) → запасной → причина → запись с partUnitId/slot/removedTo", async () => {
    const conversations = new Conversations();
    const { core, swaps } = stubUnits();
    const deps = { core, conversations };
    await startPartReplace(1, ME, deps);
    await onObjectPicked(1, MACHINE, deps);
    await handlePartReplaceCallback(1, { kind: "action", action: "swap" }, ME, deps);

    const pick = await handlePartReplaceCallback(1, { kind: "part", part: "mixer" }, ME, deps);
    assert.equal(conversations.get(1)?.step, "swapold", "карточки есть — серийник старого не нужен");
    const oldLabels = pick.message!.keyboard!.inline_keyboard.flat().map((b) => b.text);
    assert.deepEqual(oldLabels.slice(0, 2), ["M-017 · №1", "M-018 · №2"]);
    assert.ok(oldLabels.includes("Нет в списке"));

    const to = await handlePartReplaceCallback(1, { kind: "swapOld", unitId: U_OLD }, ME, deps);
    assert.match(to.message!.text, /Снят Миксер M-017. Куда увёз\?/);
    const toLabels = to.message!.keyboard!.inline_keyboard.flat().map((b) => b.text);
    assert.equal(toLabels[0], "Мойка", "миксер моют — мойка первой");
    assert.equal(conversations.get(1)?.step, "swapto");

    const spare = await handlePartReplaceCallback(1, { kind: "removeTo", to: "washing" }, ME, deps);
    assert.equal(conversations.get(1)?.step, "swapnew");
    const spareLabels = spare.message!.keyboard!.inline_keyboard.flat().map((b) => b.text);
    assert.equal(spareLabels[0], "M-031 · склад");
    assert.ok(spareLabels.some((l) => l.includes("Новый узел")));

    const reason = await handlePartReplaceCallback(1, { kind: "swapSpare", unitId: U_SPARE }, ME, deps);
    assert.equal(conversations.get(1)?.step, "reason", "запасной выбран — серийник не спрашиваем");
    assert.match(reason.message!.text, /Поставлен Миксер M-031/);

    const done = await handlePartReplaceCallback(1, { kind: "reason", reason: "preventive" }, ME, deps);
    assert.equal(swaps.length, 1);
    assert.equal(swaps[0].slot, 1);
    assert.equal(swaps[0].partUnitId, U_SPARE);
    assert.equal(swaps[0].removedTo, "washing");
    assert.equal(swaps[0].newSerial, undefined);
    assert.match(done.message!.text, /Миксер №1/);
    assert.match(done.message!.text, /Снят: Миксер M-017 → мойка/);
    assert.match(done.message!.text, /Поставлен: Миксер M-031 \(со склада\)/);
  });

  it("«Новый узел» при замене по узлам: серийник → причина; Core заведёт карточку", async () => {
    const conversations = new Conversations();
    const { core, swaps } = stubUnits({ partsSpares: async () => [] });
    const deps = { core, conversations };
    await startPartReplace(1, ME, deps);
    await onObjectPicked(1, MACHINE, deps);
    await handlePartReplaceCallback(1, { kind: "part", part: "mixer" }, ME, deps);
    await handlePartReplaceCallback(1, { kind: "swapOld", unitId: U_OLD2 }, ME, deps);
    const spare = await handlePartReplaceCallback(1, { kind: "removeTo", to: "repair" }, ME, deps);
    assert.match(spare.message!.text, /Запасных миксер.* на складе не числится/);
    await handlePartReplaceCallback(1, { kind: "installNew" }, ME, deps);
    assert.equal(conversations.get(1)?.step, "serial");
    handlePartSerial(1, "MX-NEW", deps);
    const done = await handlePartReplaceCallback(1, { kind: "reason", reason: "failure" }, ME, deps);
    assert.equal(swaps[0].slot, 2);
    assert.equal(swaps[0].removedTo, "repair");
    assert.equal(swaps[0].newSerial, "MX-NEW");
    assert.equal(swaps[0].partUnitId, undefined);
    assert.match(done.message!.text, /Снят: Миксер M-018 → ремонт/);
    assert.match(done.message!.text, /Новый: MX-NEW/);
  });

  it("«Нет в списке» — прежний путь без узла: серийник → причина, без slot и removedTo", async () => {
    const conversations = new Conversations();
    const { core, swaps } = stubUnits();
    const deps = { core, conversations };
    await startPartReplace(1, ME, deps);
    await onObjectPicked(1, MACHINE, deps);
    await handlePartReplaceCallback(1, { kind: "part", part: "mixer" }, ME, deps);
    await handlePartReplaceCallback(1, { kind: "swapOld", unitId: null }, ME, deps);
    assert.equal(conversations.get(1)?.step, "serial");
    await handlePartReplaceCallback(1, { kind: "noSerial" }, ME, deps);
    await handlePartReplaceCallback(1, { kind: "reason", reason: "upgrade" }, ME, deps);
    assert.equal(swaps[0].slot, undefined);
    assert.equal(swaps[0].removedTo, undefined);
  });

  it("кнопка узла с устаревшего экрана не действует и не пишет", async () => {
    const conversations = new Conversations();
    const { core, swaps } = stubUnits();
    const deps = { core, conversations };
    await startPartReplace(1, ME, deps);
    await onObjectPicked(1, MACHINE, deps);
    const res = await handlePartReplaceCallback(1, { kind: "swapOld", unitId: U_OLD }, ME, deps);
    assert.equal(res.answer, "Кнопка устарела");
    assert.equal(conversations.get(1)?.step, "action", "мастер остался на своём шаге");
    assert.deepEqual(swaps, []);
  });
});
