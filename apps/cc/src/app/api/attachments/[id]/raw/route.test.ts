import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";

const mocks = vi.hoisted(() => ({ coreBytes: vi.fn() }));

vi.mock("../../../../../lib/core", () => ({
  coreBytes: mocks.coreBytes,
  CoreUnavailable: class CoreUnavailable extends Error {
    constructor(readonly detail: string) {
      super("Core недоступен");
    }
  },
}));

const ID = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";

function call(id = ID): Promise<Response> {
  return GET(new Request("http://cc.local"), { params: Promise.resolve({ id }) });
}

function bytes(contentType: string | null) {
  mocks.coreBytes.mockResolvedValue({ body: new ArrayBuffer(1), contentType });
}

describe("Прокси raw-вложения: браузер не должен ничего исполнять", () => {
  beforeEach(() => vi.resetAllMocks());

  it("плохой идентификатор отклоняется до похода в Core", async () => {
    const res = await call("../secret");
    expect(res.status).toBe(400);
    expect(mocks.coreBytes).not.toHaveBeenCalled();
  });

  it("картинка из белого списка идёт inline, с nosniff и CSP-страховкой", async () => {
    bytes("image/jpeg");
    const res = await call();
    expect(res.headers.get("Content-Disposition")).toBeNull();
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Content-Security-Policy")).toBe("default-src 'none'; sandbox");
  });

  it("SVG — не inline: верно заявленный тип исполняет скрипты, nosniff не спасает", async () => {
    // Легаси-строки до белого списка загрузки в Core могли записать любой
    // mime — зеркальный барьер обязан стоять и на отдаче через панель.
    for (const type of ["image/svg+xml", "IMAGE/SVG+XML", "image/svg+xml;charset=utf-8"]) {
      bytes(type);
      const res = await call();
      expect(res.headers.get("Content-Disposition"), `${type}: обязан уходить вложением`).toBe(
        "attachment",
      );
      expect(res.headers.get("Content-Security-Policy")).toBe("default-src 'none'; sandbox");
    }
  });

  it("не картинка и неизвестный тип — вложением", async () => {
    for (const type of ["application/pdf", "text/html", null]) {
      bytes(type);
      const res = await call();
      expect(res.headers.get("Content-Disposition"), `${String(type)}: обязано быть вложением`).toBe(
        "attachment",
      );
    }
  });
});
