import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  afterItemKeyboard,
  cancelText,
  isRefillTrigger,
  newRunId,
  parseCount,
  parseRefillCallback,
  plural,
  productKeyboard,
  readState,
  recordItem,
  refillClientKey,
  refillStepHint,
  summaryText,
  handleRefillCallback,
  handleRefillCount,
  handleRefillProductText,
  onMachinePicked,
  startMachineRefill,
  type RefillDeps,
  type RefillState,
} from "./staff-refill";
import { CoreError, NotAMachineError, type CoreClient, type PersonRow, type VendingPlan } from "./core-client";
import { Conversations } from "./conversation";
import { handleStaffCallback, handleStaffMessage } from "./staff";
import { matchTrigger } from "./menu";

const PERSON = { id: "11111111-1111-4111-8111-111111111111", name: "Володя" } as PersonRow;

/** Половина суррогатной пары в тексте — Telegram отвергает такое сообщение. */
const одинокийСуррогат = (s: string): boolean =>
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s);

const state = (over: Partial<RefillState> = {}): RefillState => ({
  runId: "run1",
  machineId: "22222222-2222-4222-8222-222222222222",
  machineSerial: "MU-7",
  machineName: "Parus F4",
  index: 0,
  items: [],
  choices: ["Coca-Cola 0.5", "Snickers"],
  pending: "Coca-Cola 0.5",
  ...over,
});

function deps(createRefill: CoreClient["createRefill"]) {
  return { core: { createRefill } as unknown as CoreClient, conversations: {} as Conversations };
}

describe("Заливка автомата: разбор ввода", () => {
  it("ловит формулировки техника", () => {
    for (const t of ["заполнил автомат", "заправил", "пополнил Parus", "загрузил автомат"]) {
      assert.ok(isRefillTrigger(t), t);
    }
    assert.ok(!isRefillTrigger("залил кофе"), "кофейная заливка — другой мастер");
  });

  it("триггер якорится: победитель не зависит от порядка пунктов меню", () => {
    // Пункт стал живым, и подстрока без якоря делала бы его претендентом на
    // любую фразу, где слово встретилось в середине, — включая отчёт о мойке.
    assert.ok(!isRefillTrigger("помыл бункер, потом заполнил автомат"));
    assert.ok(!isRefillTrigger("сегодня заправил"));
    assert.equal(matchTrigger("помыл бункер, потом заполнил автомат", ["operator"])?.id, "wash");
  });

  it("количество — целые штуки", () => {
    assert.equal(parseCount("12"), 12);
    assert.equal(parseCount(" 7 "), 7);
    assert.equal(parseCount("0"), null, "ноль штук — не заливка");
    assert.equal(parseCount("12.5"), null, "половины батончика не бывает");
    assert.equal(parseCount("-3"), null);
    assert.equal(parseCount("много"), null);
    assert.equal(parseCount("99999"), null, "пятизначное — почти наверняка промах");
  });

  it("кнопки разбираются строго, мусор отклоняется", () => {
    assert.deepEqual(parseRefillCallback("rf:cancel"), { kind: "cancel" });
    assert.deepEqual(parseRefillCallback("rf:more"), { kind: "more" });
    assert.deepEqual(parseRefillCallback("rf:done"), { kind: "done" });
    assert.deepEqual(parseRefillCallback("rf:p:3"), { kind: "product", name: "", index: 3 });
    assert.equal(parseRefillCallback("rf:p:abc"), null);
    assert.equal(parseRefillCallback("rf:p:"), null);
    assert.equal(parseRefillCallback("i:cancel"), null, "чужое пространство кнопок");
    assert.equal(parseRefillCallback(""), null);
  });

  it("подсказка зависит от шага", () => {
    assert.match(refillStepHint("count"), /числом/);
    assert.match(refillStepHint("product"), /товар/);
  });
});

