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
};

export default nextConfig;
