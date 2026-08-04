import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  contractKey,
  contractNo,
  contractorsFromDocuments,
  contractsFromDocuments,
  DidoxAuthError,
  DidoxClient,
  DidoxNetworkError,
  DidoxShapeError,
  DIDOX_TOKEN_TTL_MS,
  isInvoice,
  isLive,
  num,
  parsePage,
  type DidoxDoc,
} from "./didox";

/** Строка списка из документации Didox — поля ровно как в ответе `/v2/documents`. */
const doc = (over: Partial<DidoxDoc> = {}): DidoxDoc => ({
  doc_id: "11EFBD20AB80D1B080B2C6808E0C7050",
  name: "70",
  doc_date: "2024-12-18",
  doc_status: 3,
  doctype: "002",
  contract_number: "GFH-42/1223",
  contract_date: "2023-12-25",
  partnerTin: "302936161",
  partnerCompany: '"VENKON GROUP" MCHJ',
  owner: 1,
  total_delivery_sum_with_vat: 4424,
  total_vat_sum: 474,
  ...over,
});

describe("Didox: разбор полей", () => {
  it("числа приходят и числом, и строкой", () => {
    assert.equal(num(4424), 4424);
    assert.equal(num("4424.50"), 4424.5);
    assert.equal(num("4 424"), 4424);
    assert.equal(num("мусор"), 0);
    assert.equal(num(null), 0);
  });

  it("заглушки вместо номера договора не становятся ключом", () => {
    assert.equal(contractNo("No contract"), null);
    assert.equal(contractNo(" б/н "), null);
    assert.equal(contractNo(""), null);
    assert.equal(contractNo(null), null);
    assert.equal(contractNo("1"), null); // одиночный символ — не номер
    assert.equal(contractNo(" GFH-42/1223 "), "GFH-42/1223");
  });

  it("ключ договора включает ИНН — одинаковые номера разных покупателей не слипаются", () => {
    assert.notEqual(contractKey("12", "302936161"), contractKey("12", "305143862"));
  });

  it("живой документ — не черновик, не удалённый, не отказ, не аннулированный", () => {
    for (const s of [1, 2, 3, 6, 8, 60]) assert.equal(isLive(doc({ doc_status: s })), true);
    for (const s of [0, 4, 5, 40, 50, 55]) assert.equal(isLive(doc({ doc_status: s })), false);
  });

  it("счёт-фактура отличается от акта и ТТН по коду типа", () => {
    for (const t of ["001", "002", "008", "023"])
      assert.equal(isInvoice(doc({ doctype: t })), true);
    for (const t of ["005", "007", "041", "052"])
      assert.equal(isInvoice(doc({ doctype: t })), false);
  });

  it("страница без массива data — структура сменилась, молчать нельзя", () => {
    assert.throws(() => parsePage({ total: 1 }), DidoxShapeError);
    const p = parsePage({ data: [doc()], total: 1, next_page_url: null });
    assert.equal(p.data.length, 1);
    assert.equal(p.total, 1);
  });
});