describe("Заливка автомата: ключ идемпотентности", () => {
  it("одна позиция — один ключ, разные позиции — разные", () => {
    assert.equal(refillClientKey("run1", "2508160376", 0), "rf:run1:2508160376:0");
    assert.notEqual(
      refillClientKey("run1", "2508160376", 0),
      refillClientKey("run1", "2508160376", 1),
    );
  });

  it("два обхода одного автомата не пересекаются", () => {
    // Иначе второй техник, зашедший следом, «повторил» бы чужую позицию,
    // и его заливка не записалась бы вовсе.
    const a = newRunId(1_700_000_000_000, () => 0.1);
    const b = newRunId(1_700_000_000_000, () => 0.9);
    assert.notEqual(a, b);
    assert.notEqual(refillClientKey(a, "2508160376", 0), refillClientKey(b, "2508160376", 0));
  });

  it("серийник в ключе: та же позиция на другом автомате — другой ключ (S2)", () => {
    // Без серийника заливка на второй автомат ловилась бы Core как повтор
    // первой: записи нет, склад не списан, а бот говорил бы «Загрузил».
    assert.notEqual(refillClientKey("run1", "2508160376", 0), refillClientKey("run1", "c99", 0));
  });

  it("обе формы серийника дают один ключ", () => {
    // «c2508160376» из реестра и «2508160376» из Ourvend — один автомат.
    assert.equal(
      refillClientKey("run1", "c2508160376", 0),
      refillClientKey("run1", "2508160376", 0),
    );
  });
});

describe("Заливка автомата: запись позиции", () => {
  it("пишет позицию, двигает индекс и показывает остаток", async () => {
    const calls: unknown[] = [];
    const d = deps((async (input) => {
      calls.push(input);
      return { refill: { id: "r1" }, stockLeft: 14, duplicate: false };
    }) as CoreClient["createRefill"]);

    const res = await recordItem(state(), 6, PERSON, d);
    assert.equal(res.state.index, 1);
    assert.equal(res.state.pending, undefined);
    assert.deepEqual(res.state.items, [{ product: "Coca-Cola 0.5", qty: 6, left: 14 }]);
    assert.match(res.reply.text, /Coca-Cola 0\.5 — 6 шт/);
    assert.match(res.reply.text, /осталось 14/);
    assert.deepEqual(calls, [
      {
        machineSerial: "MU-7",
        machineId: "22222222-2222-4222-8222-222222222222",
        productName: "Coca-Cola 0.5",
        qty: 6,
        personId: PERSON.id,
        clientKey: "rf:run1:mu-7:0",
        createdBy: `person:${PERSON.id}`,
      },
    ]);
  });

  it("минусовой остаток объясняется словами, а не просто числом", async () => {
    const d = deps((async () => ({
      refill: { id: "r1" },
      stockLeft: -4,
      duplicate: false,
    })) as CoreClient["createRefill"]);
    const res = await recordItem(state(), 6, PERSON, d);
    assert.match(res.reply.text, /склад давно не пересчитывали/i);
  });

  it("повтор Core («уже записано») не выдаётся за новую запись (S2)", async () => {
    // duplicate: true означает, что склад НЕ списан — позиция была записана
    // раньше. Сказать «Записал» значит подтвердить списание, которого не было:
    // ровно так пропадала заливка на второй автомат по старой кнопке пикера.
    const d = deps((async () => ({
      refill: { id: "r1" },
      stockLeft: 14,
      duplicate: true,
    })) as CoreClient["createRefill"]);
    const res = await recordItem(state(), 6, PERSON, d);
    assert.match(res.reply.text, /уже записано/i);
    assert.match(res.reply.text, /повторно не списываю/i);
    assert.doesNotMatch(res.reply.text, /^Записал:/);
    assert.equal(res.state.index, 1, "позиция в Core есть — обход идёт дальше");
    assert.deepEqual(res.state.items, [{ product: "Coca-Cola 0.5", qty: 6, left: 14 }]);
  });

  it("сбой сети не двигает индекс — повтор пойдёт тем же ключом", async () => {
    // Если запись всё-таки прошла на сервере, повтор тем же ключом вернёт её
    // же и не спишет склад второй раз. Сдвинь мы индекс — получили бы дубль.
    const d = deps((async () => {
      throw new Error("ECONNRESET");
    }) as CoreClient["createRefill"]);
    const res = await recordItem(state(), 6, PERSON, d);
    assert.equal(res.state.index, 0);
    assert.deepEqual(res.state.items, []);
    assert.match(res.reply.text, /записанное сохранено/i);
  });

  it("сбой видно с первого взгляда, а не по тексту (UX#6)", async () => {
    // Кнопки под сбоем и под успехом одинаковые: без знака в начале техник,
    // листающий чат бегло, принимает неудачу за записанную позицию.
    const d = deps((async () => {
      throw new Error("ECONNRESET");
    }) as CoreClient["createRefill"]);
    const res = await recordItem(state(), 6, PERSON, d);
    assert.match(res.reply.text, /^⚠️ Не смог записать «Coca-Cola 0\.5»/);
  });

  it("спор каталога (400) печатает текст Core и не советует повтор (гигиена, UX-major)", async () => {
    // Раньше любая ошибка Core тонула в одном общем «попробуй ещё раз» — для
    // детерминированного отказа (R-G-1) это неверный совет: повтор того же
    // запроса даст тот же 400, и техник застрянет у автомата.
    const d = deps((async () => {
      throw new CoreError(
        400,
        "/vending/refills",
        JSON.stringify({ statusCode: 400, message: "Уберите лишний алиас.", error: "Bad Request" }),
      );
    }) as CoreClient["createRefill"]);
    const res = await recordItem(state(), 6, PERSON, d);
    assert.match(res.reply.text, /Уберите лишний алиас\./);
    assert.doesNotMatch(res.reply.text, /Попробуй ещё раз/);
    assert.match(res.reply.text, /Повтор не поможет/i);
    const buttons = res.reply.keyboard?.inline_keyboard.flat().map((b) => b.callback_data);
    assert.deepEqual(buttons, ["rf:more", "rf:done"], "escape-путь остаётся — пропустить и продолжить");
  });

  it("после позиции предлагает продолжить обход или закончить", async () => {
    const d = deps((async () => ({
      refill: { id: "r1" },
      stockLeft: 1,
      duplicate: false,
    })) as CoreClient["createRefill"]);
    const res = await recordItem(state(), 1, PERSON, d);
    const buttons = res.reply.keyboard?.inline_keyboard.flat().map((b) => b.callback_data);
    assert.deepEqual(buttons, ["rf:more", "rf:done"]);
  });
});

