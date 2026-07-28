# MYDON — сборка всех приложений монорепо одним образом.
# Многоступенчатая: сборочные зависимости не попадают в финальный образ.

FROM node:20-alpine AS base
RUN corepack enable
WORKDIR /app

# ── Зависимости ──
FROM base AS deps
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
RUN pnpm install --frozen-lockfile

# ── Сборка ──
FROM deps AS build
COPY . .
RUN pnpm build

# ── Итоговый образ ──
FROM base AS runtime
ENV NODE_ENV=production
ENV TZ=Asia/Tashkent
COPY --from=build /app ./
# Запускаемое приложение задаётся командой в docker-compose
CMD ["node", "apps/core/dist/main.js"]
