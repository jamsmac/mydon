import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  RAW_SOURCES,
  decodeRawValue,
  findRawReport,
  normalizeSourceKey,
  rawFreshness,
  roleColumnIndex,
  roleColumnName,
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

describe("Один отчёт — два словаря колонок", () => {
  // Панель отдаёт «Machine Code» при выгрузке файлом и `machine_code`
  // через /api/order/list. Это один отчёт, а не два разных.
  const roles = findRawReport("gjvending", "order_query")?.roles;

  it("колонка узнаётся и в выгрузке файлом, и в ответе API", () => {
    const asFile = ["Order number", "Goods name", "Machine Code"];
    const asApi = ["order_no", "operate_goods_name", "machine_code"];
    assert.equal(roleColumnIndex(asFile, roles, "machine"), 2);
    assert.equal(roleColumnIndex(asApi, roles, "machine"), 2);
    assert.equal(roleColumnIndex(asFile, roles, "product"), 1);
    assert.equal(roleColumnIndex(asApi, roles, "product"), 1);
  });

  it("владельцу показывается первое название — то, что он видит в панели", () => {
    assert.equal(roleColumnName(roles, "machine"), "Machine Code");
    assert.equal(roleColumnName(roles, "product"), "Goods name");
    assert.equal(roleColumnName(roles, "amount"), "Order price");
    assert.equal(roleColumnName(undefined, "machine"), null);
  });
});

describe("Расшифровка кодов источника", () => {
  const dict = findRawReport("gjvending", "order_query")?.dicts?.find((d) => d.role === "payment");

  it("известный код переводится", () => {
    assert.deepEqual(decodeRawValue(dict, "cash"), { label: "наличные", confirmed: true });
    assert.deepEqual(decodeRawValue(dict, "vip"), { label: "VIP-карта", confirmed: true });
  });

  it("userDefined помечен как неподтверждённый: на нём 181 млн сум", () => {
    const d = decodeRawValue(dict, "userDefined");
    assert.equal(d?.confirmed, false, "догадка не должна выдаваться за факт");
  });

  it("расшифровка передаёт слово источника, а не наше толкование", () => {
    // Панель называет этот код «Таможенный платеж». Название явно не про
    // вендинг, но справочник расшифровок — такое же сырьё, как и строки:
    // подменять его своей догадкой нельзя. Чем канал окажется на деле
    // (Payme, Click, Uzum, списание бонусов), покажет сверка с этими
    // системами. До неё — код источника плюс пометка «не подтверждено».
    assert.equal(decodeRawValue(dict, "userDefined")?.label, "Таможенный платеж");
  });

  it("незнакомый код не переводится наугад", () => {
    assert.equal(decodeRawValue(dict, "неведомое"), null);
    assert.equal(decodeRawValue(undefined, "cash"), null);
  });

  it("статус выдачи расшифрован по кодам панели", () => {
    const brew = findRawReport("gjvending", "order_query")?.dicts?.find((d) => d.role === "fulfilment");
    assert.equal(decodeRawValue(brew, "2")?.label, "доставлен");
    assert.equal(decodeRawValue(brew, "11")?.label, "сбой доставки");
  });
});
