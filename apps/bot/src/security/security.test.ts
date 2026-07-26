import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, it } from "node:test";
import { isAllowed, parseAllowlist, RateLimiter } from "./access";
import { verifyInitData } from "./init-data";

const TOKEN = "123456:TEST-TOKEN-НЕ-НАСТОЯЩИЙ";

/** Собирает валидный initData так же, как это делает Telegram. */
function makeInitData(authDateSeconds: number, extra: Record<string, string> = {}): string {
  const params: Record<string, string> = {
    auth_date: String(authDateSeconds),
    user: JSON.stringify({ id: 777, first_name: "Jamshid" }),
    ...extra,
  };
  const dataCheckString = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join("\n");
  const secret = createHmac("sha256", "WebAppData").update(TOKEN).digest();
  const hash = createHmac("sha256", secret).update(dataCheckString).digest("hex");
  return new URLSearchParams({ ...params, hash }).toString();
}

describe("verifyInitData — закрытие finding Ф9 (валидация auth_date)", () => {
  const now = new Date("2026-07-26T12:00:00Z");
  const nowSec = Math.floor(now.getTime() / 1000);

  it("принимает свежие подписанные данные", () => {
    const res = verifyInitData(makeInitData(nowSec - 60), TOKEN, now);
    assert.equal(res.ok, true);
    if (res.ok) assert.equal(res.userId, 777);
  });

  it("отклоняет данные старше 24 часов — иначе перехваченный initData работал бы вечно", () => {
    const res = verifyInitData(makeInitData(nowSec - 25 * 3600), TOKEN, now);
    assert.equal(res.ok, false);
    if (!res.ok) assert.match(res.reason, /устарел/);
  });

  it("отклоняет подделанную подпись", () => {
    const good = makeInitData(nowSec - 60);
    const tampered = good.replace(/hash=[0-9a-f]+/, "hash=" + "0".repeat(64));
    const res = verifyInitData(tampered, TOKEN, now);
    assert.equal(res.ok, false);
    if (!res.ok) assert.match(res.reason, /подпись/);
  });

  it("отклоняет подмену данных при сохранённой старой подписи", () => {
    const good = makeInitData(nowSec - 60);
    const tampered = good.replace(/user=[^&]+/, encodeURIComponent('{"id":999}'));
    const res = verifyInitData(tampered, TOKEN, now);
    assert.equal(res.ok, false);
  });

  it("отклоняет дату из будущего", () => {
    const res = verifyInitData(makeInitData(nowSec + 3600), TOKEN, now);
    assert.equal(res.ok, false);
    if (!res.ok) assert.match(res.reason, /будущего/);
  });

  it("отклоняет пустой initData и отсутствующий токен", () => {
    assert.equal(verifyInitData("", TOKEN, now).ok, false);
    assert.equal(verifyInitData(makeInitData(nowSec), "", now).ok, false);
  });
});

describe("Белый список чатов", () => {
  it("разбирает список из переменной окружения", () => {
    const list = parseAllowlist(" 111, 222 ,,333 ");
    assert.deepEqual([...list].sort(), [111, 222, 333]);
  });

  it("ЗАКРЫТ по умолчанию: пустой список не пускает никого", () => {
    assert.equal(isAllowed(111, parseAllowlist("")), false);
    assert.equal(isAllowed(111, parseAllowlist(undefined)), false);
  });

  it("пускает только своих", () => {
    const list = parseAllowlist("111,222");
    assert.equal(isAllowed(111, list), true);
    assert.equal(isAllowed(999, list), false);
  });
});

describe("Ограничение частоты", () => {
  it("пропускает до лимита и режет дальше", () => {
    const rl = new RateLimiter(3, 60_000);
    const t = 1_000_000;
    assert.equal(rl.allow(1, t), true);
    assert.equal(rl.allow(1, t + 1), true);
    assert.equal(rl.allow(1, t + 2), true);
    assert.equal(rl.allow(1, t + 3), false, "четвёртый запрос в окне должен быть отклонён");
  });

  it("окно скользит: после истечения снова пускает", () => {
    const rl = new RateLimiter(2, 1_000);
    const t = 1_000_000;
    rl.allow(1, t);
    rl.allow(1, t);
    assert.equal(rl.allow(1, t), false);
    assert.equal(rl.allow(1, t + 1_001), true);
  });

  it("считает чаты раздельно", () => {
    const rl = new RateLimiter(1, 60_000);
    const t = 1_000_000;
    assert.equal(rl.allow(1, t), true);
    assert.equal(rl.allow(2, t), true, "лимит одного чата не должен блокировать другой");
  });
});
