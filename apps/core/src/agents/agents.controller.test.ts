import "reflect-metadata";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { plainToInstance } from "class-transformer";
import { validate, type ValidationError } from "class-validator";
import { CreateAgentDto, UpdateAgentDto } from "./agents.controller";

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
