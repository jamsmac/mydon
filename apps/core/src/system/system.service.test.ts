import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BadRequestException } from "@nestjs/common";
import { SystemService } from "./system.service";

/** Стаб БД: select() отдаёт пустой список оверрайдов, insert/delete — no-op. */
function stubDb(rows: { key: string; value: string }[] = []) {
  return {
    select: () => ({ from: async () => rows }),
    insert: () => ({
      values: () => ({ onConflictDoUpdate: async () => undefined }),
    }),
    delete: () => ({ where: async () => undefined }),
  } as never;
}

describe("SystemService.set(): валидация тумблеров (§ config-spec)", () => {
  it("неизвестный ключ — BadRequestException (400), не голый Error (найдено внешним аудитом, P2)", async () => {
    const svc = new SystemService(stubDb());
    await assert.rejects(
      () => svc.set("НЕСУЩЕСТВУЮЩИЙ_КЛЮЧ", "x"),
      (err: unknown) => {
        assert.ok(err instanceof BadRequestException, "должен быть BadRequestException, а не обычный Error");
        return true;
      },
    );
  });

  it("невалидное значение для известного ключа — тоже BadRequestException", async () => {
    const svc = new SystemService(stubDb());
    await assert.rejects(
      () => svc.set("AGENT_AUTONOMY_MAX", "T99"),
      (err: unknown) => err instanceof BadRequestException,
    );
  });

  it("валидное значение — проходит, возвращает действующие тумблеры", async () => {
    const svc = new SystemService(stubDb());
    const result = await svc.set("AGENT_AUTONOMY_MAX", "T1", "owner");
    assert.ok(Array.isArray(result));
    assert.ok(result.some((r) => r.key === "AGENT_AUTONOMY_MAX"));
  });
});
