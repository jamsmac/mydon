import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { actorKindOf, agentActor, isActorRef, parseAgentName, toolActor } from "./actor";

describe("вид актора по ссылке", () => {
  it("инструмент — система, а не человек", () => {
    // Боевой случай: массовый прогон разметки писался в журнал как «human».
    assert.equal(actorKindOf("tool:backfill-machine-kinds"), "system");
    assert.equal(actorKindOf("tool:apply-maintenance-norms"), "system");
  });

  it("агент — агент", () => {
    assert.equal(actorKindOf("agent:coffee-monitor"), "agent");
    assert.equal(actorKindOf("agent:claude-code"), "agent");
  });

  it("владелец и сотрудник — человек", () => {
    assert.equal(actorKindOf("owner"), "human");
    assert.equal(actorKindOf("jamshid"), "human");
  });

  it("явная система — система", () => {
    assert.equal(actorKindOf("system"), "system");
  });

  it("пусто — система, а не человек", () => {
    // Действие без установленного инициатора не приписываем человеку.
    assert.equal(actorKindOf(""), "system");
    assert.equal(actorKindOf(null), "system");
    assert.equal(actorKindOf(undefined), "system");
    assert.equal(actorKindOf("   "), "system");
  });

  it("регистр и пробелы не меняют вид", () => {
    assert.equal(actorKindOf("  TOOL:Backfill  "), "system");
    assert.equal(actorKindOf("Agent:Coach"), "agent");
  });

  it("неизвестная ссылка — человек (ошибаемся в сторону большего веса)", () => {
    assert.equal(actorKindOf("кто-то-новый"), "human");
  });

  it("сборщики ссылок дают то, что разбирает actorKindOf", () => {
    assert.equal(actorKindOf(toolActor("import-globerent")), "system");
    assert.equal(actorKindOf(agentActor("globerent-monitor")), "agent");
  });
});

describe("имя агента, объявленное в панели", () => {
  it("принимает имена агентов и приводит к нижнему регистру", () => {
    assert.equal(parseAgentName("claude-code"), "claude-code");
    assert.equal(parseAgentName("  Codex  "), "codex");
  });

  it("имя становится ссылкой агента, а не человека", () => {
    const name = parseAgentName("claude-code");
    assert.ok(name !== null);
    assert.equal(actorKindOf(agentActor(name)), "agent");
  });

  it("отбрасывает пустое, префиксы и мусор — объявить себя владельцем или скриптом нельзя", () => {
    for (const bad of [undefined, null, "", "x", "agent:claude", "tool:backfill", "owner admin", "-lead", "a".repeat(41), "клод"]) {
      assert.equal(parseAgentName(bad), null, JSON.stringify(bad));
    }
  });
});

describe("формат ссылки актора — один на панель и Core", () => {
  it("принимает все виды ссылок, что пишутся в журнал", () => {
    for (const ref of ["owner", "agent:claude-code", "person:0b6a3c1e-4f7d-4c2a-9b1e-2f3a4b5c6d7e", "tool:backfill", "a.b+c@mail.uz"]) {
      assert.equal(isActorRef(ref), true, ref);
    }
  });

  it("отбрасывает не-ASCII, пробелы, разметку и слишком длинное — такое не пройдёт заголовком fetch", () => {
    for (const bad of [null, undefined, "", "оператор@почта.уз", "two words", "<b>x</b>", "a".repeat(121)]) {
      assert.equal(isActorRef(bad), false, JSON.stringify(bad));
    }
  });
});
