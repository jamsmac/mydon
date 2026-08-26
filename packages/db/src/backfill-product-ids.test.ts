import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BACKFILL_TARGETS, backfillProductIds, бэкфиллWhere, resolveProductIds } from "./backfill-product-ids";
import { machineSlot, vendingAlias, vendingProduct, vendingRefill, vendingStock, vendingStockCount } from "./schema";

/**
 * Текст SQL-выражения drizzle (та же техника, что в
 * `apps/core/src/vending/vending.service.test.ts`), но рекурсивная: `and(...)`
 * кладёт вложенные условия отдельным `SQL`-чанком, а не разворачивает их в
 * общий список — плоская версия текст «is null» бы не нашла.
 */
function текстSQL(x: unknown): string {
  if (x && typeof x === "object") {
    const chunks = (x as { queryChunks?: unknown[] }).queryChunks;
    if (Array.isArray(chunks)) return chunks.map(текстSQL).join("");
    const v = (x as { value?: unknown }).value;
    if (Array.isArray(v)) return v.join("");
    const name = (x as { name?: unknown }).name;
    if (typeof name === "string") return name;
  }
  return "";
}

const ТОВАРЫ = [
  { id: "p-cola", name: "Coca-Cola Classic 0,5" },
  { id: "p-mont", name: "Montella Вода минеральная 330ml" },
];
const АЛИАСЫ = [
  { productId: "p-mont", alias: "18+" },
  { productId: "p-mont", alias: "Montella" },
];

describe("Бэкфилл product_id: резолв имени тем же правилом, что у Core", () => {
  it("точное имя прайса резолвится в карточку", () => {
    const m = resolveProductIds(["Coca-Cola Classic 0,5"], ТОВАРЫ, АЛИАСЫ);
    assert.equal(m.get("Coca-Cola Classic 0,5"), "p-cola");
  });

  it("другое написание того же имени — тот же товар (нормализация, а не точное равенство)", () => {
    // Снимок присылает «COCA-COLA  CLASSIC 0,5», склад заведён «Coca-Cola
    // Classic 0,5». Посимвольное сравнение оставило бы строку с NULL.
    const m = resolveProductIds(["  COCA-COLA  CLASSIC 0,5 "], ТОВАРЫ, АЛИАСЫ);
    assert.equal(m.get("  COCA-COLA  CLASSIC 0,5 "), "p-cola");
  });

  it("алиас ведёт к карточке своего товара", () => {
    const m = resolveProductIds(["18+", "montella"], ТОВАРЫ, АЛИАСЫ);
    assert.equal(m.get("18+"), "p-mont");
    assert.equal(m.get("montella"), "p-mont");
  });

  it("неизвестное имя карточки не выдумывает — в карте его нет", () => {
    const m = resolveProductIds(["Загадка"], ТОВАРЫ, АЛИАСЫ);
    assert.equal(m.has("Загадка"), false, "лучше NULL и строка в отчёте, чем чужая привязка");
  });

  it("пустое имя пропускается: слот без товара — это не осиротевшая привязка", () => {
    const m = resolveProductIds(["", "   ", null], ТОВАРЫ, АЛИАСЫ);
    assert.equal(m.size, 0);
  });

  it("алиас на удалённый товар не резолвится в мусорный id", () => {
    const m = resolveProductIds(["18+"], [{ id: "p-cola", name: "Coca-Cola Classic 0,5" }], АЛИАСЫ);
    assert.equal(m.has("18+"), false);
  });
});

describe("Бэкфилл product_id: UPDATE не трогает уже привязанные строки (N2)", () => {
  it("предикат содержит `product_id IS NULL` — строку с непустой ссылкой на то же имя UPDATE не заденет", () => {
    const где = бэкфиллWhere(vendingStock.productName, vendingStock.productId, "Montella Вода минеральная 330ml");
    const выражение = текстSQL(где);
    assert.match(выражение, /product_id.*is null/, "без этого условия UPDATE обновил бы ВСЕ строки с этим именем");
    assert.match(выражение, /product_name/, "имя из UPDATE не пропало — фильтр по-прежнему точечный");
  });

  it("тот же предикат для machine_slot — таблицы устроены одинаково", () => {
    const где = бэкфиллWhere(machineSlot.productName, machineSlot.productId, "Snickers");
    const выражение = текстSQL(где);
    assert.match(выражение, /product_id.*is null/);
  });
});

/**
 * Стенд: `select` отдаёт имена по таблице, `update` только СЧИТАЕТ вызовы.
 * Проверяемое утверждение у `--dry-run` — «резолв прошёл, записи не было», и
 * доказывает его именно счётчик, а не отсутствие исключения.
 */
