import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PersonRow, WeeklyDigest } from "./core-client";
import { byChat, deliverWeeklyDigest, type WeeklyCore, type WeeklyLog } from "./weekly-delivery";

/** Сводка без чисел: доставке важны неделя и то, что текст непустой. */
const НЕДЕЛЯ: WeeklyDigest = {
  week: "2026-34",
  from: "2026-08-17",
  to: "2026-08-23",
  previousWeek: "2026-33",
  machines: [],
  totals: { qty: 0, revenue: 0, cogs: 0, margin: 0, pct: null, unknownUnits: 0 },
  delta: { qty: 0, revenue: 0, margin: 0, qtyPct: null, revenuePct: null, marginPct: null },
  topProducts: [],
  worstProducts: [],
  refills: { events: 0, detectedUnits: 0, recordedUnits: 0 },
  intake: { orders: 0, units: 0, amount: 0 },
  stocktakes: { positions: 0, lastCountedAt: null },
  deadStock: { rows: [], totalValue: 0 },
  priceChanges: { purchase: [], retail: [] },
  health: {
    runs: [],
    failedStreak: 0,
    lastSuccessAt: null,
    staleHours: null,
    staleThresholdH: 6,
    slotsLagMin: null,
    salesLagH: null,
    snapshotStale: false,
    productSaleLagH: null,
    parityStreak: 0,
    cutoverThreshold: 7,
    parity: { days: 7, ok: false, mismatches: 0, stockOk: false, checked: 0, stockChecked: 0, mode: "mirror", note: null },
  },
  // Здоровье за отчётную неделю (R-H-9): доставке важны неделя и непустой
  // текст, поэтому нули — но поле обязательное, и молчаливо его не бывает.
  weekHealth: {
    week: "2026-34",
    runs: 0,
    success: 0,
    partial: 0,
    failed: 0,
    worstFailedStreak: 0,
    lastSuccessAt: null,
    parityDays: [],
    parityGreen: 0,
    parityRed: 0,
  },
  warnings: [],
};

const ЛЮДИ = [
  { id: "p1", name: "Владелец", roles: ["owner"], tgChatId: "10", active: "yes" },
  { id: "p2", name: "Менеджер", roles: ["manager"], tgChatId: "11", active: "yes" },
  { id: "p3", name: "Оператор", roles: ["operator"], tgChatId: "12", active: "yes" },
] as unknown as PersonRow[];

const СИГНАЛ = {
  since: "2026-08-11T00:00:00Z",
  events: 1,
  notifications: [{ ruleId: "sales.drop", urgency: "weekly", text: "📉 Продажи ниже плана", eventId: "e1" }],
};

/** Стенд: журнал вызовов, живой набор занятых ключей, управляемый отказ чата. */
function стенд(opts: { people?: PersonRow[]; занято?: Set<string>; чатПадает?: number } = {}) {
  const журнал: string[] = [];
  const предупреждения: string[] = [];
  const занято = opts.занято ?? new Set<string>();
  const core: WeeklyCore = {
    vendingWeeklyDigest: async () => {
      журнал.push("digest");
      return НЕДЕЛЯ;
    },
    people: async () => opts.people ?? ЛЮДИ,
    briefingNotifications: async () => СИГНАЛ,
    claimNotification: async (key: string) => {
      журнал.push(`claim:${key}`);
      if (занято.has(key)) return false;
      занято.add(key);
      return true;
    },
    ackNotifications: async (keys: string[]) => {
      журнал.push(`ack:${keys.join(",")}`);
      return { acked: keys.length };
    },
    recordEvent: async (type: string) => {
      журнал.push(`event:${type}`);
      return {};
    },
  };
  const log: WeeklyLog = {
    warn: (m) => предупреждения.push(m),
    error: (m) => предупреждения.push(m),
  };
  const send = async (chatId: number): Promise<void> => {
    журнал.push(`send:${chatId}`);
    if (opts.чатПадает === chatId) throw new Error("chat blocked bot");
  };
  return { core, log, send, журнал, предупреждения, занято };
}