describe("Didox: сборка договоров из документов", () => {
  it("документы одного договора сходятся в одну карточку с провенансом строк", () => {
    const { contracts, skipped } = contractsFromDocuments([
      doc({
        doc_id: "a",
        name: "купля-продажа",
        doc_date: "2023-12-25",
        total_delivery_sum_with_vat: 360640000,
        total_vat_sum: 0,
        doctype: "007",
      }),
      doc({
        doc_id: "b",
        name: "СФ-1",
        doc_date: "2024-01-10",
        total_delivery_sum_with_vat: 100,
        total_vat_sum: 12,
      }),
    ]);
    assert.equal(skipped.length, 0);
    assert.equal(contracts.length, 1);
    const c = contracts[0];
    assert.equal(c.contractNo, "GFH-42/1223");
    assert.equal(c.contractDate, "2023-12-25");
    assert.equal(c.buyerInn, "302936161");
    assert.equal(c.totalWithVat, 360640100);
    assert.equal(c.totalVat, 12);
    assert.equal(c.didoxRows?.length, 2);
    assert.equal(c.subject, "купля-продажа");
  });

  it("одинаковый номер у разных покупателей — две карточки, а не одна слипшаяся", () => {
    const { contracts } = contractsFromDocuments([
      doc({
        doc_id: "a",
        contract_number: "12",
        partnerTin: "302936161",
        partnerCompany: "ПЕРВЫЙ",
      }),
      doc({
        doc_id: "b",
        contract_number: "12",
        partnerTin: "305143862",
        partnerCompany: "ВТОРОЙ",
      }),
    ]);
    assert.equal(contracts.length, 2);
    assert.deepEqual(contracts.map((c) => c.buyerName).sort(), ["ВТОРОЙ", "ПЕРВЫЙ"]);
  });

  it("отменённые и черновики в суммы не идут — иначе договор «оплачен» бумагой, которой нет", () => {
    const { contracts } = contractsFromDocuments([
      doc({ doc_id: "a", total_delivery_sum_with_vat: 1000 }),
      doc({ doc_id: "b", doc_status: 40, total_delivery_sum_with_vat: 500 }),
      doc({ doc_id: "c", doc_status: 0, total_delivery_sum_with_vat: 700 }),
    ]);
    assert.equal(contracts[0].totalWithVat, 1000);
  });

  it("выставлено меньше суммы договора → active; счетов на всю сумму → closed", () => {
    const act = doc({
      doc_id: "a",
      doctype: "005",
      total_delivery_sum_with_vat: 784000,
      name: "услуги",
    });
    const open = contractsFromDocuments([act]).contracts[0];
    assert.equal(open.status, "active");
    assert.equal(open.invoicedTotal, 0);

    const closed = contractsFromDocuments([
      doc({ doc_id: "b", total_delivery_sum_with_vat: 17472000 }),
    ]).contracts[0];
    assert.equal(closed.status, "closed");
    assert.equal(closed.invoicedTotal, 17472000);
  });

  it("повтор той же строки считается дублем, а не удваивает сумму", () => {
    const { contracts } = contractsFromDocuments([
      doc({ doc_id: "a", total_delivery_sum_with_vat: 500 }),
      doc({ doc_id: "b", total_delivery_sum_with_vat: 500 }),
    ]);
    assert.equal(contracts[0].totalWithVat, 500);
    assert.equal(contracts[0].didoxDuplicatesDropped, 1);
  });

  it("расхождение дат договора не теряется: ранняя — дата, остальные в extraDates", () => {
    const { contracts } = contractsFromDocuments([
      doc({ doc_id: "a", contract_date: "2024-03-01" }),
      doc({ doc_id: "b", contract_date: "2023-12-25", total_delivery_sum_with_vat: 1 }),
    ]);
    assert.equal(contracts[0].contractDate, "2023-12-25");
    assert.deepEqual(contracts[0].extraDates, ["2024-03-01"]);
  });

  it("документ без номера договора или без ИНН попадает в skipped со словами, а не в тишину", () => {
    const { contracts, skipped } = contractsFromDocuments([
      doc({ doc_id: "a", contract_number: "No contract" }),
      doc({ doc_id: "b", partnerTin: null }),
    ]);
    assert.equal(contracts.length, 0);
    assert.equal(skipped.length, 2);
    assert.match(skipped[0].reason, /номер договора не разобрать/);
    assert.match(skipped[1].reason, /без ИНН/);
  });

  it("контрагенты берутся полями, без разбора названий", () => {
    const list = contractorsFromDocuments([
      doc({ partnerTin: "302936161", partnerCompany: "ПЕРВЫЙ" }),
      doc({ partnerTin: "302936161", partnerCompany: "ПЕРВЫЙ" }),
      doc({ partnerTin: "305143862", partnerCompany: "ВТОРОЙ" }),
      doc({ partnerTin: null }),
    ]);
    assert.deepEqual(list, [
      { inn: "302936161", name: "ПЕРВЫЙ" },
      { inn: "305143862", name: "ВТОРОЙ" },
    ]);
  });
});