describe("Заливка автомата: тексты", () => {
  it("отмена после записанных позиций не пугает техника", () => {
    // Он должен понять, что записанное на месте, а не искать его в панели.
    assert.match(cancelText(3), /записано 3 позиции — они сохранены/i);
    assert.match(cancelText(0), /ничего не записано/i);
  });

  it("склонения не ломаются на 1, 2 и 11", () => {
    assert.equal(plural(1), "позицию");
    assert.equal(plural(3), "позиции");
    assert.equal(plural(5), "позиций");
    assert.equal(plural(11), "позиций");
    assert.equal(plural(21), "позицию");
  });

  it("итог перечисляет записанное с остатком", () => {
    const t = summaryText([
      { product: "Coca-Cola 0.5", qty: 6, left: 14 },
      { product: "Snickers", qty: 4, left: null },
    ]);
    assert.match(t, /Записал 2 позиции/);
    assert.match(t, /Coca-Cola 0\.5 — 6 шт\. \(на складе 14\)/);
    assert.match(t, /Snickers — 4 шт\.$/m, "без остатка — без скобок");
  });

  it("минус в итоге объяснён так же, как в живом сообщении (UX#7)", () => {
    // Итог перечитывают позже и вне контекста: голое «(на складе −3)» там
    // читается как ошибка данных, а не как известный факт про пересчёт.
    const t = summaryText([{ product: "Qurt", qty: 5, left: -3 }]);
    assert.match(t, /Qurt — 5 шт\. \(на складе -3 — склад давно не пересчитывали\)/);
  });

  it("клавиатура товаров ограничена и всегда даёт выход", () => {
    const many = Array.from({ length: 40 }, (_, i) => `Товар ${i}`);
    const kb = productKeyboard(many);
    const last = kb.inline_keyboard.slice(-2).flat().map((b) => b.callback_data);
    assert.deepEqual(last, ["rf:other", "rf:cancel"]);
    assert.equal(kb.inline_keyboard.length, 22, "20 товаров + «другой» + «отмена»");
  });

  it("эмодзи в имени товара не разрывается пополам (S6)", () => {
    // Имена приходят из Ourvend, и эмодзи там — суррогатная ПАРА: обрезка по
    // единицам UTF-16 оставляет от неё половину, а Telegram отвечает 400 на
    // всё сообщение целиком, не на одну кнопку.
    const имя = `${"я".repeat(39)}🍫хвост`;
    const [кнопка] = productKeyboard([имя]).inline_keyboard[0];
    assert.ok(!одинокийСуррогат(кнопка.text), кнопка.text);
    assert.ok(кнопка.text.length <= 40, `длина ${кнопка.text.length}`);
  });

  it("пустое зеркало не ломает клавиатуру", () => {
    // Сбор Ourvend может быть выключен — тогда предлагаем ввести имя руками.
    const kb = productKeyboard([]);
    assert.deepEqual(
      kb.inline_keyboard.flat().map((b) => b.callback_data),
      ["rf:other", "rf:cancel"],
    );
  });
});

