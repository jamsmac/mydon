import { describe, expect, it } from "vitest";
import nextConfig from "../../next.config.mjs";

/**
 * Короткие адреса направлений из документации (/vendhub, /globerent,
 * /personal) отвечали 404: реальные страницы живут под /domain/<имя>.
 * Держим постоянные redirect в next.config.mjs — и НЕ трогаем /mydon,
 * он настоящий роут (src/app/mydon/page.tsx).
 */
describe("короткие адреса направлений", () => {
  it("redirect-конфиг содержит три правила /<имя> → /domain/<имя>", async () => {
    const rules = await nextConfig.redirects?.();
    expect(rules).toEqual([
      { source: "/vendhub", destination: "/domain/vendhub", permanent: true },
      { source: "/globerent", destination: "/domain/globerent", permanent: true },
      { source: "/personal", destination: "/domain/personal", permanent: true },
    ]);
  });

  it("на /mydon redirect не заведён — это реальный роут", async () => {
    const rules = (await nextConfig.redirects?.()) ?? [];
    expect(rules.some((r) => r.source === "/mydon")).toBe(false);
  });
});
