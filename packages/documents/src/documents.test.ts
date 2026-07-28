import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createDocumentBuilder, findFileId } from "./index";

/**
 * Проверяем разбор ответа — самое хрупкое место: форма блоков результата
 * исполнения кода менялась между версиями API, и жёсткая привязка к одной
 * форме означала бы «файл не получился» на первом же обновлении.
 */
describe("Поиск готового файла в ответе", () => {
  it("находит file_id в блоке результата кода", () => {
    const resp = {
      content: [
        { type: "text", text: "Готово" },
        {
          type: "bash_code_execution_tool_result",
          content: {
            type: "bash_code_execution_result",
            content: [{ type: "bash_code_execution_output", file_id: "file_abc123" }],
          },
        },
      ],
    };
    assert.equal(findFileId(resp), "file_abc123");
  });

  it("находит file_id и в другой форме ответа (иначе ломались бы обновления API)", () => {
    const resp = { content: [{ type: "container_upload", file_id: "file_xyz" }] };
    assert.equal(findFileId(resp), "file_xyz");
  });

  it("нет файла — честно null, а не пустая строка", () => {
    assert.equal(findFileId({ content: [{ type: "text", text: "не смог" }] }), null);
    assert.equal(findFileId({}), null);
    assert.equal(findFileId(null), null);
  });

  it("не зацикливается на кольцевых ссылках", () => {
    const a: Record<string, unknown> = { type: "x" };
    a.self = a; // ответ SDK может содержать ссылки на себя
    assert.equal(findFileId(a), null);
  });
});

describe("Конструирование строителя документов", () => {
  it("возвращает функцию и не тянет SDK при создании", () => {
    const before = Object.keys(require.cache).some((p) => p.includes("@anthropic-ai"));
    const build = createDocumentBuilder({ apiKey: "sk-ant-нет-сети" });
    assert.equal(typeof build, "function");
    const after = Object.keys(require.cache).some((p) => p.includes("@anthropic-ai"));
    // SDK ленив: пакет импортируется даже там, где документы не нужны.
    assert.equal(before, after);
  });
});
