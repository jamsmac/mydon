import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  RAW_SOURCES,
  findRawReport,
  normalizeSourceKey,
  rawFreshness,
  roleColumnIndex,
} from "./sources";

describe("Справочник источников VendHub", () => {
  it("коды систем и отчётов не повторяются: по ним связаны выгрузки", () => {
    const codes = RAW_SOURCES.map((s) => s.code);
    assert.equal(new Set(codes).size, codes.length, "повтор кода системы");
    for (const s of RAW_SOURCES) {
      const rc = s.reports.map((r) => r.code);
      assert.equal(new Set(rc).size, rc.length, `повтор кода отчёта в ${s.code}`);
    }
  });

  it("у каждого отчёта сказано по-русски, что это и где нажать", () => {
    for (const s of RAW_SOURCES) {
      for (const r of s.reports) {
        assert.ok(r.ru.length > 0, `${s.code}/${r.code}: нет русского названия`);
        assert.ok(r.path.length > 0, `${s.code}/${r.code}: не сказано, где взять`);
      }
    }
  });

  it("чужой источник не находится — принимать от него выгрузку нельзя", () => {
    assert.equal(findRawReport("gjvending", "order_query")?.title, "Order Query");
    assert.equal(findRawReport("gjvending", "нет_такого"), undefined);
    assert.equal(findRawReport("нет_такой_системы", "order_query"), undefined);
  });
});

describe("Нормализация значений источника", () => {
  it("регистр, лишние пробелы и «ё» не делают из одного товара два", () => {
    assert.equal(normalizeSourceKey("  Ice Lemon   Tea "), "ice lemon tea");
    assert.equal(normalizeSourceKey("Кофе Чёрный"), "кофе черный");
    assert.equal(normalizeSourceKey("6620191F0000"), "6620191f0000");
  });

  it("знаки и цифры сохраняются: это смысл, а не мусор", () => {
    assert.equal(normalizeSourceKey("Red Bull CAN 0,33"), "red bull can 0,33");
    assert.equal(normalizeSourceKey("MacCoffee 3in1"), "maccoffee 3in1");
  });
});

describe("Роли колонок: связь выгрузки с карточками реестра", () => {
  const columns = ["Order number", "Goods name", "Machine Code", "Address"];
  const roles = { machine: "Machine Code", product: "Goods name", point: "Address" };

  it("колонка находится по названию, а не по номеру", () => {
    assert.equal(roleColumnIndex(columns, roles, "machine"), 2);
    assert.equal(roleColumnIndex(columns, roles, "product"), 1);
  });

  it("перестановка колонок источником ничего не ломает", () => {
    const moved = ["Machine Code", "Address", "Order number", "Goods name"];
    assert.equal(roleColumnIndex(moved, roles, "machine"), 0);
    assert.equal(roleColumnIndex(moved, roles, "product"), 3);
  });

  it("нет колонки — −1, а не соседняя наугад", () => {
    assert.equal(roleColumnIndex(["Order number"], roles, "machine"), -1);
    assert.equal(roleColumnIndex(columns, roles, "amount"), -1, "роль не описана");
    assert.equal(roleColumnIndex(columns, undefined, "machine"), -1, "ролей нет вовсе");
  });
});

describe("Свежесть выгрузки", () => {
  const now = new Date("2026-07-30T22:00:00+05:00");

  it("выгрузок не было — это «никогда», а не «ноль»", () => {
    assert.equal(rawFreshness(null, now), "never");
    assert.equal(rawFreshness(undefined, now), "never");
    assert.equal(rawFreshness("не дата", now), "never");
  });

  it("свежая и устаревшая выгрузки различаются", () => {
    assert.equal(rawFreshness("2026-07-30T10:00:00+05:00", now), "fresh");
    assert.equal(rawFreshness("2026-07-01T10:00:00+05:00", now), "stale");
  });

  it("граница порога считается свежей", () => {
    assert.equal(rawFreshness("2026-07-23T22:00:00+05:00", now, 7), "fresh");
    assert.equal(rawFreshness("2026-07-23T21:00:00+05:00", now, 7), "stale");
  });
});