describe("Заливка автомата: состояние визарда", () => {
  it("читается из памяти и проверяется по форме", () => {
    assert.ok(readState(state() as unknown as Record<string, unknown>));
    assert.equal(readState({}), null);
    assert.equal(readState({ runId: "r", machineSerial: "MU-7" }), null, "без индекса и списков");
  });

  it("клавиатура «ещё/готово» не содержит отмены", () => {
    // На этом шаге отменять уже нечего: позиция записана. Кнопка «Отмена»
    // здесь читалась бы как «удалить записанное».
    const b = afterItemKeyboard().inline_keyboard.flat().map((x) => x.callback_data);
    assert.ok(!b.includes("rf:cancel"));
  });
});

// ── Мастер целиком (П4): план закупа → чек-лист → запись ────────────────────

const MACHINE_ID = "33333333-3333-4333-8333-333333333333";
const CHAT = 7;

const PLAN = {
  generatedAt: "2026-08-25T04:00:00.000Z",
  stock: { asOf: null, totalBefore: 0, use: 0, back: 0, totalAfter: 0, stale: false, unmatched: 0 },
  summary: {},
  routeConfigured: true,
  warnings: [],
  machines: [
    {
      serial: "2508160376",
      name: "Olma",
      routeIndex: 1,
      need: 11,
      fromPurchase: 6,
      fromStock: 5,
      unfilled: 0,
      slots: [
        { coilId: "11", product: "Montella", quantity: 0, capacity: 6, need: 6, fromPurchase: 4, fromStock: 2, unfilled: 0 },
        { coilId: "12", product: "Fanta", quantity: 1, capacity: 6, need: 5, fromPurchase: 0, fromStock: 5, unfilled: 0 },
        { coilId: "13", product: "Qurt", quantity: 6, capacity: 6, need: 0, fromPurchase: 0, fromStock: 0, unfilled: 0 },
        { coilId: "14", product: "Montella", quantity: 4, capacity: 6, need: 2, fromPurchase: 2, fromStock: 0, unfilled: 0 },
      ],
    },
  ],
} as unknown as VendingPlan;

interface WizardOpts {
  /** Номер вызова createRefill, который упадёт (1 — первый). */
  failCall?: number;
  plan?: VendingPlan | null;
  products?: string[];
  serial?: string;
  /** Серийник по карточке — когда в тесте больше одного автомата. */
  serials?: Record<string, string>;
  priced?: { id: string; name: string; isActive: boolean }[];
  /** Справочники (зеркало и прайс) недоступны — как при лежащем Core. */
  failLookups?: boolean;
  /** Выбранная карточка — не автомат (склад, помещение, машина сотрудника). */
  notAMachine?: boolean;
}

function wizard(opts: WizardOpts = {}) {
  const calls: { productName: string; qty: number; clientKey: string }[] = [];
  let n = 0;
  const core = {
    machineSerial: async (id: string) => {
      if (opts.notAMachine === true) throw new NotAMachineError(id, "warehouse");
      return opts.serials?.[id] ?? opts.serial ?? "2508160376";
    },
    vendingPlan: async () => {
      if (opts.plan === null) throw new Error("Core недоступен");
      return opts.plan ?? PLAN;
    },
    machineProducts: async () => {
      if (opts.failLookups === true) throw new Error("Core недоступен");
      return opts.products ?? ["Montella", "Fanta", "Snickers"];
    },
    vendingProducts: async () => {
      if (opts.failLookups === true) throw new Error("Core недоступен");
      return (
        opts.priced ?? [
          { id: "p1", name: "Kinder Bueno", isActive: true },
          { id: "p2", name: "Kinder Delice", isActive: true },
        ]
      );
    },
    machines: async () => [{ id: MACHINE_ID, name: "Olma" }],
    recentObjects: async () => [{ id: MACHINE_ID, name: "Olma" }],
    createRefill: async (input: { productName: string; qty: number; clientKey: string }) => {
      n += 1;
      if (opts.failCall === n) throw new Error("ECONNRESET");
      calls.push({ productName: input.productName, qty: input.qty, clientKey: input.clientKey });
      return { refill: { id: `r${n}` }, stockLeft: 10, duplicate: false };
    },
  } as unknown as CoreClient;
  const conversations = new Conversations();
  return { deps: { core, conversations }, calls };
}

