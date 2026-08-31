import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { Request } from "express";
import type { Db } from "../db/db.module";
import type { ActionsService } from "./actions.service";
import { RegistryController } from "./registry.controller";
import type { RegistryService } from "./registry.service";

/**
 * Контроллер реестра обязан ПРОБРАСЫВАТЬ единый гейт видимости в кросс-доменные
 * сводки (briefing/overview/actions). Проверяем именно проводку: какое значение
 * excludePersonal доезжает до сервиса в трёх состояниях флага/личности. Сама
 * SQL-фильтрация — на предикатах сервисов; здесь фиксируем, что эндпоинт не
 * теряет гейт и не путает направление (owner видит своё, бот — нет).
 */

/** Мини-заглушка Db: settingValue делает ровно select().from(systemConfig). */
function fakeDb(rows: { key: string; value: string }[] = []): Db {
  return { select: () => ({ from: () => Promise.resolve(rows) }) } as unknown as Db;
}

function req(headers: Record<string, string> = {}): Request {
  return { headers } as unknown as Request;
}

const KEY = "OWNER_IDENTITY_ENFORCED";

describe("RegistryController — проводка гейта personal", () => {
  const prevOwner = process.env.OWNER_ACTION_TOKEN;
  const prevService = process.env.SERVICE_TOKEN;
  const prevEnforced = process.env.OWNER_IDENTITY_ENFORCED;

  let seen: { briefing?: boolean; overview?: boolean; actions?: boolean };
  let controller: RegistryController;

  function build(dbRows: { key: string; value: string }[]): RegistryController {
    seen = {};
    const registry = {
      briefing: (_now: Date, excludePersonal: boolean) => {
        seen.briefing = excludePersonal;
        return Promise.resolve({});
      },
      overview: (excludePersonal: boolean) => {
        seen.overview = excludePersonal;
        return Promise.resolve([]);
      },
    } as unknown as RegistryService;
    const actionsFeed = {
      actions: (_f: string, _t: string, _p: string | undefined, excludePersonal: boolean) => {
        seen.actions = excludePersonal;
        return Promise.resolve([]);
      },
    } as unknown as ActionsService;
    return new RegistryController(registry, actionsFeed, fakeDb(dbRows));
  }

  beforeEach(() => {
    process.env.SERVICE_TOKEN = "shared";
    process.env.OWNER_ACTION_TOKEN = "owner-secret";
  });
  afterEach(() => {
    for (const [k, v] of [
      ["OWNER_ACTION_TOKEN", prevOwner],
      ["SERVICE_TOKEN", prevService],
      ["OWNER_IDENTITY_ENFORCED", prevEnforced],
    ] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  const ownerReq = () => req({ "x-owner-action-token": "owner-secret" });
  const botReq = () => req({ "x-service-token": "shared" });
  const DAY = "2026-01-01";

  async function callAll(c: RegistryController, r: Request): Promise<void> {
    await c.briefing(r);
    await c.overview(r);
    await c.actions(r, DAY, DAY, undefined);
  }

  it("флаг ВЫКЛ → excludePersonal=false во все сводки (поведение прода)", async () => {
    delete process.env.OWNER_IDENTITY_ENFORCED;
    controller = build([]);
    await callAll(controller, botReq());
    assert.deepEqual(seen, { briefing: false, overview: false, actions: false });
    // Даже owner при выключенном флаге ничего не меняет.
    await callAll(controller, ownerReq());
    assert.deepEqual(seen, { briefing: false, overview: false, actions: false });
  });

  it("флаг ВКЛ + owner-токен → excludePersonal=false (владелец видит personal)", async () => {
    controller = build([{ key: KEY, value: "1" }]);
    await callAll(controller, ownerReq());
    assert.deepEqual(seen, { briefing: false, overview: false, actions: false });
  });

  it("флаг ВКЛ + не-owner → excludePersonal=true (personal вырезан)", async () => {
    controller = build([{ key: KEY, value: "1" }]);
    await callAll(controller, botReq());
    assert.deepEqual(seen, { briefing: true, overview: true, actions: true });
  });
});
