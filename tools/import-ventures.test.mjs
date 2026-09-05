import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MAX_NAME,
  VENTURE_DOMAIN,
  VENTURE_TYPE,
  normalizeTitle,
  normalizeUrl,
  plan,
  seenHash,
  softTotal,
  toEntity,
} from "./import-ventures.mjs";

const card = {
  title: "Newsletter по грантам для фрилансеров",
  url: "https://www.indiehackers.com/post/abc/?utm_source=twitter&ref=digest",
  source: "Indie Hackers",
  foundAt: "2026-09-05",
  what: "Платная рассылка: $9/мес, отбор грантов автоматом",
  revenueProof: { figure: "$1,800 MRR", evidence: "скриншот Stripe в интервью", url: "https://ih.example/mrr" },
  operations: ["сбор грантов парсером", "рассылка", "оплата через Stripe"],
  entryThreshold: { capitalUsd: 120, daysToRevenue: 21, tools: ["Telegram-бот", "Payme"] },
  transfer: { fromMarket: "us", toMarket: "uzbekistan", blockers: ["нет Stripe"] },
  ownerAssets: ["канал в Telegram"],
  verdict: "GO",
  hardChecks: { H1: true, H2: true, H3: true, H4: true, H5: true },
  softScore: { S1: 4, S2: 3, S3: 4, S4: 5, S5: 3, S6: 2 },
  nextStep: "собрать список источников грантов UZ",
};

describe("seenHash — «виденное» не зависит от косметики ссылки", () => {
  it("протокол, www, регистр, хвостовой слэш и utm-метки не делают находку новой", () => {
    const base = seenHash("https://www.indiehackers.com/post/abc", "Newsletter по грантам");
    for (const url of [
      "http://indiehackers.com/post/abc",
      "https://WWW.IndieHackers.com/post/abc/",
      "indiehackers.com/post/abc//",
      "https://www.indiehackers.com/post/abc?utm_source=twitter&utm_medium=x",
    ]) {
      assert.equal(seenHash(url, "  Newsletter   по   грантам  "), base, url);
    }
  });

  it("не-utm параметры сохраняются: другая страница — другая сигнатура", () => {
    assert.notEqual(
      seenHash("https://x.com/post?id=1", "T"),
      seenHash("https://x.com/post?id=2", "T"),
    );
    assert.notEqual(seenHash("https://x.com/a", "Один"), seenHash("https://x.com/a", "Другой"));
  });

  it("нормализация по частям: url и заголовок", () => {
    assert.equal(normalizeUrl("HTTPS://WWW.Acquire.com/lot/7/?utm_id=9&page=2"), "acquire.com/lot/7?page=2");
    assert.equal(normalizeUrl(undefined), "");
    assert.equal(normalizeTitle(" Бот\tдля\nсчетов "), "бот для счетов");
  });

  it("sha256: шестьдесят четыре шестнадцатеричных знака", () => {
    assert.match(seenHash("https://a.example/1", "Заголовок"), /^[0-9a-f]{64}$/);
  });
});

