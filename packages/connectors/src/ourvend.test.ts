import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { describe, it } from "node:test";
import {
  AuthError,
  OurvendConnector,
  ShapeError,
  buildPem,
  coerceNum,
  dedupLotAgg,
  ourvendDate,
  ourvendDateTime,
  parseAccountingSales,
  parseLotPage,
  parseMachineSales,
  parseMachines,
  parseProductSales,
  parseSlots,
  sumProductSales,
  type FetchLike,
  type RawLotRow,
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

describe("Несуществующие слоты вендора", () => {
  const слот = (over: Record<string, unknown> = {}) => ({
    SiCoilId: "1",
    SiWorkStatus: "1",
    SiCapacity: "5",
    SiExtantQuantity: "3",
    PrName: "Snickers 50gr",
    ...over,
  });

  it("строка со статусом 255 — не слот, а незаполненная память", () => {
    // Сигнатура вендора: 255 = 0xFF, цена 6553.5 = 65535/10 = 0xFFFF.
    // У 2508160376 таких строк приходило 445 из 488.
    const json = [
      [],
      [
        слот({ SiCoilId: "1" }),
        слот({ SiCoilId: "68", SiWorkStatus: "255", SiCapacity: "0", SiExtantQuantity: "0", PrName: "" }),
        слот({ SiCoilId: "69", SiWorkStatus: "255", SiCapacity: "0", SiExtantQuantity: "0", PrName: "" }),
      ],
    ];
    const out = parseSlots(json);
    assert.equal(out.length, 1);
    assert.equal(out[0]!.coilId, "1");
  });

  it("остаточное имя товара не делает фантом живым", () => {
    // Слот 59 на обеих машинах: status=255, но имя товара осталось от прошлой
    // раскладки. Продать из него нечего — ёмкость и остаток нулевые.
    const json = [
      [],
      [слот({ SiCoilId: "59", SiWorkStatus: "255", SiCapacity: "0", SiExtantQuantity: "0", PrName: "Fanta Classic CAN 250ml" })],
    ];
    assert.deepEqual(parseSlots(json), []);
  });

  it("нулевая ёмкость при живом статусе — настоящий слот, не выбрасываем", () => {
    // У 2508160360 все 43 строки со статусом 1; отсев по ёмкости выкинул бы
    // живые позиции, которым просто не задали объём.
    const json = [[], [слот({ SiCoilId: "7", SiWorkStatus: "1", SiCapacity: "0", SiExtantQuantity: "0", PrName: "" })]];
    const out = parseSlots(json);
    assert.equal(out.length, 1);
    assert.equal(out[0]!.capacity, 0);
  });

  it("прочие статусы остаются: 4 — это рабочий слот", () => {
    const json = [[], [слот({ SiCoilId: "12", SiWorkStatus: "4" })]];
    assert.equal(parseSlots(json).length, 1);
  });

  it("отсутствие статуса ничего не ломает", () => {
    const json = [[], [{ SiCoilId: "3", SiCapacity: "5", SiExtantQuantity: "1", PrName: "Twix" }]];
    assert.equal(parseSlots(json).length, 1);
  });
});

// ── Учётный контур (П2 поглощения mydon-stock) ───────────────────────────────

describe("parseAccountingSales: учётный отчёт SaleSummarize", () => {
  it("итоговая строка и строки без кода товара отбрасываются", () => {
    const json = {
      records: 3,
      rows: [
        { ProductName: "Fanta 0.5", PrCode: "F05", colum2: "12", colum1: "144000.00" },
        { ProductName: "合计", PrCode: "", colum2: "12", colum1: "144000.00" },
        { ProductName: "Без кода", PrCode: "", colum2: "1", colum1: "1000" },
      ],
    };
    const { rows, records, taken } = parseAccountingSales(json);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].product, "Fanta 0.5");
    assert.equal(rows[0].qty, 12, "строковое colum2 приводится к целому");
    assert.equal(rows[0].amount, 144000);
    assert.equal(records, 3);
    assert.equal(taken, 3);
  });

  it("строка Total по-английски тоже итоговая", () => {
    const json = { records: 1, rows: [{ ProductName: "Total", PrCode: "X", colum2: "5", colum1: "1" }] };
    assert.equal(parseAccountingSales(json).rows.length, 0);
  });

  it("пустой/битый ответ не роняет разбор", () => {
    assert.equal(parseAccountingSales(null).rows.length, 0);
    assert.equal(parseAccountingSales({}).rows.length, 0);
  });
});

