# Проверки на pglite — настоящий SQL без сервера

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
