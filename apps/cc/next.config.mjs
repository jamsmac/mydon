/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@mydon/shared", "@mydon/assistant", "react-leaflet", "@react-leaflet/core"],
  // Anthropic SDK — Node-пакет с динамическими require. Держим его ВНЕ бандла
  // Next, чтобы серверное действие грузило его нативно из node_modules в рантайме
  // (LLM-слой помощника). Работает в паре с прямой зависимостью в package.json.
  // @anthropic-ai/sdk — CommonJS, оставляем внешним.
  // claude-agent-sdk здесь НЕ нужен: он грузится настоящим ESM-import
  // в рантайме (см. packages/assistant/src/llm-subscription.ts).
  serverExternalPackages: ["@anthropic-ai/sdk"],
  // Короткие адреса направлений из документации (CLAUDE.md, README): реальные
  // страницы живут под /domain/<имя>. /mydon сюда НЕ входит — это настоящий
  // роут (src/app/mydon), redirect закрыл бы его собой.
  async redirects() {
    return ["vendhub", "globerent", "personal"].map((d) => ({
      source: `/${d}`,
      destination: `/domain/${d}`,
      permanent: true,
    }));
  },
};

export default nextConfig;
