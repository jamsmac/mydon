import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { CliModelGateway, type CliSpawn, harnessPreset, isCliProvider, resolveModelChain } from "./model-gateway";

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

  it("CLI-подписка без модели → цепочка [default]", () => {
    assert.deepEqual(resolveModelChain(undefined, undefined, "claude-cli"), ["default"]);
    assert.deepEqual(resolveModelChain(undefined, undefined, "http"), [], "не-CLI без модели — пусто");
  });
});

describe("isCliProvider", () => {
  it("распознаёт подписочные CLI-провайдеры", () => {
    assert.equal(isCliProvider("claude-cli"), true);
    assert.equal(isCliProvider("claude-subscription"), true);
    assert.equal(isCliProvider(" CLI "), true);
    assert.equal(isCliProvider("http"), false);
    assert.equal(isCliProvider(undefined), false);
  });
});

describe("CliModelGateway — подписочный claude -p", () => {
  /** Фейковый spawner: ловит вход и отдаёт заданный результат. */
  function fakeSpawn(result: { code?: number; stdout?: string; stderr?: string; throw?: string }) {
    const seen: { cmd: string; args: string[]; input: string }[] = [];
    const spawn: CliSpawn = async (cmd, args, input) => {
      seen.push({ cmd, args, input });
      if (result.throw) throw new Error(result.throw);
      return { code: result.code ?? 0, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
    };
    return { spawn, seen };
  }

  it("успех: stdout → text, costUsd 0 (подписка)", async () => {
    const { spawn, seen } = fakeSpawn({ stdout: "  ответ модели  " });
    const gw = new CliModelGateway("claude", ["-p"], spawn);
    const res = await gw.call("default", { system: "страж", prompt: "задача" });
    assert.equal(res.ok, true);
    assert.equal(res.text, "ответ модели");
    assert.equal(res.costUsd, 0);
    // Промпт ушёл в STDIN (system+prompt), не в argv.
    assert.match(seen[0].input, /страж[\s\S]*задача/);
    assert.deepEqual(seen[0].args, ["-p"], "default → без --model");
  });

  it("конкретная модель → --model в args", async () => {
    const { spawn, seen } = fakeSpawn({ stdout: "ok" });
    await new CliModelGateway("claude", ["-p"], spawn).call("sonnet", { prompt: "x" });
    assert.deepEqual(seen[0].args, ["-p", "--model", "sonnet"]);
  });

  it("ненулевой код → ok=false со stderr", async () => {
    const { spawn } = fakeSpawn({ code: 1, stderr: "не залогинен" });
    const res = await new CliModelGateway("claude", ["-p"], spawn).call("default", { prompt: "x" });
    assert.equal(res.ok, false);
    assert.match(res.error ?? "", /код 1/);
    assert.match(res.error ?? "", /не залогинен/);
  });

  it("сбой запуска (CLI нет) → ok=false, не падает", async () => {
    const { spawn } = fakeSpawn({ throw: "ENOENT" });
    const res = await new CliModelGateway("claude", ["-p"], spawn).call("default", { prompt: "x" });
    assert.equal(res.ok, false);
    assert.match(res.error ?? "", /ENOENT/);
  });

  it("promptVia=arg — промпт уходит аргументом, stdin пуст; свой modelFlag", async () => {
    const { spawn, seen } = fakeSpawn({ stdout: "ok" });
    // Как codex/gemini: промпт последним аргументом, модель через -m.
    await new CliModelGateway("codex", ["exec"], spawn, 120_000, "arg", "-m").call("gpt-x", { prompt: "задача" });
    assert.deepEqual(seen[0].args, ["exec", "-m", "gpt-x", "задача"]);
    assert.equal(seen[0].input, "", "в arg-режиме stdin пуст");
  });
});

describe("harnessPreset — харнессы claude/codex/gemini", () => {
  it("claude → claude -p, stdin, --model", () => {
    const p = harnessPreset("claude-cli");
    assert.equal(p?.cmd, "claude");
    assert.deepEqual(p?.baseArgs, ["-p"]);
    assert.equal(p?.modelFlag, "--model");
  });
  it("codex → codex exec, -m", () => {
    const p = harnessPreset("codex-cli");
    assert.equal(p?.cmd, "codex");
    assert.deepEqual(p?.baseArgs, ["exec"]);
    assert.equal(p?.modelFlag, "-m");
  });
  it("gemini → gemini, -m", () => {
    const p = harnessPreset("gemini-cli");
    assert.equal(p?.cmd, "gemini");
    assert.equal(p?.modelFlag, "-m");
  });
  it("все три — подписочные CLI-провайдеры (claudexor их ротирует)", () => {
    assert.equal(isCliProvider("codex-cli"), true);
    assert.equal(isCliProvider("gemini-cli"), true);
  });
  it("не-CLI провайдер → null пресет", () => {
    assert.equal(harnessPreset("http"), null);
    assert.equal(harnessPreset(undefined), null);
  });
});
