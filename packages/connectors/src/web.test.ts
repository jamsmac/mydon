import assert from "node:assert/strict";
import type { LookupAddress } from "node:dns";
import { createServer } from "node:http";
import { describe, it } from "node:test";
import {
  BlockedAddressError,
  assertPublicUrl,
  fetchPage,
  htmlToText,
  isPrivateAddress,
  nodeTransport,
} from "./web";
import type { Transport } from "./web";

describe("web: очистка страницы", () => {
  it("скрипты и стили выбрасываются целиком", () => {
    const t = htmlToText("<p>Дилер HELI</p><script>alert(1)</script><style>.x{}</style>");
    assert.equal(t, "Дилер HELI");
  });

  it("строки таблицы становятся строками текста — запись за записью", () => {
    const t = htmlToText(
      "<table><tr><td>Olma Cafe</td><td>ИНН 123</td></tr><tr><td>Chinor</td><td>ИНН 456</td></tr></table>",
    );
    assert.ok(t.includes("Olma Cafe | ИНН 123"));
    assert.ok(t.split("\n").length >= 2, "строки таблицы должны разделяться переносами");
  });

  it("сущности HTML переводятся в символы", () => {
    assert.equal(htmlToText("Rent&nbsp;&amp;&nbsp;Sale &laquo;x&raquo;".replace(/&laquo;|&raquo;/g, "")), "Rent & Sale x");
  });
});

describe("web: приватные адреса не читаем (SSRF)", () => {
  it("метаданные облака, loopback, Tailscale и ULA — приватные", () => {
    for (const ip of [
      "169.254.169.254",
      "127.0.0.1",
      "10.0.0.5",
      "172.16.0.1",
      "192.168.1.1",
      "100.101.102.103", // CGNAT: диапазон Tailscale
      "0.0.0.0",
      "::1",
      "fd00::1",
      "fe80::1",
      "::ffff:127.0.0.1",
      "::ffff:7f00:1",
    ]) {
      assert.equal(isPrivateAddress(ip), true, `${ip} обязан считаться приватным`);
    }
  });

  it("IPv4 в устаревших обёртках IPv6 (::/96 и 6to4) — приватный не проходит", () => {
    for (const ip of [
      "::127.0.0.1",
      "::7f00:1",
      "::a9fe:a9fe", // 169.254.169.254 — метаданные облака
      "2002:7f00:1::",
      "2002:a9fe:a9fe::1",
    ]) {
      assert.equal(isPrivateAddress(ip), true, `${ip} обязан считаться приватным`);
    }
  });

  it("публичные адреса читать можно", () => {
    for (const ip of ["93.184.216.34", "8.8.8.8", "2606:4700:4700::1111"]) {
      assert.equal(isPrivateAddress(ip), false, `${ip} — публичный`);
    }
  });

  it("литеральный приватный IP в адресе отклоняется до запроса", async () => {
    await assert.rejects(
      () => assertPublicUrl("http://169.254.169.254/latest/meta-data/"),
      (err: unknown) => err instanceof BlockedAddressError && /заблокирован/.test(String(err)),
    );
  });

  it("IPv6-обёртка loopback в адресе отклоняется до запроса", async () => {
    await assert.rejects(
      () => assertPublicUrl("http://[::127.0.0.1]/"),
      (err: unknown) => err instanceof BlockedAddressError && /заблокирован/.test(String(err)),
    );
  });

  it("схема не http(s) отклоняется", async () => {
    await assert.rejects(
      () => assertPublicUrl("file:///etc/passwd"),
      (err: unknown) => err instanceof BlockedAddressError && /Схема/.test(String(err)),
    );
  });
});

