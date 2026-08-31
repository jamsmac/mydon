import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MACHINE_SERIAL_SQL_REGEX,
  machineSerialKeys,
  machineSerialSql,
  normalizeMachineSerial,
  sameMachineSerial,
} from "./machine-serial";

/** Живые значения с прода на 06.08.2026 — не выдуманные примеры. */
const СНЕК_В_РЕЕСТРЕ = ["c2508160359", "c2508160360", "c2508160376"];
const СНЕК_ИЗ_OURVEND = ["2508160355", "2508160358", "2508160359", "2508160360", "2508160376"];
const КОФЕ_В_РЕЕСТРЕ = ["039ec91c0000", "3be8c71e0000", "da0a191f0000", "c7a6181f0000"];

describe("нормализация серийника автомата", () => {
  it("срезает приставку c у серийников Ourvend", () => {
    assert.equal(normalizeMachineSerial("c2508160376"), "2508160376");
    assert.equal(normalizeMachineSerial("C2508160376"), "2508160376");
    assert.equal(normalizeMachineSerial("  c2508160376  "), "2508160376");
  });

  it("голый серийник Ourvend не трогает", () => {
    for (const s of СНЕК_ИЗ_OURVEND) assert.equal(normalizeMachineSerial(s), s);
  });

  it("НЕ трогает коды кофемашин, в том числе начинающийся на c", () => {
    // c7a6181f0000 — живой автомат. Наивный срез приставки сломал бы ему
    // привязку: именно ради этого случая правило требует одних цифр.
    for (const s of КОФЕ_В_РЕЕСТРЕ) assert.equal(normalizeMachineSerial(s), s);
  });

  it("не срезает c у гипотетического 12-значного кода из одних цифр", () => {
    // «c» + 11 цифр — длина кода кофемашины, не серийника Ourvend.
    assert.equal(normalizeMachineSerial("c12345678901"), "c12345678901");
    // «c» + 9 цифр — тоже мимо: правило требует ровно 10.
    assert.equal(normalizeMachineSerial("c123456789"), "c123456789");
  });

  it("пустое и мусорное не ломают", () => {
    assert.equal(normalizeMachineSerial(null), "");
    assert.equal(normalizeMachineSerial(undefined), "");
    assert.equal(normalizeMachineSerial("   "), "");
    assert.equal(normalizeMachineSerial("c"), "c");
  });
});

describe("ключи поиска автомата", () => {
  it("для формы с приставкой даёт обе формы", () => {
    assert.deepEqual(machineSerialKeys("c2508160376"), ["c2508160376", "2508160376"]);
  });

  it("для канонической формы даёт одну", () => {
    assert.deepEqual(machineSerialKeys("2508160376"), ["2508160376"]);
    assert.deepEqual(machineSerialKeys("039ec91c0000"), ["039ec91c0000"]);
  });

  it("пустой external_ref ключей не даёт", () => {
    // Иначе все карточки без внешнего кода склеились бы под ключом "".
    assert.deepEqual(machineSerialKeys(""), []);
    assert.deepEqual(machineSerialKeys(null), []);
    assert.deepEqual(machineSerialKeys("  "), []);
  });

  it("покрывает боевой случай: карточка в реестре ↔ серийник из Ourvend", () => {
    for (const ref of СНЕК_В_РЕЕСТРЕ) {
      const keys = machineSerialKeys(ref);
      const изOurvend = normalizeMachineSerial(ref);
      assert.ok(keys.includes(изOurvend), `${ref} не находится по ${изOurvend}`);
      assert.ok(keys.includes(ref), `${ref} перестал находиться по себе же`);
    }
  });
});

describe("сравнение серийников", () => {
  it("две формы одного автомата равны", () => {
    assert.ok(sameMachineSerial("c2508160376", "2508160376"));
    assert.ok(sameMachineSerial("C2508160376", " 2508160376 "));
  });

  it("разные автоматы не равны", () => {
    assert.ok(!sameMachineSerial("c2508160376", "2508160359"));
    assert.ok(!sameMachineSerial("c7a6181f0000", "7a6181f0000"));
  });

  it("пустое не равно ничему, включая пустое", () => {
    assert.ok(!sameMachineSerial("", ""));
    assert.ok(!sameMachineSerial(null, undefined));
  });
});

describe("SQL-двойник правила", () => {
  it("повторяет регулярку из кода", () => {
    // Правило живёт в двух местах (TS и SQL). Тест держит их в паре: если
    // поменяли длину серийника в одном, здесь станет видно.
    assert.equal(MACHINE_SERIAL_SQL_REGEX, "^c([0-9]{10})$");
  });

  it("собирает выражение по колонке", () => {
    assert.equal(
      machineSerialSql("e.external_ref"),
      "regexp_replace(lower(btrim(coalesce(e.external_ref, ''))), '^c([0-9]{10})$', '\\1')",
    );
  });
});
