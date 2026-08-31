import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HttpException } from "@nestjs/common";
import { person, staffInvite } from "@mydon/db";
import { PgDialect } from "drizzle-orm/pg-core";
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

const PEPPER = "32-байтовая-случайная-строка-перца"; // >= 16 символов

/** Промис, который также умеет .returning() — как построитель update у Drizzle. */
function updateResult(rows: Row[]) {
  return {
    returning: async () => rows,
    then: (resolve: (v: Row[]) => unknown, reject: (e: unknown) => unknown) =>
      Promise.resolve(rows).then(resolve, reject),
  };
}

/**
 * Заглушка Drizzle для redeem(): SELECT staffInvite (…).for("update") → invite,
 * SELECT person → target, UPDATE person → linked, UPDATE staffInvite → returns.
 * Захватывает WHERE финального UPDATE по staffInvite для проверки isNull-guard.
 */
function redeemDb(opts: { invite: Row | null; target?: Row; inviteUpdateReturns?: Row[] }) {
  const captured: { inviteWhere?: unknown; inviteForUpdate?: boolean } = {};
  const linked: Row = { ...(opts.target ?? {}), tgChatId: "chat-new" };

  const rowsFor = (table: unknown): Row[] => {
    if (table === staffInvite) return opts.invite ? [opts.invite] : [];
    if (table === person) return opts.target ? [opts.target] : [];
    return [];
  };

  // Один построитель на select: from() запоминает таблицу, limit()/for() отдают строки.
  const select = () => {
    let table: unknown;
    const chain = {
      from: (t: unknown) => {
        table = t;
        return chain;
      },
      where: () => chain,
      limit: () => chain,
      // Захватываем факт блокировки строки приглашения: FOR UPDATE — первый пояс
      // против гонки. Без этого флага откат .for("update") к простому .limit(1)
      // прошёл бы незамеченным (chain уже thenable через then ниже).
      for: async () => {
        if (table === staffInvite) captured.inviteForUpdate = true;
        return rowsFor(table);
      },
      then: (resolve: (v: Row[]) => unknown, reject: (e: unknown) => unknown) =>
        Promise.resolve(rowsFor(table)).then(resolve, reject),
    };
    return chain;
  };

  const update = (table: unknown) => ({
    set: () => ({
      where: (cond: unknown) => {
        if (table === staffInvite) {
          captured.inviteWhere = cond;
          return updateResult(opts.inviteUpdateReturns ?? [{ id: "inv1" }]);
        }
        return updateResult([linked]);
      },
    }),
  });

  const tx = {
    select,
    update,
    insert: () => ({ values: () => updateResult([{}]) }),
  };

  const db = {
    transaction: async <T>(cb: (t: typeof tx) => Promise<T>): Promise<T> => cb(tx),
  } as never;

  return { db, captured };
}

describe("Гонка гашения одноразового приглашения (P7, аудит 31.08.2026)", () => {
  const future = new Date(Date.now() + 60 * 60 * 1000);
  const activeTarget = () => ({ id: "p1", active: "yes", roles: [], tgChatId: null });
  const liveInvite = () => ({ id: "inv1", personId: "p1", roles: ["manager"], expiresAt: future });

  it("уже погашенное приглашение: SELECT с isNull(usedAt) не находит → отказ", async () => {
    await withPepper(PEPPER, async () => {
      // invite=null моделирует, что FOR UPDATE перечитал строку после коммита
      // конкурента и увидел usedAt — фильтр isNull(usedAt) вернул пусто.
      const { db } = redeemDb({ invite: null });
      const s = new InvitesService(db);
      await assert.rejects(() => s.redeem("код", "chat-new"), /не найдено или уже использовано/);
    });
  });

  it("гонка между SELECT и UPDATE: пустой returning() → отказ той же формулировкой", async () => {
    await withPepper(PEPPER, async () => {
      // Приглашение прошло SELECT (устаревшее чтение), но конкурент погасил его
      // до нашего UPDATE — isNull-guard в WHERE не задел ни одной строки.
      const { db } = redeemDb({
        invite: liveInvite(),
        target: activeTarget(),
        inviteUpdateReturns: [],
      });
      const s = new InvitesService(db);
      await assert.rejects(
        () => s.redeem("код", "chat-new"),
        (err: unknown) => {
          assert.ok(err instanceof HttpException);
          assert.equal(err.getStatus(), 400);
          assert.match((err as Error).message, /не найдено или уже использовано/);
          return true;
        },
      );
    });
  });

  it("SELECT приглашения берёт FOR UPDATE — первый пояс, блокировка строки", async () => {
    await withPepper(PEPPER, async () => {
      // Без .for("update") на SELECT приглашения под READ COMMITTED две
      // параллельные попытки прочитали бы одну живую строку до любого UPDATE.
      // Флаг доказывает, что блокировка строки реально запрошена, а не откачена
      // к простому .limit(1) при рефакторинге.
      const { db, captured } = redeemDb({
        invite: liveInvite(),
        target: activeTarget(),
        inviteUpdateReturns: [{ id: "inv1" }],
      });
      const s = new InvitesService(db);
      await s.redeem("код", "chat-new"); // успешный путь
      assert.equal(
        captured.inviteForUpdate,
        true,
        "SELECT приглашения обязан взять строку под FOR UPDATE",
      );
    });
  });

  it("UPDATE гашения несёт isNull(usedAt)-guard в WHERE (рендер через PgDialect)", async () => {
    await withPepper(PEPPER, async () => {
      const { db, captured } = redeemDb({
        invite: liveInvite(),
        target: activeTarget(),
        inviteUpdateReturns: [{ id: "inv1" }],
      });
      const s = new InvitesService(db);
      await s.redeem("код", "chat-new"); // успешный путь — доходит до UPDATE
      assert.ok(captured.inviteWhere, "финальный UPDATE по staffInvite должен был выполниться");
      const { sql } = new PgDialect().sqlToQuery(captured.inviteWhere as never);
      assert.match(sql, /"used_at" is null/, "гашение обязано фильтровать по isNull(usedAt)");
      assert.match(sql, /"id" = /, "и по конкретному id приглашения");
    });
  });
});
