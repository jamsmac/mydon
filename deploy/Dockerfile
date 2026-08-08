# MYDON — сборка всех приложений монорепо одним образом.
# Многоступенчатая: сборочные зависимости не попадают в финальный образ.

# slim (Debian/glibc), НЕ alpine: sqlite-vec и движок модели (onnxruntime)
# распространяются готовыми двоичными файлами только под glibc — под musl
# смысловой поиск по истории молча не работал бы.
# Node не ниже 20.19: слой подписки помощника подгружает ESM-пакет из CJS —
# на более старых Node такой require падает (см. engines в package.json).
FROM node:20-slim AS base
RUN corepack enable
WORKDIR /app

# ── Зависимости ──
FROM base AS deps
# Инструменты сборки нативных модулей (better-sqlite3 — поиск по истории):
# на случай, если готового двоичного файла не нашлось. Только в этот слой.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/core/package.json ./apps/core/
COPY apps/agents/package.json ./apps/agents/
COPY apps/bot/package.json ./apps/bot/
COPY apps/cc/package.json ./apps/cc/
COPY apps/watchdog/package.json ./apps/watchdog/
COPY packages/db/package.json ./packages/db/
COPY packages/shared/package.json ./packages/shared/
COPY packages/connectors/package.json ./packages/connectors/
COPY packages/assistant/package.json ./packages/assistant/
COPY packages/documents/package.json ./packages/documents/
COPY packages/history/package.json ./packages/history/
RUN pnpm install --frozen-lockfile

# ── Сборка ──
FROM deps AS build
COPY . .
# Кеш turbo живёт между сборками (BuildKit cache mount, не слой образа):
# `COPY . .` инвалидируется любой правкой, и без кеша каждый деплой собирал
# все 11 пакетов заново (~50 с, дольше всего — Next.js панели). С кешем
# пересобирается только тронутое, остальное turbo достаёт готовым.
RUN --mount=type=cache,target=/app/.turbo,sharing=locked pnpm build

# ── Итоговый образ ──
FROM base AS runtime
ENV NODE_ENV=production
ENV TZ=Asia/Tashkent
COPY --from=build /app ./
# Коммит, из которого собран ОБРАЗ. Проверять выкат по каталогу на сервере
# нельзя: `git pull` обновляет его сразу, а пересборка идёт ещё минуты — и всё
# это время работает старый код при «правильном» коммите в каталоге. 08.08.2026
# на этом была вызвана автопривязка старой версией.
ARG GIT_SHA=unknown
ENV GIT_SHA=$GIT_SHA
# Запускаемое приложение задаётся командой в docker-compose
CMD ["node", "apps/core/dist/main.js"]
