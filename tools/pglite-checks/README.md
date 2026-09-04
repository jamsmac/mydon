# Сценарии на настоящем SQL — два движка, один код

**В CI они уже гоняются** — шаг «Scenarios on real SQL (parts U1-U6)» на сервисе `postgres:17`
той же джобы: каждому сценарию своя свежая база из шаблона, после прогона она удаляется
(`CHECKS_DATABASE_URL`, застава на не-локальный хост — `CHECKS_ALLOW_REMOTE=1`). Тяжёлый
WASM-пакет в lockfile для этого не нужен. Локально то же самое идёт на pglite, без сервера.

Каждый сценарий печатает движок в своей строке (`У2 (postgres)` / `У2 (pglite)`), чтобы
«зелёное» нельзя было спутать. Разница драйверов уже поймана однажды: `count(*)` pglite
отдаёт числом, а postgres-js — строкой (bigint), поэтому счётчики в сценариях приводятся
к `::int`.

```bash
# на настоящем сервере (так же, как в CI); postgres:17 в докере — той же версии, что прод
docker run -d --name pg17 -e POSTGRES_USER=mydon -e POSTGRES_PASSWORD=mydon -e POSTGRES_DB=mydon -p 55432:5432 postgres:17
export CHECKS_DATABASE_URL=postgres://mydon:mydon@127.0.0.1:55432/mydon
node tools/pglite-checks/run-migrations.mjs
for c in check-0084 check-parts-u1 check-parts-u2 check-parts-u3 check-parts-u4 check-parts-u5 check-parts-u6; do
  node tools/pglite-checks/$c.mjs
done
```

## Без сервера — pglite

Миграции и сервисы Core гоняются на PostgreSQL 17 в WASM (`@electric-sql/pglite`):
цепочка миграций репо применяется целиком, сервисы (`PartsService`, `PartCountService`,
`CoffeeLedgerService`, `StockService`, `VendingService`…) строятся на `drizzle(pglite)`
и проверяются сценариями спеки vendhub-parts (У1–У6).

Зависимость не в lockfile намеренно (тяжёлый WASM-пакет): ставится отдельно.

```bash
# из корня репо, один раз
mkdir -p ~/pgtest && (cd ~/pgtest && npm i --no-save @electric-sql/pglite@0.3)
pnpm --filter @mydon/db build && pnpm --filter @mydon/core build

# миграции целиком (или --upto 83)
NODE_PATH=~/pgtest/node_modules node tools/pglite-checks/run-migrations.mjs

# бэкфилл 0083 → 0084 и сценарии У1–У6
for c in check-0084 check-parts-u1 check-parts-u2 check-parts-u3 check-parts-u4 check-parts-u5 check-parts-u6; do
  NODE_PATH=~/pgtest/node_modules node tools/pglite-checks/$c.mjs
done
```

Каждый сценарий печатает одну строку `✔` или падает assert'ом с диффом. Сценарии
дополняют юнит-тесты пакетов (те — на заглушках) и дымовой прогон `tools/smoke-core.mjs`
(тот — на живом Postgres с поднятым Core).