function стенд(имена: Partial<Record<string, (string | null)[]>>) {
  const обновления: { таблица: unknown; id: string }[] = [];
  const db = {
    select: (_поля?: Record<string, unknown>) => ({
      from: (t: unknown) => {
        // Каталог теперь читается с `orderBy(id)` (детерминированность
        // «последний побеждает» между примеркой и записью) — стенд обязан
        // подставлять `orderBy`, иначе настоящий вызов упадёт на `.orderBy is
        // not a function`, а не молча смолчит расхождение со стендом.
        if (t === vendingProduct) return { orderBy: () => Promise.resolve(ТОВАРЫ) };
        if (t === vendingAlias) return { orderBy: () => Promise.resolve(АЛИАСЫ) };
        const ключ =
          t === vendingStock ? "stock" : t === machineSlot ? "slots" : t === vendingRefill ? "refills" : "stockCounts";
        const строки = (имена[ключ] ?? []).map((name) => ({ name }));
        return { where: () => Promise.resolve(строки), then: (r: (v: unknown) => unknown) => Promise.resolve(строки).then(r) };
      },
    }),
    update: (t: unknown) => ({
      set: (patch: { productId: string }) => ({
        where: () => ({ returning: async () => { обновления.push({ таблица: t, id: patch.productId }); return [{ id: patch.productId }]; } }),
      }),
    }),
  } as never;
  return { db, обновления };
}

describe("Бэкфилл product_id: четыре цели, включая заливки и историю склада (R-H-4)", () => {
  it("цели — ровно четыре таблицы, и обе новые на месте", () => {
    assert.deepEqual(
      BACKFILL_TARGETS.map((t) => t.key),
      ["stock", "slots", "refills", "stockCounts"],
    );
    assert.equal(BACKFILL_TARGETS.find((t) => t.key === "refills")!.table, vendingRefill);
    assert.equal(BACKFILL_TARGETS.find((t) => t.key === "stockCounts")!.table, vendingStockCount);
  });

  it("имя заливки и имя строки истории резолвятся тем же правилом, что склад", async () => {
    // Импорт истории (П8a) назвал владельцу 11 неопознанных имён, но привязать
    // их после заведения карточек было нечем: бэкфилл обходил обе таблицы.
    const { db, обновления } = стенд({ refills: ["18+"], stockCounts: ["  COCA-COLA  CLASSIC 0,5 "] });
    const итог = await backfillProductIds(db);
    assert.equal(итог.refills.updated, 1);
    assert.equal(итог.stockCounts.updated, 1);
    assert.deepEqual(обновления.map((u) => u.id).sort(), ["p-cola", "p-mont"]);
  });

  it("`--dry-run` резолвит имена и НЕ зовёт update", async () => {
    const { db, обновления } = стенд({ refills: ["18+"], stockCounts: ["Coca-Cola Classic 0,5"] });
    const итог = await backfillProductIds(db, { dryRun: true });
    assert.equal(итог.refills.updated, 1, "примерка обязана посчитать то же, что записала бы");
    assert.equal(обновления.length, 0, "примерка не пишет ни одной строки");
  });

  it("имя без карточки остаётся NULL и едет списком, а не выдуманной привязкой", async () => {
    const { db } = стенд({ stockCounts: ["Загадка", "Coca-Cola Classic 0,5"] });
    const итог = await backfillProductIds(db);
    assert.deepEqual(итог.stockCounts.unresolved, ["Загадка"]);
  });

  it("предикат для новых целей тот же: `product_id IS NULL` на месте", () => {
    for (const t of BACKFILL_TARGETS) {
      const выражение = текстSQL(бэкфиллWhere(t.nameColumn, t.idColumn, "Snickers"));
      assert.match(выражение, /product_id.*is null/, `${t.key}: без этого UPDATE задел бы уже привязанные строки`);
      assert.match(выражение, /product_name/, `${t.key}: фильтр по имени не пропал`);
    }
  });

  it("idColumn каждой цели — колонка её же таблицы: set() пишет по найденному ключу, а не по захардкоженному имени", () => {
    // Страховка для idKeyOf: если бы у пятой цели idColumn принадлежал не той
    // таблице, что и `table`, UPDATE молча обновил бы не ту колонку (или ни
    // одной) под литералом `productId`. Здесь связь проверена по всем
    // текущим целям — по объекту таблицы, а не по имени поля на веру.
    for (const t of BACKFILL_TARGETS) {
      const запись = Object.entries(t.table as unknown as Record<string, unknown>).find(([, col]) => col === t.idColumn);
      assert.ok(запись, `${t.key}: idColumn обязана быть колонкой своей же таблицы`);
    }
  });
});
