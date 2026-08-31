import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { signature } from "./memory";
import { buildWebProposal, readWebSources, type PageFetcher, type WebReadResult } from "./web-read";

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

describe("read-sources: дедуп по signatureFacts, а не по волатильным facts (П2)", () => {
  const src = (over: Partial<WebReadResult>): WebReadResult => ({
    name: "Цены",
    url: "https://a",
    status: 200,
    chars: 500,
    truncated: false,
    excerpt: "цена станка 1000",
    ...over,
  });

  it("изменились только chars/excerpt (динамическая страница) — сигнатура та же, дубль подавлен", () => {
    // Тот же источник, доступен, но объём и выжимка «плывут» каждый фетч.
    const первый = buildWebProposal([src({ chars: 500, excerpt: "цена станка 1000" })]);
    const второй = buildWebProposal([src({ chars: 812, excerpt: "цена станка 1000 просмотров 42" })]);
    assert.ok(первый && второй);
    // facts владельцу — ПОЛНЫЕ и различны (chars/excerpt внутри).
    assert.notDeepEqual(первый.facts, второй.facts);
    // А ключ дедупа — стабилен: волатильное не «плывёт» в сигнатуру.
    assert.equal(
      signature(первый.signatureFacts!),
      signature(второй.signatureFacts!),
      "chars/excerpt не должны менять сигнатуру — иначе дубль каждый прогон",
    );
  });

  it("источник лёг (200 → ошибка) — содержательное изменение, подаётся заново", () => {
    const работал = buildWebProposal([src({})]);
    const лёг = buildWebProposal([src({ status: null, chars: 0, excerpt: "", error: "таймаут" })]);
    assert.ok(работал && лёг);
    assert.notEqual(
      signature(работал.signatureFacts!),
      signature(лёг.signatureFacts!),
      "падение источника обязано менять сигнатуру",
    );
  });

  it("добавлен новый источник — сигнатура меняется", () => {
    const один = buildWebProposal([src({})]);
    const два = buildWebProposal([src({}), src({ name: "Тендеры", url: "https://b" })]);
    assert.ok(один && два);
    assert.notEqual(signature(один.signatureFacts!), signature(два.signatureFacts!));
  });

  it("порядок источников не влияет на сигнатуру (детерминизм)", () => {
    const прямой = buildWebProposal([src({ url: "https://a" }), src({ name: "B", url: "https://b" })]);
    const обратный = buildWebProposal([src({ name: "B", url: "https://b" }), src({ url: "https://a" })]);
    assert.ok(прямой && обратный);
    assert.equal(signature(прямой.signatureFacts!), signature(обратный.signatureFacts!));
  });
});
