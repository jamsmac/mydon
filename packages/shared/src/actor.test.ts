import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { actorKindOf, agentActor, toolActor } from "./actor";

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
