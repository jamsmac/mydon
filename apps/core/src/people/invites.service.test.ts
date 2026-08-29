import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HttpException } from "@nestjs/common";
import { InvitesService } from "./invites.service";

type Row = Record<string, unknown>;

/** Заглушка БД, которая падает при первом же обращении — доказывает, что guard сработал ДО транзакции. */
const untouchable = {
  transaction: async () => {
    throw new Error("БД не должна была вызываться — guard обязан отказать раньше");
  },
} as never;

function stubDb(target: Row, created: Row) {
  const tx = {
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [target] }) }) }),
    update: () => ({ set: () => ({ where: async () => [] }) }),
    insert: () => ({ values: () => ({ returning: async () => [created] }) }),
  };
  return {
    transaction: async <T>(cb: (t: typeof tx) => Promise<T>): Promise<T> => cb(tx),
  } as never;
}

/** Пепper читается один раз в конструкторе — сохраняем/восстанавливаем env вокруг каждого сценария. */
async function withPepper<T>(value: string | undefined, fn: () => T | Promise<T>): Promise<T> {
  const prev = process.env.INVITE_PEPPER;
  if (value === undefined) delete process.env.INVITE_PEPPER;
  else process.env.INVITE_PEPPER = value;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.INVITE_PEPPER;
    else process.env.INVITE_PEPPER = prev;
  }
}

describe("Fail closed без надёжного INVITE_PEPPER (P0 #2, аудит 27.08.2026)", () => {
  it("issue() отказывает 503, если перец не задан вовсе", async () => {
    await withPepper(undefined, async () => {
      const s = new InvitesService(untouchable);
      await assert.rejects(
        () => s.issue("p1", ["manager"]),
        (err: unknown) => {
          assert.match((err as Error).message, /INVITE_PEPPER не настроен/);
          assert.ok(err instanceof HttpException);
          assert.equal(err.getStatus(), 503);
          return true;
        },
      );
    });
  });

  it("issue() отказывает 503, если перец короче 16 символов", async () => {
    await withPepper("короткий", async () => {
      const s = new InvitesService(untouchable);
      await assert.rejects(() => s.issue("p1", ["manager"]), /INVITE_PEPPER не настроен/);
    });
  });

  it("redeem() отказывает тем же способом при слабом перце", async () => {
    await withPepper("", async () => {
      const s = new InvitesService(untouchable);
      await assert.rejects(() => s.redeem("любой-код", "chat1"), /INVITE_PEPPER не настроен/);
    });
  });

  it("ровно 16 символов — граница проходит (не отказывает)", async () => {
    await withPepper("0123456789abcdef", async () => {
      const target = { id: "p1", active: "yes" };
      const created = { id: "inv1", codeHash: "x" };
      const s = new InvitesService(stubDb(target, created));
      const result = await s.issue("p1", ["manager"]);
      assert.ok(result.code, "с валидным перцем issue() доходит до записи и возвращает код");
    });
  });

  it("issue() c надёжным перцем не трогает guard-заглушку и работает как раньше", async () => {
    await withPepper("32-байтовая-случайная-строка-перца", async () => {
      const target = { id: "p1", active: "yes" };
      const created = { id: "inv1", codeHash: "x" };
      const s = new InvitesService(stubDb(target, created));
      const { code, expiresAt, person } = await s.issue("p1", ["manager"]);
      assert.ok(code.length > 0);
      assert.ok(expiresAt instanceof Date);
      assert.equal(person.id, "p1");
    });
  });
});