/** Фейковый транспорт: сеть в тестах не нужна, адреса — литеральные IP. */
function fakeTransport(reply: (url: string) => Response) {
  const seen: string[] = [];
  const headersSeen: Record<string, string>[] = [];
  const signals: AbortSignal[] = [];
  const transport: Transport = async (target, init) => {
    seen.push(target.toString());
    headersSeen.push(init.headers);
    signals.push(init.signal);
    return reply(target.toString());
  };
  return { transport, seen, headersSeen, signals };
}

describe("web: редиректы проверяются по одному", () => {
  it("редирект на внутренний адрес не выполняется", async () => {
    const { transport, seen } = fakeTransport(() =>
      new Response("", { status: 302, headers: { location: "http://127.0.0.1:8080/admin" } }),
    );
    await assert.rejects(
      () => fetchPage("http://93.184.216.34/prices", { transport }),
      (err: unknown) => err instanceof BlockedAddressError && /заблокирован/.test(String(err)),
    );
    assert.deepEqual(seen, ["http://93.184.216.34/prices"], "во внутренний адрес запроса быть не должно");
  });

  it("редирект на публичный адрес проходит, читается конечная страница", async () => {
    const { transport, seen } = fakeTransport((url) =>
      url.includes("/old")
        ? new Response("", { status: 301, headers: { location: "http://93.184.216.34/new" } })
        : new Response("<p>Цена 1000</p>", { status: 200 }),
    );
    const page = await fetchPage("http://93.184.216.34/old", { transport });
    assert.equal(page.status, 200);
    assert.equal(page.text, "Цена 1000");
    assert.equal(page.url, "http://93.184.216.34/new");
    assert.equal(seen.length, 2);
  });

  it("петля редиректов обрывается, а не крутится", async () => {
    const { transport } = fakeTransport((url) =>
      new Response("", {
        status: 302,
        headers: { location: `http://93.184.216.34/${url.length}` },
      }),
    );
    await assert.rejects(
      () => fetchPage("http://93.184.216.34/loop", { transport }),
      (err: unknown) => err instanceof BlockedAddressError && /переходов/.test(String(err)),
    );
  });
});

describe("web: заголовки владельца не уходят на чужой хост", () => {
  it("кросс-доменный редирект уходит без Cookie и Authorization", async () => {
    const { transport, headersSeen } = fakeTransport((url) =>
      url.includes("93.184.216.34")
        ? new Response("", { status: 302, headers: { location: "http://203.0.113.9/collect" } })
        : new Response("<p>ok</p>", { status: 200 }),
    );
    const page = await fetchPage("http://93.184.216.34/page", {
      transport,
      headers: { Authorization: "Bearer SECRET", Cookie: "sid=1" },
    });
    assert.equal(page.status, 200);
    assert.equal(headersSeen[0].Authorization, "Bearer SECRET", "своему хосту заголовки передаются");
    assert.equal(headersSeen[1].Authorization, undefined, "Authorization не должен уйти на чужой хост");
    assert.equal(headersSeen[1].Cookie, undefined, "Cookie не должен уйти на чужой хост");
    assert.ok(headersSeen[1]["User-Agent"], "служебный User-Agent остаётся");
  });

  it("редирект в пределах своего origin сохраняет заголовки владельца", async () => {
    const { transport, headersSeen } = fakeTransport((url) =>
      url.includes("/old")
        ? new Response("", { status: 301, headers: { location: "http://93.184.216.34/new" } })
        : new Response("<p>ok</p>", { status: 200 }),
    );
    await fetchPage("http://93.184.216.34/old", { transport, headers: { Cookie: "sid=1" } });
    assert.equal(headersSeen[1].Cookie, "sid=1", "в пределах origin доступ владельца сохраняется");
  });

  it("даунгрейд https→http — уже чужой origin: заголовки не передаются", async () => {
    const { transport, headersSeen } = fakeTransport((url) =>
      url.startsWith("https:")
        ? new Response("", { status: 302, headers: { location: "http://93.184.216.34/plain" } })
        : new Response("<p>ok</p>", { status: 200 }),
    );
    await fetchPage("https://93.184.216.34/secure", { transport, headers: { Cookie: "sid=1" } });
    assert.equal(headersSeen[1].Cookie, undefined, "Cookie открытым текстом уходить не должен");
  });
});

