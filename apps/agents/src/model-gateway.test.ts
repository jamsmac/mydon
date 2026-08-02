import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { resolveModelChain } from "./model-gateway";

const KEYS = ["LLM_MODEL", "LLM_FALLBACK_MODELS", "LLM_BASE_URL", "LLM_API_KEY"] as const;
const saved: Record<string, string | undefined> = {};
for (const k of KEYS) saved[k] = process.env[k];
beforeEach(() => {
  for (const k of KEYS) delete process.env[k];
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("resolveModelChain", () => {
  it("основная + запасные по порядку, без дублей и пустых", () => {
    assert.deepEqual(resolveModelChain("gpt-x", "cheap, cheap, free ,"), ["gpt-x", "cheap", "free"]);
  });

  it("только основная", () => {
    assert.deepEqual(resolveModelChain("solo", undefined), ["solo"]);
  });

  it("не настроено → пустая цепочка (LLM-путь выключен)", () => {
    assert.deepEqual(resolveModelChain(undefined, undefined), []);
    assert.deepEqual(resolveModelChain("", "  "), []);
  });

  it("основная не дублируется, если повторена в fallback", () => {
    assert.deepEqual(resolveModelChain("m1", "m1, m2"), ["m1", "m2"]);
  });
});
