import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_MACHINE_STATUS,
  MACHINE_STATUSES,
  MACHINE_STATUS_LABELS,
  isMachineStatus,
  machineIdleReason,
  machineIsOperational,
  machineStatusLabel,
} from "./machine-status";

describe("состояние автомата", () => {
  it("три состояния, названные владельцем", () => {
    assert.deepEqual([...MACHINE_STATUSES], ["in_service", "warehouse", "repair"]);
  });

  it("у каждого есть русская подпись", () => {
    for (const s of MACHINE_STATUSES) {
      assert.ok(MACHINE_STATUS_LABELS[s]?.length > 0, `нет подписи для ${s}`);
    }
  });

  it("распознаёт своё и отвергает чужое", () => {
    assert.ok(isMachineStatus("repair"));
    assert.ok(!isMachineStatus("сломан"));
    assert.ok(!isMachineStatus(""));
    assert.ok(!isMachineStatus(null));
    assert.ok(!isMachineStatus(undefined));
  });
});

describe("в строю ли автомат", () => {
  it("в эксплуатации — работы имеют смысл", () => {
    assert.ok(machineIsOperational("in_service"));
  });

  it("склад и ремонт — работы не имеют смысла", () => {
    // OFFice стоит на складе, Olma склад в ремонте с 04–05.08.2026.
    assert.ok(!machineIsOperational("warehouse"));
    assert.ok(!machineIsOperational("repair"));
  });

  it("пусто считается рабочим, а не выключенным", () => {
    // Ошибка в сторону «работает» даёт лишнюю задачу, которую человек закроет.
    // Ошибка в другую сторону даёт тишину, которую никто не заметит.
    assert.ok(machineIsOperational(null));
    assert.ok(machineIsOperational(undefined));
    assert.equal(DEFAULT_MACHINE_STATUS, "in_service");
  });

  it("неизвестное значение не выводит автомат из строя молча", () => {
    // Мусор в колонке — повод разбираться, а не повод прекратить обслуживание.
    assert.ok(!machineIsOperational("что-то новое"));
  });
});

describe("причина простоя — текстом", () => {
  it("для рабочего автомата причины нет", () => {
    assert.equal(machineIdleReason("in_service"), null);
    assert.equal(machineIdleReason(null), null);
  });

  it("для склада и ремонта причина называется", () => {
    assert.equal(machineIdleReason("warehouse"), "автомат не в эксплуатации (на складе)");
    assert.equal(machineIdleReason("repair"), "автомат не в эксплуатации (в ремонте)");
  });
});

describe("подпись состояния", () => {
  it("переводит известные", () => {
    assert.equal(machineStatusLabel("warehouse"), "На складе");
    assert.equal(machineStatusLabel("repair"), "В ремонте");
  });

  it("пусто — подпись умолчания, а не пустая строка", () => {
    assert.equal(machineStatusLabel(null), "В эксплуатации");
  });

  it("неизвестное отдаёт как есть — видно, что в базе мусор", () => {
    assert.equal(machineStatusLabel("сломан"), "сломан");
  });
});
