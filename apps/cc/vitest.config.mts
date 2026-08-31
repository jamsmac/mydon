import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    // Workspace-пакеты — ИСХОДНИКАМИ: их exports указывают в dist/, которого
    // в свежем чекауте нет, и голый `vitest run` валил 8/18 файлов ошибкой
    // «Failed to resolve entry for package @mydon/shared» до сборки.
    alias: {
      "@mydon/shared": path.resolve(root, "../../packages/shared/src/index.ts"),
      "@mydon/assistant": path.resolve(root, "../../packages/assistant/src/index.ts"),
      // Маркер-пакет Next.js: вне RSC-сборки специфаер не резолвится вовсе,
      // и любой тест, выполняющий модуль клиента Core (core.test.ts), падал бы
      // на import-analysis до старта — vi.mock здесь не успевает.
      "server-only": path.resolve(root, "./src/test/server-only.ts"),
    },
  },
  esbuild: {
    jsx: "automatic",
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    restoreMocks: true,
  },
});
