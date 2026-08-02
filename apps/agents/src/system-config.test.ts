import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { overlayEnv, type EffectiveConfigItem } from "./system-config";

describe("overlayEnv: тумблеры системы поверх окружения", () => {
  it("накладывает действующие значения и считает заданные владельцем (db)", () => {
    const env: Record<string, string | undefined> = { AGENT_AUTONOMY_MAX: "T0" };
    const items: EffectiveConfigItem[] = [
      { key: "AGENT_AUTONOMY_MAX", value: "T2", source: "db" },
      { key: "LLM_PROVIDER", value: "claude-cli", source: "db" },
      { key: "EMBED_BASE_URL", value: "", source: "default" },
    ];
    const fromDb = overlayEnv(env, items);
    assert.equal(env.AGENT_AUTONOMY_MAX, "T2", "база перекрыла env");
    assert.equal(env.LLM_PROVIDER, "claude-cli");
    assert.equal(env.EMBED_BASE_URL, "", "дефолт-пусто → путь спит");
    assert.equal(fromDb, 2, "два тумблера заданы владельцем");
  });

  it("сброс тумблера возвращает env к прежнему значению (идемпотентно)", () => {
    // Владелец задал в базе, потом сбросил → source становится env, значение = env.
    const env: Record<string, string | undefined> = { AGENTS_SCHEDULES_PAUSED: "1" };
    overlayEnv(env, [{ key: "AGENTS_SCHEDULES_PAUSED", value: "0", source: "db" }]);
    assert.equal(env.AGENTS_SCHEDULES_PAUSED, "0", "снята пауза из панели");
    // Следующая перечитка после сброса: source=env, value=исходный env "1".
    overlayEnv(env, [{ key: "AGENTS_SCHEDULES_PAUSED", value: "1", source: "env" }]);
    assert.equal(env.AGENTS_SCHEDULES_PAUSED, "1", "вернулись к env, а не застряли на значении базы");
  });
});
