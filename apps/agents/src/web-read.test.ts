import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildWebProposal, readWebSources, type PageFetcher } from "./web-read";

/** Фейковый читатель: по URL отдаёт страницу или бросает ошибку. */
function fakeFetcher(byUrl: Record<string, { status?: number; text?: string; truncated?: boolean; throw?: string }>): PageFetcher {
  return async (url) => {
    const r = byUrl[url];
    if (!r || r.throw) throw new Error(r?.throw ?? "нет такого url");
    return { url, status: r.status ?? 200, text: r.text ?? "", truncated: r.truncated ?? false };
  };
}

describe("readWebSources", () => {
  it("читает несколько источников, чистит выжимку", async () => {
    const fetcher = fakeFetcher({
      "https://a": { text: "  цена   станка\n\n1000  " },
      "https://b": { text: "тендер открыт", status: 200 },
    });
    const res = await readWebSources([{ name: "A", url: "https://a" }, { name: "B", url: "https://b" }], fetcher);
    assert.equal(res.length, 2);
    assert.equal(res[0].excerpt, "цена станка 1000", "лишние пробелы схлопнуты");
    assert.equal(res[0].chars, "  цена   станка\n\n1000  ".length);
  });

  it("ошибка одного источника не роняет остальные", async () => {
    const fetcher = fakeFetcher({ "https://ok": { text: "ок" }, "https://bad": { throw: "таймаут" } });
    const res = await readWebSources([{ name: "OK", url: "https://ok" }, { name: "BAD", url: "https://bad" }], fetcher);
    assert.equal(res[0].error, undefined);
    assert.equal(res[1].error, "таймаут");
    assert.equal(res[1].status, null);
  });
});

describe("buildWebProposal", () => {
  it("пустой список → null (читать нечего)", () => {
    assert.equal(buildWebProposal([]), null);
  });

  it("сводка: сколько прочитано и что недоступно", () => {
    const p = buildWebProposal([
      { name: "Цены", url: "u1", status: 200, chars: 500, truncated: false, excerpt: "..." },
      { name: "Тендеры", url: "u2", status: null, chars: 0, truncated: false, excerpt: "", error: "таймаут" },
    ]);
    assert.ok(p);
    assert.match(p.action, /прочитал 1\/2/);
    assert.match(p.action, /Недоступны: Тендеры/);
    assert.equal(p.facts.ok, 1);
    assert.equal(p.facts.failed, 1);
  });

  it("HTTP 404 считается неуспехом", () => {
    const p = buildWebProposal([{ name: "X", url: "u", status: 404, chars: 10, truncated: false, excerpt: "" }]);
    assert.ok(p);
    assert.equal(p.facts.ok, 0);
    assert.match(p.action, /прочитал 0\/1/);
  });
});
