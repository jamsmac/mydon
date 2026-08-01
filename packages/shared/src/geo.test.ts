import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { addressFromAttrs, coordFromAttrs, parseCoord } from "./geo";

describe("Координаты: разбор и диапазон", () => {
  it("валидная пара — строкой и числом", () => {
    assert.deepEqual(parseCoord("41.311", "69.279"), { lat: 41.311, lng: 69.279 });
    assert.deepEqual(parseCoord(41.311, 69.279), { lat: 41.311, lng: 69.279 });
    assert.deepEqual(parseCoord("-0.5", "0"), { lat: -0.5, lng: 0 });
  });

  it("вне мирового диапазона — null", () => {
    assert.equal(parseCoord(91, 10), null); // широта > 90
    assert.equal(parseCoord(10, 181), null); // долгота > 180
    assert.equal(parseCoord(-91, 0), null);
    assert.equal(parseCoord(0, -181), null);
  });

  it("непарсимое — null, а не 0", () => {
    assert.equal(parseCoord("", "10"), null);
    assert.equal(parseCoord("abc", "10"), null);
    assert.equal(parseCoord(null, 10), null);
    assert.equal(parseCoord(NaN, 10), null);
  });

  it("coordFromAttrs различает «не вводил» и «ввёл неверно»", () => {
    assert.deepEqual(coordFromAttrs({}), { present: false, coord: null });
    assert.deepEqual(coordFromAttrs({ широта: "", долгота: "" }), { present: false, coord: null });
    const ok = coordFromAttrs({ широта: "41.3", долгота: "69.2" });
    assert.equal(ok.present, true);
    assert.deepEqual(ok.coord, { lat: 41.3, lng: 69.2 });
    const bad = coordFromAttrs({ широта: "999", долгота: "69.2" });
    assert.equal(bad.present, true, "величины заявлены");
    assert.equal(bad.coord, null, "но они неверны");
  });

  it("адрес — первое непустое из точка/адрес/локация", () => {
    assert.equal(addressFromAttrs({ точка: "ТЦ Compass" }), "ТЦ Compass");
    assert.equal(addressFromAttrs({ адрес: "ул. Амира Темура" }), "ул. Амира Темура");
    assert.equal(addressFromAttrs({ точка: "  ", локация: "Чиланзар" }), "Чиланзар");
    assert.equal(addressFromAttrs({}), null);
  });
});
