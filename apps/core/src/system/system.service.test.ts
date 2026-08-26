import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BadRequestException } from "@nestjs/common";
import { event } from "@mydon/db";
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

/**
 * Стенд настроек: `select()` отдаёт текущую карту оверрайдов, `insert`
 * в `system_config` её обновляет, `insert` в `event` копит записанные события.
 * Без живой карты «до/после» проверить смену действующего значения нечем —
 * стаб с пустым списком показал бы одно и то же в обеих точках.
 */
function стендНастроек(настройки: Record<string, string>) {
  const карта: Record<string, string> = { ...настройки };
  const события: { type: string; payload: Record<string, unknown> }[] = [];
  const db = {
    select: () => ({ from: async () => Object.entries(карта).map(([key, value]) => ({ key, value })) }),
    insert: (t: unknown) => ({
      values: (v: { key?: string; value?: string; type?: string; payload?: Record<string, unknown> }) => {
        if (t === event) {
          события.push({ type: String(v.type), payload: v.payload ?? {} });
          return Promise.resolve(undefined);
        }
        return {
          onConflictDoUpdate: async () => {
            карта[String(v.key)] = String(v.value);
          },
        };
      },
    }),
    delete: () => ({
      where: async () => {
        // Сброс тумблера: запись уходит, под ней снова видно env/дефолт.
        for (const k of Object.keys(карта)) delete карта[k];
      },
    }),
  } as never;
  return { svc: new SystemService(db), события, карта };
}

describe("Флип источника учёта пишет событие (R-P8b-3)", () => {
  it("смена stock → own: событие с from/to/actor", async () => {
    const { svc, события } = стендНастроек({ OURVEND_ACCOUNTING_SOURCE: "stock" });
    await svc.set("OURVEND_ACCOUNTING_SOURCE", "own", "owner");
    assert.equal(события.length, 1);
    assert.equal(события[0]!.type, "ourvend.accounting_source_changed");
    assert.deepEqual(события[0]!.payload, { from: "stock", to: "own", actor: "owner" });
  });

  it("запись того же значения событием не считается", async () => {
    const { svc, события } = стендНастроек({ OURVEND_ACCOUNTING_SOURCE: "own" });
    await svc.set("OURVEND_ACCOUNTING_SOURCE", "own", "owner");
    assert.equal(события.length, 0);
  });

  it("сброс тумблера — тоже смена, если под ним лежит другое env", async () => {
    // Сравниваем ДЕЙСТВУЮЩЕЕ значение, а не сырой ввод: пустая строка удаляет
    // запись, и наружу вылезает env — для учёта это такое же переключение.
    const было = process.env.OURVEND_ACCOUNTING_SOURCE;
    process.env.OURVEND_ACCOUNTING_SOURCE = "own";
    try {
      const { svc, события } = стендНастроек({ OURVEND_ACCOUNTING_SOURCE: "stock" });
      await svc.set("OURVEND_ACCOUNTING_SOURCE", "", "owner");
      assert.equal(события.length, 1);
      assert.deepEqual(события[0]!.payload, { from: "stock", to: "own", actor: "owner" });
    } finally {
      if (было === undefined) delete process.env.OURVEND_ACCOUNTING_SOURCE;
      else process.env.OURVEND_ACCOUNTING_SOURCE = было;
    }
  });

  it("actor не указан — null, а не выдуманное имя", async () => {
    const { svc, события } = стендНастроек({ OURVEND_ACCOUNTING_SOURCE: "stock" });
    await svc.set("OURVEND_ACCOUNTING_SOURCE", "own");
    assert.deepEqual(события[0]!.payload, { from: "stock", to: "own", actor: null });
  });

  it("другие тумблеры событий не порождают", async () => {
    const { svc, события } = стендНастроек({});
    await svc.set("DEAD_STOCK_DAYS", "30", "owner");
    assert.equal(события.length, 0);
  });
});