/** Кнопка → обработчик: разбор проверяется тем же путём, что в бою. */
async function press(data: string, deps: RefillDeps) {
  const cb = parseRefillCallback(data);
  assert.ok(cb, `не разобрал ${data}`);
  return handleRefillCallback(CHAT, cb, PERSON, deps);
}

describe("Заливка автомата: чек-лист по плану закупа", () => {
  it("складывает слоты одного товара и прячет то, что грузить не надо", async () => {
    const { deps } = wizard();
    await startMachineRefill(CHAT, PERSON, deps);
    const r = await onMachinePicked(CHAT, MACHINE_ID, "Olma", deps);
    // Montella стоит в двух слотах: 4+2 закупа и 2 склада = 8.
    assert.match(r.text, /Montella — 8/);
    assert.match(r.text, /Fanta — 5/);
    assert.ok(!r.text.includes("Qurt"), "полный слот в чек-лист не идёт");
    const кнопки = r.keyboard?.inline_keyboard.flat().map((b) => b.callback_data);
    assert.deepEqual(кнопки, ["rf:plan", "rf:else", "rf:cancel"]);
  });

  it("«Загрузил по плану» пишет позиции подряд ключами rf:<обход>:<серийник>:0/1", async () => {
    const { deps, calls } = wizard();
    await startMachineRefill(CHAT, PERSON, deps);
    await onMachinePicked(CHAT, MACHINE_ID, "Olma", deps);
    const res = await press("rf:plan", deps);
    assert.deepEqual(
      calls.map((c) => [c.productName, c.qty]),
      [["Montella", 8], ["Fanta", 5]],
    );
    const хвосты = calls.map((c) => c.clientKey.split(":")[3]);
    assert.deepEqual(хвосты, ["0", "1"], "порядковый номер позиции — часть ключа");
    const обходы = new Set(calls.map((c) => c.clientKey.split(":")[1]));
    assert.equal(обходы.size, 1, "один обход — один runId");
    assert.match(res.message?.text ?? "", /Записал 2 позиции/);
  });

  it("сбой Core на второй позиции не двигает индекс — повтор дописывает остаток", async () => {
    const { deps, calls } = wizard({ failCall: 2 });
    await startMachineRefill(CHAT, PERSON, deps);
    await onMachinePicked(CHAT, MACHINE_ID, "Olma", deps);
    const res = await press("rf:plan", deps);
    assert.equal(calls.length, 1, "вторая позиция не записана");
    assert.match(res.message?.text ?? "", /Записано 1 из 2/);
    assert.match(res.message?.text ?? "", /«Fanta»: не записано/, "род названия не угадываем");
    const повтор = res.message?.keyboard?.inline_keyboard.flat().map((b) => b.callback_data);
    assert.ok(повтор?.includes("rf:plan"), "кнопка повтора на месте");

    const второй = await press("rf:plan", deps);
    assert.deepEqual(calls.map((c) => c.productName), ["Montella", "Fanta"]);
    assert.equal(calls[1].clientKey.split(":")[3], "1", "повтор идёт тем же номером — дубля не будет");
    assert.match(второй.message?.text ?? "", /Записал 2 позиции/);
  });

  it("старая кнопка пикера посреди обхода: новый обход, а не повтор чужих ключей (S2)", async () => {
    // Эксплойт из ревью: техник заливает автомат A, прокручивает чат вверх и
    // жмёт кнопку автомата B. Раньше беседа отдавала ТОТ ЖЕ runId и индекс 0 —
    // Core ловил ключи как повтор, заливка на B не записывалась, склад не
    // списывался, а бот отвечал «Загрузил по плану».
    const B = "44444444-4444-4444-8444-444444444444";
    const { deps, calls } = wizard({
      serials: { [MACHINE_ID]: "2508160376", [B]: "2508160377" },
    });
    await startMachineRefill(CHAT, PERSON, deps);
    await onMachinePicked(CHAT, MACHINE_ID, "Olma", deps);
    await press("rf:plan", deps);
    assert.equal(calls.length, 2, "две позиции на первом автомате");

    await onMachinePicked(CHAT, B, "Compass", deps);
    await press("rf:p:0", deps);
    await handleRefillCount(CHAT, "3", PERSON, deps);
    assert.equal(calls.length, 3, "позиция второго автомата записана");

    const [обходA] = calls.map((c) => c.clientKey.split(":")[1]);
    const обходB = calls[2].clientKey.split(":")[1];
    assert.notEqual(обходB, обходA, "новый автомат — новый обход");
    assert.equal(calls[2].clientKey.split(":")[2], "2508160377", "серийник в ключе");
    assert.equal(calls[0].clientKey.split(":")[2], "2508160376");
  });

  it("плана по автомату нет — сразу товары автомата и слова об этом", async () => {
    const { deps } = wizard({ serial: "9999999999" });
    await startMachineRefill(CHAT, PERSON, deps);
    const r = await onMachinePicked(CHAT, MACHINE_ID, "Olma", deps);
    assert.match(r.text, /Плана по этому автомату нет\. Выбери товар/);
    const кнопки = r.keyboard?.inline_keyboard.flat().map((b) => b.callback_data);
    assert.deepEqual(кнопки, ["rf:p:0", "rf:p:1", "rf:p:2", "rf:other", "rf:cancel"]);
  });

  it("карточка не автомата — заливку не открываем и говорим почему (S7)", async () => {
    // Пикер пропускает только id-подобное, но ТИП карточки не проверял:
    // по старой кнопке из другого мастера в заливку уезжал бы externalRef
    // склада или помещения — и заливка легла бы на чужой серийник.
    const { deps, calls } = wizard({ notAMachine: true });
    await startMachineRefill(CHAT, PERSON, deps);
    const r = await onMachinePicked(CHAT, MACHINE_ID, "Склад Ц-1", deps);
    assert.match(r.text, /не автомат/i);
    assert.equal(calls.length, 0, "ничего не записано");
    assert.equal(deps.conversations.get(CHAT), null, "мастер закрыт");
  });

  it("план не отдался — так и сказано, а мастер работает по зеркалу", async () => {
    // «Плана по этому автомату нет» — утверждение о ДАННЫХ. Сказать его, когда
    // Core просто не ответил, значит соврать: оператор решит, что грузить
    // нечего, и уедет.
    const { deps } = wizard({ plan: null });
    await startMachineRefill(CHAT, PERSON, deps);
    const r = await onMachinePicked(CHAT, MACHINE_ID, "Olma", deps);
    assert.match(r.text, /план сейчас не отдался/i);
    assert.doesNotMatch(r.text, /плана по этому автомату нет/i);
    assert.match(r.text, /выбери товар/i, "записать заливку всё равно можно");
  });
});

