import "reflect-metadata";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { plainToInstance } from "class-transformer";
import { validate, type ValidationError } from "class-validator";
import {
  AgentsController,
  CatalogSkillDto,
  CreateAgentDto,
  RunSkillDto,
  SyncCatalogDto,
  UpdateAgentDto,
} from "./agents.controller";

/** Все сообщения валидатора, включая вложенные (webSources[i].url лежит в children). */
async function problems(dto: object): Promise<string[]> {
  const flatten = (errors: ValidationError[]): string[] =>
    errors.flatMap((e) => [...Object.values(e.constraints ?? {}), ...flatten(e.children ?? [])]);
  return flatten(await validate(dto));
}

describe("Карточка агента — валидация kbPages (страницы знаний, R-LS-8)", () => {
  it("принимает относительные пути внутри shared/ с расширением .md", async () => {
    const dto = plainToInstance(CreateAgentDto, {
      name: "globerent-sales",
      kbPages: ["shared/kb/globerent/heli-models.md", "shared/COMPANY.md", "shared/kb/vendhub/faq-2026.md"],
    });
    assert.deepEqual(await problems(dto), []);
  });

  it("отсекает путь с .. — контекст модели нельзя увести за пределы shared/", async () => {
    // Путь проходит формат shared/**.md, но содержит .. — ловит вторая проверка.
    const sneaky = plainToInstance(UpdateAgentDto, { kbPages: ["shared/kb/../secret.md"] });
    const list = await problems(sneaky);
    assert.ok(list.some((m) => /не может содержать \.\./.test(m)), list.join("; "));
    // Совсем чужой путь (.env за пределами shared/) — отказ по любой из проверок.
    const escape = plainToInstance(UpdateAgentDto, { kbPages: ["shared/kb/../../.env"] });
    assert.ok((await problems(escape)).length > 0);
  });

  it("отсекает абсолютные пути, пути не из shared/ и не-.md файлы", async () => {
    for (const bad of ["/etc/passwd", "kb/globerent/faq.md", "shared/kb/globerent/pricelist.xlsx", "https://x.uz/a.md"]) {
      const dto = plainToInstance(UpdateAgentDto, { kbPages: [bad] });
      const list = await problems(dto);
      assert.ok(list.some((m) => /shared\/kb/.test(m)), `«${bad}» должен быть отклонён: ${list.join("; ")}`);
    }
  });

  it("kbPages — список строк, не строка", async () => {
    const dto = plainToInstance(UpdateAgentDto, { kbPages: "shared/kb/globerent/faq.md" });
    assert.ok((await problems(dto)).length > 0);
  });
});

describe("Карточка агента — границы роли", () => {
  it("mission до 2000 символов, nonGoals до 20 пунктов по 300 символов", async () => {
    const ok = plainToInstance(UpdateAgentDto, { mission: "Одна задача", nonGoals: ["НЕ пишет клиентам"] });
    assert.deepEqual(await problems(ok), []);
    const long = plainToInstance(UpdateAgentDto, { mission: "x".repeat(2001) });
    assert.ok((await problems(long)).length > 0, "миссия длиннее 2000 — отказ");
    const many = plainToInstance(UpdateAgentDto, { nonGoals: Array.from({ length: 21 }, (_, i) => `НЕ ${i}`) });
    assert.ok((await problems(many)).length > 0, "21 non_goal — отказ");
  });

  it("webSources: только http(s) с явной схемой; кириллица в пути допустима", async () => {
    const ok = plainToInstance(UpdateAgentDto, {
      webSources: [{ name: "OLX", url: "https://olx.uz/list/q-вилочный-погрузчик/" }],
    });
    assert.deepEqual(await problems(ok), []);
    const bare = plainToInstance(UpdateAgentDto, { webSources: [{ name: "Xarid", url: "xarid.uzex.uz" }] });
    assert.ok((await problems(bare)).length > 0, "адрес без схемы — отказ");
  });
});

describe("Каталог навыков — валидация зеркала файлов (R-SD-1)", () => {
  const skill = (over: Record<string, unknown> = {}) => ({
    agent: "vendhub-ops",
    skill: "parts-audit",
    description: "Сверка узлов по журналу",
    executor: "llm",
    tier: "T1",
    triggers: ["узлы", "сверка"],
    allowedTools: ["core.tasks"],
    modelEffort: "medium",
    maxTokens: 4000,
    hasCode: false,
    problems: [],
    ...over,
  });

  it("принимает полную строку каталога", async () => {
    assert.deepEqual(await problems(plainToInstance(CatalogSkillDto, skill())), []);
  });

  it("имена агента и навыка — только по формату файлов", async () => {
    for (const bad of ["VendHub", "-ops", "ops ops", "x".repeat(65), ""]) {
      const dto = plainToInstance(CatalogSkillDto, skill({ agent: bad }));
      assert.ok((await problems(dto)).length > 0, `агент «${bad}» должен быть отклонён`);
      const other = plainToInstance(CatalogSkillDto, skill({ skill: bad }));
      assert.ok((await problems(other)).length > 0, `навык «${bad}» должен быть отклонён`);
    }
  });

  it("исполнитель — только code | llm, тир — только T0..T4", async () => {
    assert.ok((await problems(plainToInstance(CatalogSkillDto, skill({ executor: "bash" })))).length > 0);
    assert.ok((await problems(plainToInstance(CatalogSkillDto, skill({ tier: "T9" })))).length > 0);
    // Тир не задан в frontmatter — это норма, а не ошибка.
    assert.deepEqual(await problems(plainToInstance(CatalogSkillDto, skill({ tier: undefined }))), []);
  });

  it("список каталога ограничен сверху — один агент не завалит Core", async () => {
    const many = plainToInstance(SyncCatalogDto, {
      skills: Array.from({ length: 1001 }, (_, i) => skill({ skill: `s-${i}` })),
    });
    assert.ok((await problems(many)).length > 0);
    const sane = plainToInstance(SyncCatalogDto, { skills: [skill()] });
    assert.deepEqual(await problems(sane), []);
    const broken = plainToInstance(SyncCatalogDto, { skills: [skill({ executor: "bash" })] });
    assert.ok((await problems(broken)).length > 0, "вложенные строки обязаны проверяться");
  });
});

describe("Запуск навыка из панели — валидация (R-SD-2)", () => {
  it("вход необязателен и ограничен 4000 символами", async () => {
    assert.deepEqual(await problems(plainToInstance(RunSkillDto, {})), []);
    assert.deepEqual(
      await problems(plainToInstance(RunSkillDto, { input: "Сверить узлы", modelEffort: "high" })),
      [],
    );
    const long = plainToInstance(RunSkillDto, { input: "я".repeat(4001) });
    assert.ok((await problems(long)).length > 0);
  });

  it("усилие модели — только из известного списка", async () => {
    const dto = plainToInstance(RunSkillDto, { modelEffort: "ultra" });
    assert.ok((await problems(dto)).some((m) => /modelEffort/.test(m)));
  });

  it("«minimal» отклоняется: список принимаемого совпадает со списком исполняемого", async () => {
    const dto = plainToInstance(RunSkillDto, { modelEffort: "minimal" });
    assert.ok((await problems(dto)).some((m) => /modelEffort/.test(m)));
  });
});

describe("Порядок маршрутов: «skills» не должен уехать в :name", () => {
  it("skills объявлен выше byName", () => {
    const methods = Object.getOwnPropertyNames(AgentsController.prototype);
    assert.ok(
      methods.indexOf("skills") < methods.indexOf("byName"),
      "иначе GET /agents/skills вернёт «Агент \"skills\" не найден»",
    );
  });
});
