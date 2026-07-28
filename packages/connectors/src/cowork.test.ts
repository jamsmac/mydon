import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseMemoryFile, parseRun, parseSpaces, parseTasks } from "./cowork";

describe("Чтение агентов Cowork", () => {
  it("читает расписание и время последнего запуска", () => {
    const tasks = parseTasks(
      JSON.stringify({
        scheduledTasks: [
          {
            id: "topdim-product-hunt",
            cronExpression: "0 9 * * *",
            enabled: true,
            filePath: "/Users/js/Claude/Scheduled/topdim-product-hunt/SKILL.md",
            lastRunAt: "2026-07-28T04:17:21.383Z",
            userSelectedFolders: ["/папка"],
          },
        ],
      }),
    );
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].cron, "0 9 * * *");
    assert.equal(tasks[0].enabled, true);
    assert.match(tasks[0].lastRunAt ?? "", /2026-07-28/);
  });

  it("битый файл не роняет импорт — данные владельца важнее полноты прохода", () => {
    assert.deepEqual(parseTasks("{это не json"), []);
    assert.deepEqual(parseTasks("{}"), []);
    assert.deepEqual(parseSpaces("сломано"), []);
    assert.equal(parseRun("не json"), null);
  });
});

describe("Чтение памяти Cowork", () => {
  it("берёт заголовок из описания, а не из имени файла", () => {
    const m = parseMemoryFile(
      "mydon-tooling-decisions.md",
      '---\nname: x\ndescription: "Что берём и чего избегаем в инструментах"\n---\n\nADOPT: document-skills.',
    );
    assert.equal(m.name, "mydon-tooling-decisions");
    assert.match(m.title, /инструмент/i);
    assert.match(m.body, /ADOPT/);
    assert.ok(!m.body.startsWith("---"), "служебная шапка не должна попадать в текст");
  });

  it("без описания берёт первую строку", () => {
    const m = parseMemoryFile("note.md", "# Решения по складу\n\nТекст.");
    assert.equal(m.title, "Решения по складу");
  });
});

describe("Чтение запусков агента", () => {
  it("видит ошибку запуска — владелец должен знать, что агент встал", () => {
    const run = parseRun(
      JSON.stringify({
        sessionId: "local_1",
        scheduledTaskId: "topdim-product-hunt",
        createdAt: "2026-07-27T04:00:00.000Z",
        title: "Поиск товаров",
        error: "You're out of usage credits.",
      }),
    );
    assert.equal(run?.taskId, "topdim-product-hunt");
    assert.match(run?.error ?? "", /credits/);
  });

  it("успешный запуск — без ошибки", () => {
    const run = parseRun(JSON.stringify({ sessionId: "local_2", createdAt: "2026-07-20T04:00:00.000Z" }));
    assert.equal(run?.error, null);
  });

  it("ошибка объектом тоже читается (форма поля меняется между версиями)", () => {
    const run = parseRun(
      JSON.stringify({ sessionId: "local_3", error: { message: "Prompt is too long" } }),
    );
    assert.match(run?.error ?? "", /too long/);
  });
});