describe("Доставка недельной сводки (R-P5b-7)", () => {
  it("ключ занимается ДО отправки — окно автодеплоя не шлёт вторую сводку", async () => {
    const s = стенд();
    const итог = await deliverWeeklyDigest({ core: s.core, send: s.send, log: s.log });
    assert.equal(итог.delivered, 2);
    assert.equal(итог.chats, 2);
    const claim1 = s.журнал.indexOf("claim:weekly-digest:2026-34:p1");
    const send1 = s.журнал.indexOf("send:10");
    assert.ok(claim1 >= 0 && send1 > claim1, `порядок шагов: ${s.журнал.join(" → ")}`);
    // Оператор в получатели не попал — сводка про деньги парка.
    assert.ok(!s.журнал.includes("send:12"));
  });

  it("повтор в ту же неделю не шлёт ничего — ключи уже заняты", async () => {
    const занято = new Set<string>();
    const первый = стенд({ занято });
    await deliverWeeklyDigest({ core: первый.core, send: первый.send, log: первый.log });
    const второй = стенд({ занято });
    const итог = await deliverWeeklyDigest({ core: второй.core, send: второй.send, log: второй.log });
    assert.equal(итог.delivered, 0);
    assert.equal(итог.skipped, 2);
    assert.ok(!второй.журнал.some((c) => c.startsWith("send:")), "второй прогон обязан молчать");
    assert.ok(!второй.журнал.some((c) => c.startsWith("ack:")), "и ничего не отмечать");
  });

  it("две карточки на один чат — одна сводка, но ключи заняты обе", async () => {
    // Иначе вторая карточка на следующем прогоне сочтёт себя неотправленной и
    // пришлёт в тот же чат дубль.
    const люди = [
      { id: "p1", name: "Владелец", roles: ["owner"], tgChatId: "10", active: "yes" },
      { id: "p9", name: "Он же менеджер", roles: ["manager"], tgChatId: "10", active: "yes" },
    ] as unknown as PersonRow[];
    const s = стенд({ people: люди });
    const итог = await deliverWeeklyDigest({ core: s.core, send: s.send, log: s.log });
    assert.equal(итог.chats, 1);
    assert.equal(итог.delivered, 1);
    assert.equal(s.журнал.filter((c) => c === "send:10").length, 1);
    assert.ok(s.занято.has("weekly-digest:2026-34:p1"));
    assert.ok(s.занято.has("weekly-digest:2026-34:p9"));
  });

  it("сигналы отмечаются, только если сводка дошла хотя бы в один чат", async () => {
    const s = стенд({ чатПадает: 10 });
    const итог = await deliverWeeklyDigest({ core: s.core, send: s.send, log: s.log });
    assert.equal(итог.delivered, 1); // чат 11 получил
    assert.equal(итог.acked, 1);
    assert.ok(s.журнал.includes("ack:e1:sales.drop"));
    assert.ok(s.предупреждения.some((m) => /не доставлена/.test(m)), "провал чата обязан быть в логе");
  });

  it("не дошло НИКОМУ — ack не уходит: сигнал остаётся недоставленным", async () => {
    const s = стенд({ people: [ЛЮДИ[0]!], чатПадает: 10 });
    const итог = await deliverWeeklyDigest({ core: s.core, send: s.send, log: s.log });
    assert.equal(итог.delivered, 0);
    assert.equal(итог.acked, 0);
    assert.ok(!s.журнал.some((c) => c.startsWith("ack:")));
  });

  it("получателей нет — предупреждение в лог, а не тихая «успешная» рассылка", async () => {
    const s = стенд({ people: [ЛЮДИ[2]!] }); // только оператор
    const итог = await deliverWeeklyDigest({ core: s.core, send: s.send, log: s.log });
    assert.equal(итог.chats, 0);
    assert.ok(s.предупреждения.some((m) => /получателей нет/.test(m)));
    assert.ok(!s.журнал.some((c) => c.startsWith("claim:")), "ключ недели тратить не на кого");
  });

  it("Core не ответил — бросаем, ключ недели не занят (повтор возможен)", async () => {
    const s = стенд();
    const core: WeeklyCore = {
      ...s.core,
      vendingWeeklyDigest: async () => {
        throw new Error("Core ответил 503");
      },
    };
    await assert.rejects(() => deliverWeeklyDigest({ core, send: s.send, log: s.log }), /503/);
    assert.ok(!s.журнал.some((c) => c.startsWith("claim:")));
  });

  it("сигналы не пришли — сводка уходит, но отказ не молчит", async () => {
    const s = стенд();
    const core: WeeklyCore = {
      ...s.core,
      briefingNotifications: async () => {
        throw new Error("rules/pending 500");
      },
    };
    const итог = await deliverWeeklyDigest({ core, send: s.send, log: s.log });
    assert.equal(итог.delivered, 2);
    assert.equal(итог.acked, 0);
    assert.ok(s.предупреждения.some((m) => /сигналы правил не получены/i.test(m)));
  });

  it("роль владельца в легаси-поле — тоже получатель (прод, п.1)", async () => {
    // На проде `roles` содержит только storekeeper/technician/operator/collector,
    // а владелец помечен текстовым `role='владелец'`. Требовать только `roles`
    // значило бы не отправить сводку НИКОМУ и узнать об этом никогда.
    const люди = [
      { id: "p1", name: "Владелец", role: "владелец", roles: ["collector"], tgChatId: "10", active: "yes" },
      { id: "p2", name: "Бывший менеджер", role: "менеджер", roles: [], tgChatId: "11", active: "no" },
    ] as unknown as PersonRow[];
    const s = стенд({ people: люди });
    const итог = await deliverWeeklyDigest({ core: s.core, send: s.send, log: s.log });
    assert.equal(итог.chats, 1);
    assert.ok(s.журнал.includes("send:10"));
    // Уволенного легаси-роль не воскрешает.
    assert.ok(!s.журнал.includes("send:11"));
  });

  it("получателей нет — событие в Core и строка владельцу, а не только консоль (прод, п.1)", async () => {
    const s = стенд({ people: [ЛЮДИ[2]!] });
    const итог = await deliverWeeklyDigest({
      core: s.core,
      send: s.send,
      log: s.log,
      ownerChats: [777],
    });
    assert.equal(итог.chats, 0);
    assert.ok(s.журнал.includes("event:weekly-digest.no_recipients"));
    assert.ok(s.журнал.includes("send:777"), "владелец обязан узнать, что сводка не ушла");
    assert.ok(s.предупреждения.some((m) => /получателей нет/.test(m)));
  });

  it("ключ занят — говорим «уже доставлено», а не молчим (N5)", async () => {
    const занято = new Set<string>();
    const первый = стенд({ занято });
    await deliverWeeklyDigest({ core: первый.core, send: первый.send, log: первый.log });
    const второй = стенд({ занято });
    const итог = await deliverWeeklyDigest({ core: второй.core, send: второй.send, log: второй.log });
    assert.equal(итог.skipped, 2);
    assert.ok(второй.предупреждения.some((m) => /уже доставлен/i.test(m)));
  });

  it("нечисловой чат в карточке — пропуск с предупреждением, а не sendMessage(NaN) (N5)", async () => {
    const люди = [
      { id: "p1", name: "Владелец", roles: ["owner"], tgChatId: "@vasya", active: "yes" },
      { id: "p2", name: "Менеджер", roles: ["manager"], tgChatId: "11", active: "yes" },
    ] as unknown as PersonRow[];
    const s = стенд({ people: люди });
    const итог = await deliverWeeklyDigest({ core: s.core, send: s.send, log: s.log });
    assert.equal(итог.delivered, 1);
    assert.ok(!s.журнал.some((c) => c === "send:NaN"));
    assert.ok(s.предупреждения.some((m) => /@vasya/.test(m)));
    // Ключ на нечисловой чат не тратим: карточку починят — сводка уйдёт.
    assert.ok(!s.занято.has("weekly-digest:2026-34:p1"));
  });

  it("карточка без чата в группировку не попадает", () => {
    const люди = [
      { id: "p1", name: "Владелец", tgChatId: " 10 ", active: "yes" },
      { id: "p5", name: "Без чата", tgChatId: null, active: "yes" },
    ] as unknown as PersonRow[];
    assert.deepEqual([...byChat(люди).keys()], ["10"]);
  });
});
