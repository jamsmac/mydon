import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { notion, toBlocks } from "./notion";

describe("Отчёт в Notion", () => {
  it("собирает заголовки, абзацы и списки", () => {
    const blocks = toBlocks({
      title: "Дебиторка",
      author: "mydon-finance",
      blocks: [{ heading: "Итог", paragraphs: ["Просрочено 12 позиций."], bullets: ["Olma — 5 млн"] }],
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
});