describe("Заливка автомата: правка количества и другой товар", () => {
  it("«Иначе» → товар → нумпад с подсказкой плана → запись", async () => {
    const { deps, calls } = wizard();
    await startMachineRefill(CHAT, PERSON, deps);
    await onMachinePicked(CHAT, MACHINE_ID, "Olma", deps);
    const список = await press("rf:else", deps);
    assert.match(список.message?.text ?? "", /товар/i);

    const выбран = await press("rf:p:0", deps);
    assert.match(выбран.message?.text ?? "", /Montella/);
    assert.match(выбран.message?.text ?? "", /по плану 8/, "план виден рядом с набором");

    await press("rf:n:1", deps);
    const два = await press("rf:n:2", deps);
    assert.match(два.edit?.text ?? "", /Набрано: 12/, "нумпад перерисовывает то же сообщение");

    const записал = await press("rf:n:ok", deps);
    assert.deepEqual(calls.map((c) => [c.productName, c.qty]), [["Montella", 12]]);
    assert.match(записал.message?.text ?? "", /Montella — 12 шт/);
  });

  it("«Другой товар» открывает зеркало, а текст ищет по прайсу", async () => {
    const { deps } = wizard();
    await startMachineRefill(CHAT, PERSON, deps);
    await onMachinePicked(CHAT, MACHINE_ID, "Olma", deps);
    await press("rf:else", deps);
    const все = await press("rf:other", deps);
    assert.match(все.message?.text ?? "", /напиши часть названия/i);

    const найдено = await handleRefillProductText(CHAT, "kinder", deps);
    assert.match(найдено.text, /Нашёл 2/);
    const подписи = найдено.keyboard?.inline_keyboard.flat().map((b) => b.text);
    assert.ok(подписи?.includes("Kinder Bueno"), "товар прайса доступен, хоть его и нет в зеркале");
  });

  it("снятый с прайса товар в поиск не попадает", async () => {
    const { deps } = wizard({
      priced: [
        { id: "p1", name: "Kinder Bueno", isActive: true },
        { id: "p2", name: "Kinder Delice", isActive: false },
      ],
    });
    await startMachineRefill(CHAT, PERSON, deps);
    await onMachinePicked(CHAT, MACHINE_ID, "Olma", deps);
    await press("rf:else", deps);
    const найдено = await handleRefillProductText(CHAT, "kinder", deps);
    assert.match(найдено.text, /Нашёл 1/);
    const подписи = найдено.keyboard?.inline_keyboard.flat().map((b) => b.text) ?? [];
    assert.ok(!подписи.includes("Kinder Delice"), "неактивная позиция скрыта");
  });

  it("справочники не отдались — «не дозвонился», а не «ничего не нашёл»", async () => {
    const { deps } = wizard({ failLookups: true });
    await startMachineRefill(CHAT, PERSON, deps);
    await onMachinePicked(CHAT, MACHINE_ID, "Olma", deps);
    const найдено = await handleRefillProductText(CHAT, "kinder", deps);
    assert.match(найдено.text, /не отдался|не дозвонился/i);
    assert.doesNotMatch(найдено.text, /ничего не нашёл/i);
  });

  it("ничего не нашлось — говорим об этом и оставляем прежние кнопки", async () => {
    const { deps } = wizard();
    await startMachineRefill(CHAT, PERSON, deps);
    await onMachinePicked(CHAT, MACHINE_ID, "Olma", deps);
    await press("rf:else", deps);
    const пусто = await handleRefillProductText(CHAT, "щщщ", deps);
    assert.match(пусто.text, /ничего не нашёл/i);
    assert.ok(пусто.keyboard, "выход из шага остаётся");
  });

  it("количество текстом идёт тем же путём, что и нумпад", async () => {
    const { deps, calls } = wizard();
    await startMachineRefill(CHAT, PERSON, deps);
    await onMachinePicked(CHAT, MACHINE_ID, "Olma", deps);
    await press("rf:else", deps);
    await press("rf:p:1", deps);
    const r = await handleRefillCount(CHAT, "4", PERSON, deps);
    assert.deepEqual(calls.map((c) => [c.productName, c.qty]), [["Fanta", 4]]);
    assert.match(r.text, /Fanta — 4 шт/);
  });
});

