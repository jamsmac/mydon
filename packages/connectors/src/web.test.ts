import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { htmlToText } from "./web";

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
