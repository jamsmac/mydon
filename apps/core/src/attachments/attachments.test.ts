import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { AttachmentsController, UploadDto, isImageMime } from "./attachments.controller";
import { AttachmentsService } from "./attachments.service";
import { StorageService } from "./storage.service";

/** Мок хранилища: ссылку строим предсказуемо, чтобы проверять раскладку. */
const storage = { url: async (id: string) => `/attachments/${id}/raw` } as never;

/** Мок db.select().from().where().orderBy() → заданные строки. */
function dbReturning(rows: Record<string, unknown>[]) {
  return {
    select: () => ({
      from: () => ({
        where: () => ({ orderBy: async () => rows }),
      }),
    }),
  } as never;
}

const row = (id: string, ownerId: string, kind = "photo") => ({
  id,
  ownerType: "entity",
  ownerId,
  kind,
  storageKey: `k/${id}`,
  mime: "image/jpeg",
  bytes: 100,
  createdBy: "staff",
  createdAt: new Date("2026-08-01T00:00:00Z"),
});

describe("Вложения многих записей одним запросом", () => {
  it("пустой набор — не ходит в базу, отдаёт пустую карту", async () => {
    let queried = false;
    const db = {
      select: () => {
        queried = true;
        return { from: () => ({ where: () => ({ orderBy: async () => [] }) }) };
      },
    } as never;
    const s = new AttachmentsService(db, storage);
    const res = await s.ofOwners("entity", []);
    assert.deepEqual(res, {});
    assert.equal(queried, false, "по пустому набору запрос делать незачем");
  });

  it("раскладывает вложения по владельцам", async () => {
    const s = new AttachmentsService(
      dbReturning([row("a1", "e1"), row("a2", "e1"), row("a3", "e2")]),
      storage,
    );
    const res = await s.ofOwners("entity", ["e1", "e2"]);
    assert.equal(res.e1.length, 2);
    assert.equal(res.e2.length, 1);
    assert.equal(res.e1[0].url, "/attachments/a1/raw");
  });

  it("владелец без вложений просто отсутствует в карте", async () => {
    const s = new AttachmentsService(dbReturning([row("a1", "e1")]), storage);
    const res = await s.ofOwners("entity", ["e1", "e2"]);
    assert.deepEqual(Object.keys(res), ["e1"]);
    assert.equal(res.e2, undefined);
  });
});

// ── Загрузка: тип владельца и тип файла ──────────────────────────────────────

/** Мок хранилища и базы для загрузки: ключ и записанная строка наружу. */
function uploadHarness() {
  const written: { key: string; mime: string | null }[] = [];
  const storage = {
    keyFor: (ownerType: string, ownerId: string, ext: string) => `${ownerType}/${ownerId}/f${ext}`,
    put: async (key: string, _bytes: Buffer, mime: string | null) => {
      written.push({ key, mime });
    },
    url: async (id: string) => `/attachments/${id}/raw`,
  } as never;
  const db = {
    insert: () => ({
      values: (v: Record<string, unknown>) => ({
        returning: async () => [{ ...v, id: "a1", stage: null, createdAt: new Date("2026-08-01T00:00:00Z") }],
      }),
    }),
  } as never;
  return { service: new AttachmentsService(db, storage), written };
}

const file = (mimetype: string) => ({
  buffer: Buffer.from("x"),
  mimetype,
  size: 1,
  originalname: "f",
});

const upload = (kind: string) => ({ ownerType: "entity", ownerId: "e1", kind });

describe("Загрузка: белый список типов файла", () => {
  it("фото — только изображение", async () => {
    const { service } = uploadHarness();
    await assert.rejects(() => service.upload(upload("photo"), file("text/html")), /Не изображение/);
  });

  it("чек и документ: HTML не принимаем — иначе он вернётся как HTML на origin панели", async () => {
    for (const kind of ["receipt", "doc"]) {
      const { service, written } = uploadHarness();
      await assert.rejects(
        () => service.upload(upload(kind), file("text/html")),
        /Недопустимый тип файла/,
        `${kind}: text/html обязан быть отклонён`,
      );
      assert.deepEqual(written, [], "отклонённый файл в хранилище не попадает");
    }
  });

  it("чек и документ: изображение и PDF проходят, расширение по типу", async () => {
    const { service, written } = uploadHarness();
    const pdf = await service.upload(upload("receipt"), file("application/pdf"));
    assert.equal(pdf.mime, "application/pdf");
    const jpg = await service.upload(upload("doc"), file("image/jpeg"));
    assert.equal(jpg.mime, "image/jpeg");
    assert.deepEqual(
      written.map((w) => w.key),
      ["entity/e1/f.pdf", "entity/e1/f.jpg"],
    );
  });
});