describe("Заливка автомата: выход и барьеры", () => {
  it("«Отмена» заканчивает обход, но не стирает записанное", async () => {
    const { deps, calls } = wizard();
    await startMachineRefill(CHAT, PERSON, deps);
    await onMachinePicked(CHAT, MACHINE_ID, "Olma", deps);
    await press("rf:plan", deps);
    assert.equal(calls.length, 2);
    const r = await press("rf:cancel", deps);
    assert.match(r.message?.text ?? "", /записано 2 позиции — они сохранены/i);
    assert.equal(deps.conversations.get(CHAT), null, "беседа закрыта");
  });

  it("«Готово» подводит итог и закрывает обход", async () => {
    const { deps } = wizard();
    await startMachineRefill(CHAT, PERSON, deps);
    await onMachinePicked(CHAT, MACHINE_ID, "Olma", deps);
    await press("rf:plan", deps);
    const r = await press("rf:done", deps);
    assert.match(r.message?.text ?? "", /Записал 2 позиции/);
    assert.equal(deps.conversations.get(CHAT), null);
  });

  it("кнопка от прошлого шага не трогает чужой мастер", async () => {
    const { deps, calls } = wizard();
    deps.conversations.start(CHAT, "clean", "target", {});
    const r = await press("rf:cancel", deps);
    assert.match(r.answer, /устарел/i);
    assert.equal(deps.conversations.get(CHAT)?.flow, "clean", "чистку не гасим");
    assert.equal(calls.length, 0);
  });

  it("нумпад с устаревшего экрана не пугает «начни заново» без нужды", async () => {
    const { deps } = wizard();
    const r = await press("rf:n:5", deps);
    assert.match(r.answer, /устарел/i);
    assert.match(r.message?.text ?? "", /заполнил автомат/i);
  });
});

