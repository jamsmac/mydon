/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@mydon/shared", "@mydon/assistant"],
  // Anthropic SDK — Node-пакет с динамическими require. Держим его ВНЕ бандла
  // Next, чтобы серверное действие грузило его нативно из node_modules в рантайме
  // (LLM-слой помощника). Работает в паре с прямой зависимостью в package.json.
  serverExternalPackages: ["@anthropic-ai/sdk", "@anthropic-ai/claude-agent-sdk"],
};

export default nextConfig;