describe("web: общий дедлайн и пиновка адреса", () => {
  it("сигнал один на всю цепочку переходов — дедлайн не умножается", async () => {
    const { transport, signals } = fakeTransport((url) =>
      url.includes("/old")
        ? new Response("", { status: 301, headers: { location: "http://93.184.216.34/new" } })
        : new Response("<p>ok</p>", { status: 200 }),
    );
    await fetchPage("http://93.184.216.34/old", { transport });
    assert.equal(signals.length, 2);
    assert.ok(signals[0] instanceof AbortSignal);
    assert.equal(signals[0], signals[1], "сигнал обязан быть одним на всю операцию");
  });

  it("транспорту передаются проверенные адреса — соединение не по имени", async () => {
    const addressesSeen: LookupAddress[][] = [];
    const transport: Transport = async (_target, _init, addresses) => {
      addressesSeen.push(addresses);
      return new Response("<p>ok</p>", { status: 200 });
    };
    await fetchPage("http://93.184.216.34/x", { transport });
    assert.deepEqual(addressesSeen, [[{ address: "93.184.216.34", family: 4 }]]);
  });

  it("nodeTransport соединяется по проверенному адресу, минуя DNS", async () => {
    // Имя в зоне .invalid не разрешается (RFC 2606): дойти до сервера можно
    // ТОЛЬКО по пину — если бы транспорт резолвил имя, запрос бы упал.
    const server = createServer((req, res) => {
      res.setHeader("content-type", "text/plain");
      res.end(`host=${req.headers.host ?? ""}`);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address !== null && typeof address === "object");
    try {
      const res = await nodeTransport(
        new URL(`http://mydon-pin-test.invalid:${address.port}/`),
        { headers: { connection: "close" }, signal: AbortSignal.timeout(5_000) },
        [{ address: "127.0.0.1", family: 4 }],
      );
      assert.equal(res.status, 200);
      assert.ok(res.body !== null);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let text = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value !== undefined) text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
      assert.equal(text, `host=mydon-pin-test.invalid:${address.port}`, "Host — по имени, соединение — по пину");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("web: потолок размера применяется потоково", () => {
  it("гигантский ответ не читается целиком — лишние куски не запрашиваются", async () => {
    const chunk = new TextEncoder().encode("a".repeat(64 * 1024));
    let pulls = 0;
    const { transport } = fakeTransport(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              pulls += 1;
              // «Бесконечный» источник: без потокового лимита чтение бы не кончилось.
              if (pulls > 10_000) {
                controller.close();
                return;
              }
              controller.enqueue(chunk);
            },
          }),
          { status: 200 },
        ),
    );
    const page = await fetchPage("http://93.184.216.34/huge", { transport, maxBytes: 100_000 });
    assert.equal(page.truncated, true);
    assert.ok(page.text.length <= 100_000, "текст обязан быть не длиннее лимита");
    assert.ok(pulls <= 5, `прочитано кусков: ${pulls} — похоже, ответ читался целиком`);
  });

  it("страница ровно в лимит не помечается обрезанной", async () => {
    const { transport } = fakeTransport(() => new Response("abcde", { status: 200 }));
    const page = await fetchPage("http://93.184.216.34/exact", { transport, maxBytes: 5 });
    assert.equal(page.text, "abcde");
    assert.equal(page.truncated, false);
  });

  it("хвост за лимитом отбрасывается, страница помечается обрезанной", async () => {
    const { transport } = fakeTransport(() => new Response("abcdef", { status: 200 }));
    const page = await fetchPage("http://93.184.216.34/tail", { transport, maxBytes: 3 });
    assert.equal(page.text, "abc");
    assert.equal(page.truncated, true);
  });
});