describe("Загрузка: тип владельца — часть пути в хранилище", () => {
  const dto = (ownerType: string) =>
    plainToInstance(UploadDto, { ownerType, ownerId: "3f2504e0-4f89-11d3-9a0c-0305e82c3301" });

  it("«../» в типе владельца не проходит валидацию", async () => {
    for (const bad of ["../../../etc/cron.d", "entity/../..", "Entity", "1entity", "entity-1", ""]) {
      const errors = await validate(dto(bad));
      assert.ok(errors.length > 0, `${bad} обязан быть отклонён`);
    }
  });

  it("реально используемые типы владельца принимаются", async () => {
    for (const ok of ["entity", "task", "vending_purchase_order"]) {
      assert.deepEqual(await validate(dto(ok)), [], `${ok} должен проходить`);
    }
  });
});

describe("Хранилище на диске: ключ не выводит за пределы тома", () => {
  /** Реальный диск: проверяем именно то, что файл вне тома не появляется. */
  function localStorage(): { storage: StorageService; root: string } {
    const root = mkdtempSync(path.join(tmpdir(), "mydon-att-"));
    for (const key of ["STORAGE_ENDPOINT", "STORAGE_BUCKET", "STORAGE_ACCESS_KEY", "STORAGE_SECRET_KEY"]) {
      delete process.env[key];
    }
    process.env.STORAGE_LOCAL_DIR = path.join(root, "attachments");
    return { storage: new StorageService(), root };
  }

  it("запись по ключу с «..» отклоняется, файл вне тома не создаётся", async () => {
    const { storage, root } = localStorage();
    const escape = path.join(root, "escaped.txt");
    await assert.rejects(
      () => storage.put("../escaped.txt", Buffer.from("вне тома"), "text/plain"),
      /за пределы хранилища/,
    );
    assert.equal(existsSync(escape), false, "файл вне тома появиться не должен");
    await assert.rejects(
      () => storage.put("/etc/cron.d/mydon", Buffer.from("x"), "text/plain"),
      /за пределы хранилища/,
    );
  });

  it("чтение по ключу с «..» тоже отклоняется", async () => {
    const { storage } = localStorage();
    await assert.rejects(() => storage.read("../../etc/passwd"), /за пределы хранилища/);
  });

  it("нормальный ключ пишется и читается", async () => {
    const { storage } = localStorage();
    await storage.put("entity/e1/f.jpg", Buffer.from("байты"), "image/jpeg");
    assert.equal((await storage.read("entity/e1/f.jpg")).toString(), "байты");
  });
});

describe("Отдача байтов: браузер не должен угадывать тип", () => {
  /** Мок express-ответа: наружу — заголовки и отданные байты. */
  function fakeRes() {
    const headers: Record<string, string> = {};
    return {
      headers,
      res: {
        setHeader: (k: string, v: string) => {
          headers[k] = v;
        },
        send: () => undefined,
      } as never,
    };
  }

  const controller = (mime: string | null) =>
    new AttachmentsController({ raw: async () => ({ bytes: Buffer.from("x"), mime }) } as never);

  it("картинка: nosniff есть, вложением не отдаём — она идёт в <img>", async () => {
    const { headers, res } = fakeRes();
    await controller("image/jpeg").raw("a1", res);
    assert.equal(headers["X-Content-Type-Options"], "nosniff");
    assert.equal(headers["Content-Disposition"], undefined);
  });

  it("не картинка: nosniff и отдача вложением", async () => {
    for (const mime of ["application/pdf", "text/html", null]) {
      const { headers, res } = fakeRes();
      await controller(mime).raw("a1", res);
      assert.equal(headers["X-Content-Type-Options"], "nosniff");
      assert.equal(headers["Content-Disposition"], "attachment", `${mime}: обязано быть вложением`);
    }
  });

  it("SVG — не inline-картинка: верно заявленный тип исполняет скрипты, nosniff не спасает", async () => {
    // Легаси-строки до белого списка загрузки могли записать любой mime —
    // барьер обязан стоять на отдаче, а не только на приёме.
    for (const mime of ["image/svg+xml", "IMAGE/SVG+XML", "image/svg+xml;charset=utf-8"]) {
      const { headers, res } = fakeRes();
      await controller(mime).raw("a1", res);
      assert.equal(headers["Content-Disposition"], "attachment", `${mime}: обязан уходить вложением`);
    }
  });

  it("на raw всегда стоит CSP-страховка: sandbox запрещает скрипты при прямом переходе", async () => {
    for (const mime of ["image/jpeg", "image/svg+xml", "application/pdf", null]) {
      const { headers, res } = fakeRes();
      await controller(mime).raw("a1", res);
      assert.equal(headers["Content-Security-Policy"], "default-src 'none'; sandbox");
    }
  });

  it("isImageMime: замкнутый список, регистр и параметры типа не путают", () => {
    assert.equal(isImageMime("IMAGE/PNG"), true);
    assert.equal(isImageMime("image/jpeg;charset=binary"), true);
    assert.equal(isImageMime("image/svg+xml"), false);
    assert.equal(isImageMime("image/gif"), false, "gif не в белом списке — вложением");
    assert.equal(isImageMime("text/html"), false);
    assert.equal(isImageMime(null), false);
  });
});