/** Ответы Didox по очереди — как в документации. */
function stubFetch(replies: { status?: number; body: unknown }[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  let i = 0;
  const fetchImpl = (async (url: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    const r = replies[i] ?? { body: {} };
    i += 1;
    return {
      ok: (r.status ?? 200) < 400,
      status: r.status ?? 200,
      json: async () => r.body,
      text: async () => JSON.stringify(r.body),
    } as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const CFG = { partnerToken: "PT", taxId: "310529901", password: "secret" };

describe("Didox: клиент", () => {
  it("вход по паролю отдаёт токен и шлёт партнёрский заголовок", async () => {
    const { fetchImpl, calls } = stubFetch([{ body: { token: "f2782e75-c37b" } }]);
    const c = new DidoxClient({ ...CFG, fetchImpl });
    assert.equal(await c.userToken(), "f2782e75-c37b");
    assert.match(calls[0].url, /\/v1\/auth\/310529901\/password\/ru$/);
    assert.equal((calls[0].init.headers as Record<string, string>)["Partner-Authorization"], "PT");
    // Пароль уходит телом запроса и нигде не оседает в URL.
    assert.doesNotMatch(calls[0].url, /secret/);
  });

  it("токен переиспользуется, пока свежий, и переполучается после 360 минут", async () => {
    const { fetchImpl, calls } = stubFetch([
      { body: { token: "t1" } },
      { body: { data: [], total: 0, next_page_url: null } },
      { body: { token: "t2" } },
      { body: { data: [], total: 0, next_page_url: null } },
    ]);
    let clock = 0;
    const c = new DidoxClient({ ...CFG, fetchImpl, now: () => clock });
    await c.listDocuments();
    clock += DIDOX_TOKEN_TTL_MS + 1;
    await c.listDocuments();
    const logins = calls.filter((x) => x.url.includes("/auth/"));
    assert.equal(logins.length, 2);
    assert.equal((calls[3].init.headers as Record<string, string>)["user-key"], "t2");
  });

  it("неверный пароль — отдельная ошибка, не «что-то пошло не так»", async () => {
    const { fetchImpl } = stubFetch([{ status: 401, body: "Unauthorized" }]);
    const c = new DidoxClient({ ...CFG, fetchImpl });
    await assert.rejects(() => c.userToken(), DidoxAuthError);
  });

  it("пустой партнёрский токен ловится сразу, до первого запроса", () => {
    assert.throws(() => new DidoxClient({ ...CFG, partnerToken: " " }), DidoxAuthError);
  });

  it("сеть упала — DidoxNetworkError, а не голый TypeError", async () => {
    const fetchImpl = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const c = new DidoxClient({ ...CFG, fetchImpl });
    await assert.rejects(() => c.userToken(), DidoxNetworkError);
  });

  it("страницы идут, пока Didox их отдаёт; дубли по doc_id не задваиваются", async () => {
    const { fetchImpl, calls } = stubFetch([
      { body: { token: "t" } },
      { body: { data: [doc({ doc_id: "a" })], total: 2, next_page_url: "…page=2" } },
      {
        body: { data: [doc({ doc_id: "a" }), doc({ doc_id: "b" })], total: 2, next_page_url: null },
      },
    ]);
    const c = new DidoxClient({ ...CFG, fetchImpl });
    const all = await c.allDocuments({ owner: 1 });
    assert.deepEqual(
      all.map((d) => d.doc_id),
      ["a", "b"],
    );
    assert.match(calls[1].url, /page=1&limit=100/);
    assert.match(calls[1].url, /owner=1/);
    assert.match(calls[2].url, /page=2/);
  });

  it("limit держится в границах API (1..100)", async () => {
    const { fetchImpl, calls } = stubFetch([
      { body: { token: "t" } },
      { body: { data: [], total: 0, next_page_url: null } },
    ]);
    const c = new DidoxClient({ ...CFG, fetchImpl });
    await c.listDocuments({ limit: 5000 });
    assert.match(calls[1].url, /limit=100/);
  });
});
