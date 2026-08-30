import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { NotionError, notion, toBlocks } from "./notion";

describe("Отчёт в Notion", () => {
  it("собирает заголовки, абзацы и списки", () => {
    const blocks = toBlocks({
      title: "Дебиторка",
      author: "mydon-finance",
      blocks: [
        { heading: "Итог", paragraphs: ["Просрочено 12 позиций."], bullets: ["Olma — 5 млн"] },
      ],
    }) as { type: string }[];
    const types = blocks.map((b) => b.type);
    assert.ok(types.includes("heading_2"));
    assert.ok(types.includes("paragraph"));
    assert.ok(types.includes("bulleted_list_item"));
  });

  it("подписывает автора и время — через неделю должно быть понятно, кто писал", () => {
    const blocks = toBlocks({ title: "T", author: "vendhub-ops", blocks: [] });
    const last = JSON.stringify(blocks[blocks.length - 1]);
    assert.match(last, /vendhub-ops/);
    assert.match(last, /MYDON/);
  });

  it("длинный текст режется, а не теряется (у Notion предел на блок)", () => {
    const long = "а".repeat(5000);
    const blocks = toBlocks({ title: "T", author: "a", blocks: [{ paragraphs: [long] }] });
    // 5000 символов не влезают в один блок — должно получиться несколько.
    assert.ok(blocks.length >= 4, `ожидалось разбиение, получено блоков: ${blocks.length}`);
  });

  it("не превышает предел Notion в 100 блоков за раз", () => {
    const many = Array.from({ length: 300 }, (_, i) => `пункт ${i}`);
    const blocks = toBlocks({ title: "T", author: "a", blocks: [{ bullets: many }] });
    assert.ok(blocks.length <= 100);
  });

  it("без токена коннектор считается ненастроенным и не мешает работе", () => {
    assert.equal(notion.configured({} as NodeJS.ProcessEnv), false);
    assert.equal(notion.fromEnv({} as NodeJS.ProcessEnv), null);
    assert.equal(
      notion.configured({ NOTION_TOKEN: "x", NOTION_PARENT_PAGE_ID: "y" } as NodeJS.ProcessEnv),
      true,
    );
  });

  it("отправляет create-page с official title property object", async () => {
    const previousFetch = globalThis.fetch;
    const previousToLocaleString = Date.prototype.toLocaleString;
    let requestUrl = "";
    let requestInit: RequestInit | undefined;
    Date.prototype.toLocaleString = () => "30.08.2026, 17:00:00";
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      requestUrl = String(input);
      requestInit = init;
      return new Response(
        JSON.stringify({
          id: "11111111-1111-4111-8111-111111111111",
          url: "https://www.notion.so/report-11111111111141118111111111111111",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof globalThis.fetch;

    try {
      const report = {
        title: "Telegram CRM — 30.08.2026",
        author: "solution-scout",
        blocks: [{ heading: "Что нашёл", paragraphs: ["Два релевантных репозитория"] }],
      };
      const published = await notion.publish(report, {
        token: "notion-test-token",
        parentPageId: "22222222-2222-4222-8222-222222222222",
      });

      assert.equal(requestUrl, "https://api.notion.com/v1/pages");
      assert.equal(requestInit?.method, "POST");
      assert.deepEqual(JSON.parse(String(requestInit?.body)), {
        parent: { page_id: "22222222-2222-4222-8222-222222222222" },
        properties: {
          title: {
            title: [{ type: "text", text: { content: "Telegram CRM — 30.08.2026" } }],
          },
        },
        children: [
          {
            object: "block",
            type: "heading_2",
            heading_2: { rich_text: [{ type: "text", text: { content: "Что нашёл" } }] },
          },
          {
            object: "block",
            type: "paragraph",
            paragraph: {
              rich_text: [{ type: "text", text: { content: "Два релевантных репозитория" } }],
            },
          },
          {
            object: "block",
            type: "paragraph",
            paragraph: {
              rich_text: [
                {
                  type: "text",
                  text: { content: "— solution-scout, MYDON · 30.08.2026, 17:00:00" },
                },
              ],
            },
          },
        ],
      });
      assert.deepEqual(published, {
        id: "11111111-1111-4111-8111-111111111111",
        url: "https://www.notion.so/report-11111111111141118111111111111111",
      });
    } finally {
      globalThis.fetch = previousFetch;
      Date.prototype.toLocaleString = previousToLocaleString;
    }
  });

  it("объясняет object_not_found как невыданный доступ к parent page", async () => {
    const previousFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ code: "object_not_found", message: "Could not find page" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      })) as typeof globalThis.fetch;
    try {
      await assert.rejects(
        notion.publish(
          { title: "T", author: "agent", blocks: [] },
          { token: "token", parentPageId: "page" },
        ),
        (error: unknown) => {
          assert.ok(error instanceof NotionError);
          assert.equal(error.status, 404);
          assert.match(error.message, /не расшарена интеграции/i);
          assert.match(error.message, /Connections/);
          return true;
        },
      );
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  it("сохраняет HTTP status и Retry-After для безопасной классификации outbox", async () => {
    const previousFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ code: "rate_limited", message: "slow down" }), {
        status: 429,
        headers: { "Content-Type": "application/json", "Retry-After": "2" },
      })) as typeof globalThis.fetch;
    try {
      await assert.rejects(
        notion.publish(
          { title: "T", author: "agent", blocks: [] },
          { token: "token", parentPageId: "page" },
        ),
        (error: unknown) => {
          assert.ok(error instanceof NotionError);
          assert.equal(error.status, 429);
          assert.equal(error.retryAfterMs, 2_000);
          return true;
        },
      );
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
});
