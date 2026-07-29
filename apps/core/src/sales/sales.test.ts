import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildUpserts, todayLocal, type StockSaleRow } from "./sales.service";

describe("Продажи: подготовка строк из mydon-stock", () => {
  const map = new Map([["72ac181f0000", "ent-1"]]);

  it("серийник узнан → строка привязана к автомату реестра", () => {
    const rows: StockSaleRow[] = [
      { dt: "2026-07-28", machine_serial: "72AC181F0000", ourvend_name: "Americano", qty: 3, amount: 60000, fetched_at: "2026-07-29T07:50:03+05:00" },
    ];
    const [v] = buildUpserts(rows, map);
    assert.equal(v.machineId, "ent-1", "регистр серийника не должен мешать сопоставлению");
    assert.equal(v.machineSerial, "72ac181f0000");
    assert.equal(v.qty, "3");
    assert.equal(v.amount, "60000");
  });

  it("неизвестный серийник → строка сохраняется без привязки, не теряется", () => {
    const rows: StockSaleRow[] = [
      { dt: "2026-07-28", machine_serial: "C2508160376", ourvend_name: "Вода 330ml", qty: 1, amount: 3000, fetched_at: new Date() },
    ];
    const [v] = buildUpserts(rows, map);
    assert.equal(v.machineId, null);
    assert.equal(v.machineSerial, "c2508160376");
  });

  it("битые строки (пустой серийник или товар) отбрасываются", () => {
    const rows = [
      { dt: "2026-07-28", machine_serial: "", ourvend_name: "X", qty: 1, amount: 1, fetched_at: new Date() },
      { dt: "", machine_serial: "abc", ourvend_name: "X", qty: 1, amount: 1, fetched_at: new Date() },
    ] as StockSaleRow[];
    assert.equal(buildUpserts(rows, map).length, 0);
  });

  it("todayLocal отдаёт дату YYYY-MM-DD по локальному времени контейнера", () => {
    const d = new Date(2026, 6, 29, 23, 59); // 29 июля, поздний вечер
    assert.equal(todayLocal(d), "2026-07-29");
  });
});
