#!/usr/bin/env node
/**
 * Дымовой прогон Core против НАСТОЯЩЕГО Postgres.
 *
 * ЗАЧЕМ. Между «тесты зелёные» и «работает» есть непроверенная зона: весь
 * сырой SQL в сервисах. Заглушка БД в юнит-тестах не исполняет запросы — она
 * возвращает заготовленный ответ на `.delete().where().returning()`, поэтому
 * зеленеет на любом синтаксисе. Шаг CI «Migrations (real postgres)» проверяет
 * только миграции.
 *
 * 07.08.2026 в эту зону зашли дважды за день:
 *   · regexp-нормализация серийника (#116) — прогнали руками до мёржа, пронесло;
 *   · `coilId <> all(${массив})` в уборке слотов (#122) — не прогнали, и прод
 *     ответил 500 на приём слотов: Drizzle разворачивает JS-массив в список
 *     плейсхолдеров, Postgres требует массив («op ANY/ALL (array) requires
 *     array on right side»).
 *
 * ЧТО ДЕЛАЕТ. Поднимает Core, дожидается health и дёргает набор путей, каждый
 * из которых доходит до базы. Цель не в проверке бизнес-логики — её проверяют
 * юнит-тесты, — а в том, чтобы КАЖДЫЙ запрос был выполнен настоящим Postgres
 * хотя бы раз. Ошибка синтаксиса или типов вылезет здесь, а не на проде.
 *
 * Запуск: DATABASE_URL=… SERVICE_TOKEN=… node tools/smoke-core.mjs
 */
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const PORT = process.env.SMOKE_PORT ?? "3099";
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = process.env.SERVICE_TOKEN ?? "smoke-token";
const СТАРТ_ТАЙМАУТ_МС = 60_000;

/** Пути, каждый из которых доходит до базы. Читающие — безопасны и идемпотентны. */
const ЧТЕНИЕ = [
  "/health",
  "/entities?domain=vendhub&type=machine",
  "/entities/machine-cards/all",
  "/maintenance/due",
  "/maintenance/plans",
  "/maintenance/plans?includeInactive=1",
  "/maintenance/log",
  "/vending/machines",
  "/vending/deficit",
  "/vending/sync",
  "/coffee/locations",
  "/coffee/placements",
  "/tasks",
  "/people",
  "/approvals",
];

/**
 * Записи, ради которых всё и затевалось: они несут сырой SQL.
 *
 * `/vending/ingest` — тот самый путь, где жила уборка слотов с `<> all(...)`.
 * Отправляем два слота, потом один: второй вызов ОБЯЗАН выполнить DELETE
 * лишнего, то есть пройти по ветке, которая уронила прод.
 */
const ЗАПИСЬ = [
  {
    имя: "приём слотов (первый снимок)",
    path: "/vending/ingest",
    body: {
      machines: [
        {
          serial: "SMOKE-0001",
          slots: [
            { coilId: "1", product: "Smoke A", capacity: 5, quantity: 5 },
            { coilId: "2", product: "Smoke B", capacity: 5, quantity: 4 },
          ],
        },
      ],
    },
  },
  {
    имя: "приём слотов (слот исчез → уборка зеркала)",
    path: "/vending/ingest",
    body: {
      machines: [
        { serial: "SMOKE-0001", slots: [{ coilId: "1", product: "Smoke A", capacity: 5, quantity: 3 }] },
      ],
    },
    проверить: (ответ) => {
      if (ответ.pruned !== 1) {
        throw new Error(`уборка не сработала: pruned=${ответ.pruned}, ожидали 1`);
      }
    },
  },
];

async function ждатьЗдоровье(proc) {
  const дедлайн = Date.now() + СТАРТ_ТАЙМАУТ_МС;
  while (Date.now() < дедлайн) {
    if (proc.exitCode !== null) throw new Error(`Core умер на старте (код ${proc.exitCode})`);
    try {
      const r = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(2000) });
      if (r.ok) return;
    } catch {
      // ещё не поднялся — это ожидаемо
    }
    await sleep(500);
  }
  throw new Error(`Core не поднялся за ${СТАРТ_ТАЙМАУТ_МС / 1000} с`);
}

const провалы = [];

async function проверитьЧтение(path) {
  const r = await fetch(BASE + path, { signal: AbortSignal.timeout(20_000) });
  const текст = await r.text();
  if (!r.ok) {
    провалы.push(`GET ${path} → ${r.status}: ${текст.slice(0, 300)}`);
    return;
  }
  console.log(`  ok  GET ${path}`);
}

async function проверитьЗапись(шаг) {
  const r = await fetch(BASE + шаг.path, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-service-token": TOKEN },
    body: JSON.stringify(шаг.body),
    signal: AbortSignal.timeout(20_000),
  });
  const текст = await r.text();
  if (!r.ok) {
    провалы.push(`POST ${шаг.path} (${шаг.имя}) → ${r.status}: ${текст.slice(0, 300)}`);
    return;
  }
  if (шаг.проверить) {
    try {
      шаг.проверить(JSON.parse(текст));
    } catch (e) {
      провалы.push(`POST ${шаг.path} (${шаг.имя}): ${e.message}`);
      return;
    }
  }
  console.log(`  ok  POST ${шаг.path} — ${шаг.имя}`);
}

// Внешние синки на дымовом прогоне гасим ЯВНО.
//
// SalesService и SupplyService включаются наличием STOCK_DATABASE_URL и
// стартуют сразу, не дожидаясь расписания. В CI переменной обычно нет, но
// «обычно нет» — не гарантия: прогон полез бы в чужую базу и стал бы зависеть
// от её доступности. Дымовой тест обязан проверять НАШ код, а не связность.
const env = { ...process.env, PORT, SERVICE_TOKEN: TOKEN, NODE_ENV: "test" };
delete env.STOCK_DATABASE_URL;
delete env.OURVEND_ACCOUNT;
delete env.OURVEND_PASSWORD;

const core = spawn("node", ["apps/core/dist/main.js"], {
  env,
  stdio: ["ignore", "pipe", "pipe"],
});
const логи = [];
core.stdout.on("data", (d) => логи.push(String(d)));
core.stderr.on("data", (d) => логи.push(String(d)));

try {
  await ждатьЗдоровье(core);
  console.log("Core поднялся, идём по путям\n");

  for (const path of ЧТЕНИЕ) await проверитьЧтение(path);
  for (const шаг of ЗАПИСЬ) await проверитьЗапись(шаг);
} catch (e) {
  провалы.push(`старт: ${e.message}`);
} finally {
  core.kill("SIGTERM");
  await sleep(300);
  if (core.exitCode === null) core.kill("SIGKILL");
}

if (провалы.length > 0) {
  console.error(`\nПРОВАЛОВ: ${провалы.length}`);
  for (const p of провалы) console.error(`  ✗ ${p}`);
  console.error("\n--- последние строки лога Core ---");
  console.error(логи.join("").split("\n").slice(-25).join("\n"));
  process.exit(1);
}

console.log(`\nВсё прошло: ${ЧТЕНИЕ.length} чтений, ${ЗАПИСЬ.length} записей.`);
