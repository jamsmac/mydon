import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AttachmentsService } from "./attachments.service";

/** Мок хранилища: ссылку строим предсказуемо, чтобы проверять раскладку. */
const storage = { url: async (id: string) => `/attachments/${id}/raw` } as never;

/** Мок db.select().from().where().orderBy() → заданные строки. */
function dbReturning(rows: Record<string, unknown>[]) {
  return {
    select: () => ({
      from: () => ({
        where: () => ({ orderBy: async () => rows }),
      }),
    }),
  } as never;
}

const row = (id: string, ownerId: string, kind = "photo") => ({
  id,
  ownerType: "entity",
  ownerId,
  kind,
  storageKey: `k/${id}`,
  mime: "image/jpeg",
  bytes: 100,
  createdBy: "staff",
  createdAt: new Date("2026-08-01T00:00:00Z"),
});

describe("Вложения многих записей одним запросом", () => {
  it("пустой набор — не ходит в базу, отдаёт пустую карту", async () => {
    let queried = false;
    const db = {
      select: () => {
        queried = true;
        return { from: () => ({ where: () => ({ orderBy: async () => [] }) }) };
      },
    } as never;
    const s = new AttachmentsService(db, storage);
    const res = await s.ofOwners("entity", []);
    assert.deepEqual(res, {});
    assert.equal(queried, false, "по пустому набору запрос делать незачем");
  });

  it("раскладывает вложения по владельцам", async () => {
    const s = new AttachmentsService(
      dbReturning([row("a1", "e1"), row("a2", "e1"), row("a3", "e2")]),
      storage,
    );
    const res = await s.ofOwners("entity", ["e1", "e2"]);
    assert.equal(res.e1.length, 2);
    assert.equal(res.e2.length, 1);
    assert.equal(res.e1[0].url, "/attachments/a1/raw");
  });

  it("владелец без вложений просто отсутствует в карте", async () => {
    const s = new AttachmentsService(dbReturning([row("a1", "e1")]), storage);
    const res = await s.ofOwners("entity", ["e1", "e2"]);
    assert.deepEqual(Object.keys(res), ["e1"]);
    assert.equal(res.e2, undefined);
  });
});
