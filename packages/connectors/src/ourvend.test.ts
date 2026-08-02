import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { describe, it } from "node:test";
import {
  AuthError,
  OurvendConnector,
  ShapeError,
  buildPem,
  coerceNum,
  ourvendDate,
  ourvendDateTime,
  parseMachineSales,
  parseMachines,
  parseProductSales,
  parseSlots,
  sumProductSales,
  type FetchLike,
} from "./ourvend";

// ── Чистые парсеры на фикстурах Приложения В ─────────────────────────────────

describe("Ourvend: приведение строковых чисел (§3.2)", () => {
  it("«6» → 6, «48000.00» → 48000, мусор → 0", () => {
    assert.equal(coerceNum("6"), 6);
    assert.equal(coerceNum("48000.00"), 48000);
    assert.equal(coerceNum(5), 5);
    assert.equal(coerceNum("abc"), 0);
    assert.equal(coerceNum(null), 0);
  });
});

describe("Ourvend: PEM из голого base64 (§3.1)", () => {
  it("оборачивает в BEGIN/END и режет по 64 символа", () => {
    const pem = buildPem("A".repeat(200));
    assert.match(pem, /^-----BEGIN PUBLIC KEY-----\n/);
    assert.match(pem, /\n-----END PUBLIC KEY-----$/);
    const lines = pem.split("\n").slice(1, -1);
    assert.ok(lines.every((l) => l.length <= 64));
    assert.equal(lines.join(""), "A".repeat(200));
  });
});

describe("Ourvend: список автоматов (§3.2.1)", () => {
  it("берёт MuMachineID, alias = имя или serial", () => {
    const m = parseMachines([
      { MuMachineID: "2508160355", MiAlias: "2508160355" },
      { MuMachineID: "2508160359", MiAlias: "American Hospital" },
      { MuMachineID: "2508160376", MiAlias: "Olma Администрация" },
    ]);
    assert.equal(m.length, 3);
    assert.deepEqual(m[1], { serial: "2508160359", alias: "American Hospital" });
  });
  it("нет ни одного MuMachineID → ShapeError (сбор не удался)", () => {
    assert.throws(() => parseMachines([{ foo: 1 }]), ShapeError);
    assert.throws(() => parseMachines("nope"), ShapeError);
  });
});

describe("Ourvend: слоты (§3.2.2) — данные во втором элементе", () => {
  const fixture = [
    [],
    [
      { SiCoilId: "31", PrName: "Montella Вода минеральная 330ml", SiCapacity: "6", SiExtantQuantity: "0" },
      { SiCoilId: "34", PrName: "CocaCola Classic CAN 250ml", SiCapacity: "6", SiExtantQuantity: "1" },
      { SiCoilId: "59", PrName: "Fanta Classic CAN 250ml", SiCapacity: "0", SiExtantQuantity: "0" },
    ],
  ];
  it("разбирает response[1], числа приводит из строк", () => {
    const slots = parseSlots(fixture);
    assert.equal(slots.length, 3);
    assert.deepEqual(slots[0], { coilId: "31", product: "Montella Вода минеральная 330ml", capacity: 6, quantity: 0 });
    assert.equal(slots[2].capacity, 0); // слот 59 — вместимость 0 (невалиден дальше)
  });
  it("иная структура → [] (не падаем): автомат без планограммы", () => {
    assert.deepEqual(parseSlots([]), []);
    assert.deepEqual(parseSlots([[{ CabinetNo: "0" }]]), []); // нет второго элемента
    assert.deepEqual(parseSlots("nope"), []);
  });
});

describe("Ourvend: продажи по товарам (§3.2.3) — суммировать по имени", () => {
  it("возвращает сырые строки, sumProductSales складывает дубли", () => {
    const rows = parseProductSales({
      rows: [
        { PrName: "Montella Вода минеральная 330ml", SaleNum: 34 },
        { PrName: "Montella Вода минеральная 330ml", SaleNum: 2 },
      ],
    });
    assert.equal(rows.length, 2); // сырые строки не схлопнуты
    const sum = sumProductSales(rows);
    assert.equal(sum.get("Montella Вода минеральная 330ml"), 36); // 34 + 2, а не 2
  });
});

describe("Ourvend: продажи по автоматам (§3.2.4)", () => {
  it("TotalAmount строкой приводится к числу", () => {
    const s = parseMachineSales({ rows: [{ MachineID: "2508160359", TotalAmount: "48000.00", TotalCount: 5 }] });
    assert.deepEqual(s[0], { serial: "2508160359", totalAmount: 48000, totalCount: 5 });
  });
});

describe("Ourvend: даты в ташкентском времени (§3.3)", () => {
  it("UTC-момент сдвигается на +5", () => {
    const d = new Date("2026-08-02T20:00:00Z"); // 01:00 следующего дня в Ташкенте
    assert.equal(ourvendDate(d), "2026-08-03");
    assert.equal(ourvendDateTime(d), "2026-08-03 01:00:00");
  });
});

// ── Логин-флоу с фейковым fetch (без сети) ──────────────────────────────────

/** Фейковый ответ. */
function resp(body: string, status = 200, setCookie?: string): Response {
  const headers = new Headers();
  if (setCookie) headers.set("set-cookie", setCookie);
  return new Response(body, { status, headers });
}

/** «Голый» base64 публичного RSA-ключа (SPKI DER), как отдаёт GetPubKey. */
function testPubKey(): string {
  const { publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "der" },
    privateKeyEncoding: { type: "pkcs8", format: "der" },
  });
  return (publicKey as Buffer).toString("base64");
}

describe("Ourvend: логин (§3.1) и куки сессии", () => {
  it("GetPubKey → шифрует пароль → Login «ok», куки переносятся", async () => {
    const calls: { path: string; cookie: string | undefined; body: string }[] = [];
    // Настоящий RSA-ключ (2048) в base64 без PEM — чтобы encryptPassword отработал.
    const publicKey = testPubKey();

    const fetchImpl: FetchLike = async (url, init) => {
      const path = url.replace(/^https?:\/\/[^/]+/, "");
      calls.push({ path, cookie: (init.headers as Record<string, string>)?.Cookie, body: String(init.body ?? "") });
      if (path === "/Account/GetPubKey") return resp(publicKey, 200, "ASP.NET_SessionId=abc123; path=/");
      if (path === "/Account/Login") return resp("ok", 200);
      return resp("", 404);
    };

    const conn = new OurvendConnector({ account: "Vendhub", password: "secret", fetchImpl, retryBaseMs: 0 });
    await conn.login(); // не бросает — успех

    assert.equal(calls[0].path, "/Account/GetPubKey");
    assert.equal(calls[1].path, "/Account/Login");
    // Кука, выданная GetPubKey, ушла в Login.
    assert.match(calls[1].cookie ?? "", /ASP\.NET_SessionId=abc123/);
    // Пароль в теле — зашифрован (не открытым текстом).
    assert.ok(!calls[1].body.includes("secret"));
    assert.match(calls[1].body, /userAccount=Vendhub/);
  });

  it("ответ не начинается с «ok» → AuthError с телом причины", async () => {
    const publicKey = testPubKey();
    const fetchImpl: FetchLike = async (url) => {
      const path = url.replace(/^https?:\/\/[^/]+/, "");
      if (path === "/Account/GetPubKey") return resp(publicKey);
      return resp("error: account locked", 200);
    };
    const conn = new OurvendConnector({ account: "x", password: "y", fetchImpl, retryBaseMs: 0 });
    await assert.rejects(() => conn.login(), (e) => e instanceof AuthError && /account locked/.test(e.detail ?? ""));
  });
});
