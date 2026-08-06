import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { TelegramError } from "./telegram";

/**
 * Разбор отказов Bot API.
 *
 * Раньше 403, 429 и 500 схлопывались в безымянный Error. Разница между ними —
 * это разница между потерянным напоминанием и доставленным, поэтому каждый
 * случай проверяется отдельно.
 */
describe("Отказ Telegram", () => {
  it("403 «заблокировал бота» — недоступен навсегда", () => {
    const e = new TelegramError("sendMessage", 403, "Forbidden: bot was blocked by the user");
    assert.equal(e.isUnreachable, true);
    assert.equal(e.isRateLimited, false);
  });

  it("403 «удалил аккаунт» и «выгнали из чата» — тоже недоступен", () => {
    assert.equal(
      new TelegramError("sendMessage", 403, "Forbidden: user is deactivated").isUnreachable,
      true,
    );
    assert.equal(
      new TelegramError("sendMessage", 403, "Forbidden: bot was kicked from the group chat").isUnreachable,
      true,
    );
  });

  it("403 по другой причине недоступностью не считается", () => {
    // Иначе временный отказ навсегда пометил бы человека «не пишет боту».
    const e = new TelegramError("sendMessage", 403, "Forbidden: не разобрали причину");
    assert.equal(e.isUnreachable, false);
  });

  it("400 «chat not found» не выдаёт себя за 403", () => {
    // Проверка привязана к коду, а не только к тексту: иначе любой 400
    // с похожей формулировкой гасил бы доставку человеку.
    assert.equal(new TelegramError("sendMessage", 400, "Bad Request: chat not found").isUnreachable, false);
  });

  it("429 несёт retry_after и не считается недоступностью", () => {
    const e = new TelegramError("sendMessage", 429, "Too Many Requests", 7);
    assert.equal(e.isRateLimited, true);
    assert.equal(e.isUnreachable, false);
    assert.equal(e.retryAfter, 7);
  });

  it("500 — обычный сбой, повторять можно", () => {
    const e = new TelegramError("sendMessage", 500, "Internal Server Error");
    assert.equal(e.isUnreachable, false);
    assert.equal(e.isRateLimited, false);
  });

  it("сообщение остаётся читаемым в логе", () => {
    const e = new TelegramError("editMessageText", 400, "message is not modified");
    assert.match(e.message, /editMessageText/);
    assert.match(e.message, /not modified/);
    assert.equal(e.name, "TelegramError");
  });
});
