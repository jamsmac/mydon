import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifyTool, toolTierFloor } from "./tools";

describe("classifyTool", () => {
  it("чтение → read", () => {
    assert.equal(classifyTool("read_kb"), "read");
    assert.equal(classifyTool("read_db"), "read");
  });
  it("веб и исходящие уведомления → net (сеть рискованнее локального чтения)", () => {
    assert.equal(classifyTool("read_web"), "net"); // веб-запрос — это сеть, не локальное чтение
    assert.equal(classifyTool("web_fetch"), "net");
    assert.equal(classifyTool("send_telegram"), "net");
    assert.equal(classifyTool("notify_owner"), "net");
  });
  it("запись → write", () => {
    assert.equal(classifyTool("write_task"), "write");
    assert.equal(classifyTool("create_entity"), "write");
  });
  it("исполнение команды → exec", () => {
    assert.equal(classifyTool("exec:check_inventory"), "exec");
    assert.equal(classifyTool("run_script"), "exec");
  });
  it("деньги и договор → money/contract", () => {
    assert.equal(classifyTool("send_payment"), "money");
    assert.equal(classifyTool("create_contract"), "contract"); // договор строже записи
  });
  it("неизвестное → net (консервативно, не read)", () => {
    assert.equal(classifyTool("нечто_странное"), "net");
  });
});

describe("toolTierFloor — строжайший инструмент задаёт пол", () => {
  it("пусто → T0", () => {
    assert.equal(toolTierFloor([]), "T0");
  });
  it("только чтение → T0", () => {
    assert.equal(toolTierFloor(["read_kb", "read_db"]), "T0");
  });
  it("чтение + запись → T2", () => {
    assert.equal(toolTierFloor(["read_db", "write_task"]), "T2");
  });
  it("exec поднимает до T3", () => {
    assert.equal(toolTierFloor(["read_kb", "read_db", "exec:check_inventory", "write_task"]), "T3");
  });
  it("исходящее уведомление держит T1, не выше", () => {
    assert.equal(toolTierFloor(["read_db", "read_kb", "send_telegram"]), "T1");
  });
  it("договор → T4", () => {
    assert.equal(toolTierFloor(["read_db", "create_contract"]), "T4");
  });
});