describe("toEntity — карточка сессии → карточка Core", () => {
  const entity = toEntity(card, "2026-09-05-1", "uzbekistan");

  it("домен, тип, имя, сигнатура и источник появления", () => {
    assert.equal(entity.domain, VENTURE_DOMAIN, "домен `mydon` — пока `ventures` нет в DOMAINS");
    assert.equal(entity.type, VENTURE_TYPE);
    assert.equal(entity.name, card.title);
    assert.equal(entity.externalRef, seenHash(card.url, card.title));
    assert.equal(entity.createdFrom, "venture-factory:2026-09-05-1");
  });

  it("attrs несут всю карточку, сумму мягких баллов, сессию и рынок", () => {
    assert.equal(entity.attrs.session, "2026-09-05-1");
    assert.equal(entity.attrs.market, "uzbekistan");
    assert.equal(entity.attrs.verdict, "GO");
    assert.deepEqual(entity.attrs.hardChecks, card.hardChecks);
    assert.deepEqual(entity.attrs.revenueProof, card.revenueProof);
    assert.deepEqual(entity.attrs.operations, card.operations);
    assert.deepEqual(entity.attrs.entryThreshold, card.entryThreshold);
    assert.deepEqual(entity.attrs.transfer, card.transfer);
    assert.deepEqual(entity.attrs.ownerAssets, card.ownerAssets);
    assert.equal(entity.attrs.softTotal, 21, "4+3+4+5+3+2");
    assert.equal(entity.attrs.nextStep, card.nextStep);
  });

  it("незаполненные поля не превращаются в пустые ключи", () => {
    assert.equal("failReason" in entity.attrs, false);
    assert.equal("parkCondition" in entity.attrs, false);
  });

  it("вердикт NO без мягких баллов: softTotal не считается", () => {
    const no = toEntity(
      { ...card, softScore: undefined, verdict: "NO", failReason: "H4 — нужен владелец" },
      "2026-09-05-1",
      "uzbekistan",
    );
    assert.equal("softTotal" in no.attrs, false);
    assert.equal("softScore" in no.attrs, false);
    assert.equal(no.attrs.failReason, "H4 — нужен владелец");
    assert.equal(softTotal(undefined), undefined);
    assert.equal(softTotal({}), undefined);
  });

  it("рынок по умолчанию — целевой рынок переноса самой карточки", () => {
    assert.equal(toEntity(card, "s").attrs.market, "uzbekistan");
    assert.equal("market" in toEntity({ ...card, transfer: undefined }, "s").attrs, false);
  });

  it("длинный заголовок обрезается до предела Core, а не роняет карточку", () => {
    const long = toEntity({ ...card, title: "я".repeat(MAX_NAME + 40) }, "s");
    assert.equal(long.name.length, MAX_NAME);
    assert.ok(long.name.endsWith("…"), "обрезка видна глазом");
  });
});

describe("plan — дедуп по сигнатуре: и против реестра, и внутри файла", () => {
  const second = { ...card, title: "Каталог тендеров", url: "https://acquire.com/lot/7" };

  it("пустой реестр — все новые", () => {
    const { create, skip } = plan([card, second], []);
    assert.deepEqual(create.map((c) => c.title), [card.title, second.title]);
    assert.deepEqual(skip, []);
  });

  it("карточка Core с той же сигнатурой — пропуск (реестр как строки Core)", () => {
    const { create, skip } = plan([card, second], [
      { id: "u-1", externalRef: seenHash(card.url, card.title) },
      { id: "u-2", externalRef: null },
    ]);
    assert.deepEqual(create.map((c) => c.title), [second.title]);
    assert.deepEqual(skip.map((c) => c.title), [card.title]);
  });

  it("реестр можно передать набором сигнатур", () => {
    const { create } = plan([card], new Set([seenHash(card.url, card.title)]));
    assert.deepEqual(create, []);
  });

  it("две карточки одной сессии на один url — одна запись", () => {
    const twin = { ...card, url: `${card.url}&utm_campaign=x`, title: card.title.toUpperCase() };
    const { create, skip } = plan([card, twin], []);
    assert.equal(create.length, 1);
    assert.equal(skip.length, 1);
  });

  it("повторный прогон той же сессии не создаёт ничего (идемпотентность)", () => {
    const cards = [card, second];
    const registry = plan(cards, []).create.map((c) => toEntity(c, "2026-09-05-1", "uzbekistan"));
    const again = plan(cards, registry);
    assert.deepEqual(again.create, []);
    assert.equal(again.skip.length, 2);
  });

  it("пустой файл — пустой план", () => {
    assert.deepEqual(plan([], []), { create: [], skip: [] });
    assert.deepEqual(plan(undefined, []), { create: [], skip: [] });
  });
});
