import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { CliModelGateway, type CliSpawn, isCliProvider, resolveModelChain } from "./model-gateway";

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
});