// ── Через диспетчер: кнопка меню → пикер → чек-лист → запись ────────────────
//
// Прошлая регрессия (мёртвый текстовый ввод расходников) пережила полторы
// тысячи зелёных тестов ровно потому, что все они звали обработчики напрямую,
// мимо маршрутизации. Этот блок идёт через handleStaffMessage/Callback.

const OPERATOR = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Володя",
  roles: ["operator"],
  tgChatId: "7",
  active: "yes",
} as PersonRow;

describe("Заливка автомата: путь через диспетчер", () => {
  it("кнопка меню ведёт к пикеру, выбор автомата — к чек-листу, «по плану» пишет", async () => {
    const { deps, calls } = wizard();
    const меню = await handleStaffMessage(CHAT, "🍫 Заполнил автомат", OPERATOR, deps);
    const пикер = меню.reply.keyboard?.inline_keyboard.flat().map((b) => b.callback_data) ?? [];
    assert.ok(пикер.includes(`mp:e:${MACHINE_ID}`), "автомат предложен кнопкой");

    const выбран = await handleStaffCallback(CHAT, `mp:e:${MACHINE_ID}`, OPERATOR, deps);
    assert.match(выбран.message ?? "", /По плану в «Olma»/);
    assert.ok(
      (выбран.keyboard?.inline_keyboard.flat().map((b) => b.callback_data) ?? []).includes("rf:plan"),
    );

    const записал = await handleStaffCallback(CHAT, "rf:plan", OPERATOR, deps);
    assert.deepEqual(calls.map((c) => [c.productName, c.qty]), [["Montella", 8], ["Fanta", 5]]);
    assert.match(записал.message ?? "", /Записал 2 позиции/);

    const итог = await handleStaffCallback(CHAT, "rf:done", OPERATOR, deps);
    assert.match(итог.message ?? "", /Записал 2 позиции/);
    assert.equal(deps.conversations.get(CHAT), null, "обход закрыт");
  });

  it("слово «заправил» открывает тот же мастер", async () => {
    const { deps } = wizard();
    const r = await handleStaffMessage(CHAT, "заправил автомат", OPERATOR, deps);
    assert.match(r.reply.text, /Заполнил автомат/i);
    assert.equal(deps.conversations.get(CHAT)?.flow, "refill");
  });

  it("текст на шаге автомата ищет по названию, а не уходит комментарием к задаче", async () => {
    const { deps } = wizard();
    await handleStaffMessage(CHAT, "🍫 Заполнил автомат", OPERATOR, deps);
    const r = await handleStaffMessage(CHAT, "olm", OPERATOR, deps);
    assert.match(r.reply.text, /Нашёл 1/);
  });

  it("слово «отмена» ведёт себя как кнопка: записанное названо и сохранено", async () => {
    // Кнопка говорила «Записано 2 позиции — они сохранены», а слово — сухое
    // «Отменил.». Одинаково подписанные действия не должны иметь разную цену:
    // набравший слово (справка сама его предлагает) решил бы, что стёр обход.
    const { deps, calls } = wizard();
    await handleStaffMessage(CHAT, "🍫 Заполнил автомат", OPERATOR, deps);
    await handleStaffCallback(CHAT, `mp:e:${MACHINE_ID}`, OPERATOR, deps);
    await handleStaffCallback(CHAT, "rf:plan", OPERATOR, deps);
    assert.equal(calls.length, 2);
    const r = await handleStaffMessage(CHAT, "отмена", OPERATOR, deps);
    assert.match(r.reply.text, /записано 2 позиции — они сохранены/i);
    assert.equal(deps.conversations.get(CHAT), null);
  });

  it("«Отмена» пикера не гасит чужой мастер, но закрывает свой", async () => {
    const { deps } = wizard();
    await handleStaffMessage(CHAT, "🍫 Заполнил автомат", OPERATOR, deps);
    const r = await handleStaffCallback(CHAT, "mp:x", OPERATOR, deps);
    assert.match(r.answer, /Отменено/i);
    assert.equal(deps.conversations.get(CHAT), null);
  });
});