describe("dedupLotAgg: НОД-дедуп строк Lot management", () => {
  it("весь набор пришёл дважды → суммы делятся на 2", () => {
    const rows: RawLotRow[] = [
      { product: "Снек", quantity: 10 },
      { product: "Вода", quantity: 4 },
      { product: "Снек", quantity: 10 },
      { product: "Вода", quantity: 4 },
    ];
    const agg = dedupLotAgg(rows);
    assert.equal(agg.get("Снек"), 10);
    assert.equal(agg.get("Вода"), 4);
  });

  it("реальные два слота одного товара без дублей — НОД 1, деления нет", () => {
    const rows: RawLotRow[] = [
      { product: "Снек", quantity: 6 },
      { product: "Снек", quantity: 4 },
      { product: "Вода", quantity: 3 },
    ];
    const agg = dedupLotAgg(rows);
    assert.equal(agg.get("Снек"), 10, "2 строки Снека и 1 Воды → НОД 1");
    assert.equal(agg.get("Вода"), 3);
  });

  it("тройное дублирование при двух настоящих слотах: НОД 3", () => {
    // Товар А — 2 слота × 3 дубля = 6 строк; товар Б — 1 слот × 3 = 3 строки.
    const rows: RawLotRow[] = Array.from({ length: 3 }, () => [
      { product: "А", quantity: 5 },
      { product: "А", quantity: 7 },
      { product: "Б", quantity: 2 },
    ]).flat();
    const agg = dedupLotAgg(rows);
    assert.equal(agg.get("А"), 12);
    assert.equal(agg.get("Б"), 2);
  });

  it("пустой вход — пустой итог", () => {
    assert.equal(dedupLotAgg([]).size, 0);
  });
});

describe("parseLotPage: страница Lot management", () => {
  it("чужие MId отбрасываются, свои считаются", () => {
    const json = {
      rows: [
        { MId: "2508160376", PrName: "Снек", SiExtantQuantity: "6" },
        { MId: "9999999999", PrName: "Чужой", SiExtantQuantity: "1" },
        { MId: "2508160376", PrName: "", SiExtantQuantity: "2" },
      ],
    };
    const { all, mine } = parseLotPage(json, "2508160376");
    assert.equal(all, 3, "сырые строки считаются ДО фильтра — по ним решается пагинация");
    assert.equal(mine.length, 1, "пустое имя товара — не данные");
    assert.equal(mine[0].quantity, 6);
  });
});

describe("OurvendConnector: учётные запросы через фейковый fetch", () => {
  const mkConnector = (handler: (url: string, body: string) => { status?: number; text: string }) => {
    const fetchImpl: FetchLike = async (url, init) => {
      const r = handler(url, String(init.body ?? ""));
      return new Response(r.text, { status: r.status ?? 200 });
    };
    return new OurvendConnector({ account: "a", password: "p", fetchImpl, retries: 0, retryBaseMs: 0 });
  };

  it("SaleSummarize заявил больше строк, чем отдал → ShapeError, не молчаливая обрезка", async () => {
    const c = mkConnector(() => ({
      text: JSON.stringify({ records: 501, rows: [{ ProductName: "X", PrCode: "1", colum2: "1", colum1: "1" }] }),
    }));
    await assert.rejects(
      c.getAccountingSales("2508160376", new Date(), new Date()),
      (e: unknown) => e instanceof ShapeError && /пагинация/.test((e as Error).message),
    );
  });

  it("Lot management: пустой ответ = не вызван getSession → ShapeError", async () => {
    const c = mkConnector(() => ({ text: "" }));
    await assert.rejects(c.getLotRows("2508160376"), (e: unknown) => e instanceof ShapeError);
  });

  it("Lot management: страницы собираются до неполной, фильтр MId сквозной", async () => {
    const full = Array.from({ length: 500 }, (_, i) => ({
      MId: "2508160376",
      PrName: `Т${i}`,
      SiExtantQuantity: "1",
    }));
    const partial = [{ MId: "2508160376", PrName: "Хвост", SiExtantQuantity: "2" }];
    let page = 0;
    const c = mkConnector((url, body) => {
      if (!url.includes("ListJsonUser")) return { text: "{}" };
      page += 1;
      assert.match(body, new RegExp(`page=${page}(&|$)`));
      return { text: JSON.stringify({ rows: page === 1 ? full : partial }) };
    });
    const rows = await c.getLotRows("2508160376");
    assert.equal(page, 2, "после неполной страницы запросы прекращаются");
    assert.equal(rows.length, 501);
  });
});
