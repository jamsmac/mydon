import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  LOGO_GLOBERENT_PNG_BASE64,
  LOGO_GLOBERENT_SIZE,
  LOGO_HELI_PNG_BASE64,
  LOGO_HELI_SIZE,
} from "./logo-assets";

/**
 * Логотипы бланка КП лежат в коде строкой base64 и собираются из сотен кусков.
 * Раньше куски склеивались цепочкой `"a" + "b" + ...` — дерево из 827 вложенных
 * выражений, на котором парсер eslint переполнял стек и валил линт всего пакета.
 * Теперь это массив со `.join("")`, а тест держит содержимое: склейка должна
 * давать настоящий PNG заявленного размера, а не «что-то похожее на строку».
 */
function pngSize(base64: string): { width: number; height: number } {
  const buf = Buffer.from(base64, "base64");
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.ok(buf.subarray(0, 8).equals(signature), "это не PNG: подпись не сошлась");
  assert.equal(buf.subarray(12, 16).toString("ascii"), "IHDR", "первый чанк PNG должен быть IHDR");
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

describe("логотипы бланка КП", () => {
  it("GLOBERENT: склейка даёт PNG заявленного размера", () => {
    assert.deepEqual(pngSize(LOGO_GLOBERENT_PNG_BASE64), {
      width: LOGO_GLOBERENT_SIZE.width,
      height: LOGO_GLOBERENT_SIZE.height,
    });
  });

  it("HELI: склейка даёт PNG заявленного размера", () => {
    assert.deepEqual(pngSize(LOGO_HELI_PNG_BASE64), {
      width: LOGO_HELI_SIZE.width,
      height: LOGO_HELI_SIZE.height,
    });
  });

  it("в base64 не затесались пробелы и переводы строк", () => {
    // Склейка массива без разделителя — если кто-то поставит join(" ") или
    // забудет запятую, декодер смолчит, а картинка развалится.
    for (const [имя, b64] of [
      ["GLOBERENT", LOGO_GLOBERENT_PNG_BASE64],
      ["HELI", LOGO_HELI_PNG_BASE64],
    ] as const) {
      assert.ok(/^[A-Za-z0-9+/]+={0,2}$/.test(b64), `${имя}: в base64 посторонние символы`);
    }
  });
});
