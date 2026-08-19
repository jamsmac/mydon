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
  "/maintenance/parts/storage",
  "/vending/machines",
  "/vending/deficit",
  "/vending/sync",
  "/coffee/locations",
  "/coffee/placements",
  "/tasks",
  "/people",
  "/approvals",
  // Предел выборки — параметр, а не зашитое число. Раньше он был зашит, и
  // выборка обрезалась молча: проверка реестра видела первые 500 карточек из
  // 1156 и печатала «расхождений не найдено». Заглушка БД `.limit()` не
  // исполняет, поэтому проверить это можно только против живого Postgres.
  {
    path: "/entities?limit=1",
    проверить: (ответ) => {
      if (!Array.isArray(ответ)) throw new Error("ожидали массив карточек");
      if (ответ.length > 1) throw new Error(`limit=1 вернул ${ответ.length} карточек`);
    },
  },
  { path: "/entities?limit=999999", ждёмОтказ: true },
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
  {
    имя: "приём продаж (привязка автомата по канону серийника)",
    path: "/vending/ingest-sales",
    body: {
      periodStart: "2026-08-01T00:00:00.000Z",
      periodEnd: "2026-08-07T00:00:00.000Z",
      productSales: [{ serial: "SMOKE-0001", product: "Smoke A", quantity: 3 }],
      machineSales: [{ serial: "SMOKE-0001", totalAmount: 15000, totalCount: 3 }],
    },
  },
];

/**
 * Срез Б: место — обычная карточка реестра, аппаратов на нём может быть несколько.
 *
 * Ради этого сценария дымовой прогон и нужен: `linkLocation` — это
 * `and(eq(место), eq(аппарат), isNull(конец))` плюс join размещений с
 * карточками. Заглушка БД в юнит-тестах таких запросов не исполняет, она лишь
 * возвращает заготовленный ответ — и уже дважды зеленела на SQL, который
 * Postgres отвергал.
 */
async function проверитьМеста() {
  const создать = async (type, name) => {
    const r = await fetch(`${BASE}/entities`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-service-token": TOKEN },
      body: JSON.stringify({ domain: "vendhub", type, name }),
      signal: AbortSignal.timeout(20_000),
    });
    const текст = await r.text();
    if (!r.ok) throw new Error(`создание ${type} «${name}» → ${r.status}: ${текст.slice(0, 200)}`);
    return JSON.parse(текст).id;
  };
  const поставить = async (locationId, entityId) => {
    const r = await fetch(`${BASE}/coffee/location-link`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "x-service-token": TOKEN },
      body: JSON.stringify({ locationId, entityId }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!r.ok) throw new Error(`привязка → ${r.status}: ${(await r.text()).slice(0, 200)}`);
  };
  const мест = async () => {
    const r = await fetch(`${BASE}/coffee/locations`, { signal: AbortSignal.timeout(20_000) });
    if (!r.ok) throw new Error(`/coffee/locations → ${r.status}`);
    return JSON.parse(await r.text());
  };

  const place = await создать("location", "Дымовая точка");
  const m1 = await создать("machine", "Дымовой автомат 1");
  const m2 = await создать("machine", "Дымовой автомат 2");

  await поставить(place, m1);
  await поставить(place, m2);
  const после = (await мест()).find((l) => l.id === place);
  if (!после) throw new Error("созданное место не вернулось в /coffee/locations");
  if (после.machines.length !== 2) {
    throw new Error(`на месте ожидали 2 аппарата, вернулось ${после.machines.length}`);
  }

  // Повтор той же привязки период-дубль не открывает.
  await поставить(place, m1);
  const повтор = (await мест()).find((l) => l.id === place);
  if (повтор.machines.length !== 2) {
    throw new Error(`повторная привязка размножила размещения: ${повтор.machines.length}`);
  }

  // Снятие адресуется аппаратом — соседа по месту не трогает.
  const r = await fetch(`${BASE}/coffee/machine-link/${m1}`, {
    method: "DELETE",
    headers: { "x-service-token": TOKEN },
    signal: AbortSignal.timeout(20_000),
  });
  if (!r.ok) throw new Error(`снятие → ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const итог = (await мест()).find((l) => l.id === place);
  if (итог.machines.length !== 1 || итог.machines[0].entityId !== m2) {
    throw new Error(`после снятия ожидали ровно второй аппарат, получили ${JSON.stringify(итог.machines)}`);
  }

  // Уход в ремонт с указанием мастерской. Тот же класс сырого SQL: закрытие
  // открытого периода по `and(eq(аппарат), isNull(конец))` плюс вставка нового.
  const shop = await создать("workshop", "Дымовая мастерская");
  const статус = await fetch(`${BASE}/entities/${m2}/machine-status`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", "x-service-token": TOKEN },
    body: JSON.stringify({ status: "repair", placeId: shop, note: "дымовой прогон" }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!статус.ok) throw new Error(`ремонт → ${статус.status}: ${(await статус.text()).slice(0, 200)}`);
  const пусто = (await мест()).find((l) => l.id === place);
  if (пусто.machines.length !== 0) {
    throw new Error(`уехавший в ремонт всё ещё числится на точке: ${JSON.stringify(пусто.machines)}`);
  }

  // «На складе» требует склада — противоречие должно отвергаться сервером,
  // а не только формой.
  const мимо = await fetch(`${BASE}/entities/${m2}/machine-status`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", "x-service-token": TOKEN },
    body: JSON.stringify({ status: "warehouse", placeId: place }),
    signal: AbortSignal.timeout(20_000),
  });
  if (мимо.ok) throw new Error("«на складе» на точке продаж прошло, а должно было быть отвергнуто");
}

/**
 * Срез В: жизненный цикл узла — установка → занято → снятие в мойку →
 * возврат со склада → история по серийнику.
 *
 * Здесь живёт частичный уникальный индекс `machine_part_open_key`
 * (`where removed_on is null and machine_id is not null`) и парная вставка
 * периодов одной транзакцией — ровно тот SQL, который заглушка юнит-тестов
 * не исполняет.
 */
async function проверитьУзлы() {
  const запрос = async (имя, path, body) => {
    const r = await fetch(`${BASE}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-service-token": TOKEN },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    const текст = await r.text();
    return { ok: r.ok, status: r.status, имя, тело: текст, json: r.ok ? JSON.parse(текст) : null };
  };
  const чтение = async (path) => {
    const r = await fetch(`${BASE}${path}`, { signal: AbortSignal.timeout(20_000) });
    if (!r.ok) throw new Error(`GET ${path} → ${r.status}`);
    return JSON.parse(await r.text());
  };

  const созд = await запрос("автомат", "/entities", {
    domain: "vendhub",
    type: "machine",
    name: `Дымовой автомат узлов ${Date.now()}`,
  });
  if (!созд.ok) throw new Error(`создание автомата → ${созд.status}: ${созд.тело.slice(0, 200)}`);
  const m = созд.json.id;
  const serial = `SMOKE-SN-${Date.now()}`;

  const уст = await запрос("установка", "/maintenance/part-install", {
    machineId: m,
    partKind: "grinder",
    serialNumber: serial,
  });
  if (!уст.ok) throw new Error(`установка узла → ${уст.status}: ${уст.тело.slice(0, 200)}`);
  if (уст.json.installed.location !== "machine") {
    throw new Error(`установленный узел не «на автомате»: ${уст.json.installed.location}`);
  }

  const дубль = await запрос("занятое место", "/maintenance/part-install", {
    machineId: m,
    partKind: "grinder",
  });
  if (дубль.ok) throw new Error("установка на занятое место прошла, а должна была быть отвергнута");

  const снятие = await запрос("снятие", "/maintenance/part-remove", {
    machineId: m,
    partKind: "grinder",
    toLocation: "washing",
  });
  if (!снятие.ok) throw new Error(`снятие узла → ${снятие.status}: ${снятие.тело.slice(0, 200)}`);
  const лежит = снятие.json.stored;
  if (лежит.machineId !== null || лежит.location !== "washing") {
    throw new Error(`снятый узел не в мойке: ${JSON.stringify(лежит)}`);
  }

  const склад = await чтение("/maintenance/parts/storage");
  if (!склад.some((p) => p.id === лежит.id)) {
    throw new Error("снятый узел не вернулся в списке «вне автоматов»");
  }

  const возврат = await запрос("возврат со склада", "/maintenance/part-install", {
    machineId: m,
    partKind: "grinder",
    partId: лежит.id,
  });
  if (!возврат.ok) throw new Error(`возврат узла → ${возврат.status}: ${возврат.тело.slice(0, 200)}`);
  if (возврат.json.installed.serialNumber !== serial) {
    throw new Error("серийник не унаследовался при возврате со склада");
  }

  const история = await чтение(`/maintenance/parts/history?serial=${encodeURIComponent(serial)}`);
  // Три периода: на автомате → в мойке → снова на автомате.
  if (история.length < 3) {
    throw new Error(`история по серийнику неполная: ${история.length} периодов, ожидали ≥ 3`);
  }
}

/**
 * Срез Г: продажи по имени товара — карточка товара зовёт /sales/by-product.
 *
 * Таблицу `sale` наполняет только синк из mydon-stock (STOCK_DATABASE_URL),
 * публичного API записи в неё нет — поэтому проверяется ФОРМА ответа и то,
 * что SQL (eq по тексту + группировка + join имён) исполняется живым
 * Postgres, а не количество строк.
 */
async function проверитьПродажиТовара() {
  const r = await fetch(`${BASE}/sales/by-product?name=${encodeURIComponent("Smoke A")}&days=365`, {
    signal: AbortSignal.timeout(20_000),
  });
  if (!r.ok) throw new Error(`/sales/by-product → ${r.status}`);
  const данные = JSON.parse(await r.text());
  if (typeof данные?.total?.qty !== "number" || typeof данные?.total?.amount !== "number") {
    throw new Error(`нет сводки total: ${JSON.stringify(данные).slice(0, 120)}`);
  }
  if (!Array.isArray(данные.machines)) throw new Error("нет разбивки по автоматам");
}

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

async function проверитьЧтение(шаг) {
  const path = typeof шаг === "string" ? шаг : шаг.path;
  const r = await fetch(BASE + path, { signal: AbortSignal.timeout(20_000) });
  const текст = await r.text();
  // Некоторые пути обязаны ОТКАЗАТЬ: предел выше максимума — не «поправим
  // молча», а ошибка ввода. Молчаливая поправка вернула бы 5000 там, где
  // просили миллион, и вызывающий решил бы, что видит всё.
  if (typeof шаг !== "string" && шаг.ждёмОтказ) {
    if (r.ok) провалы.push(`GET ${path} → ${r.status}, а ожидали отказ`);
    else console.log(`  ok  GET ${path} — отвергнут, как и надо`);
    return;
  }
  if (!r.ok) {
    провалы.push(`GET ${path} → ${r.status}: ${текст.slice(0, 300)}`);
    return;
  }
  if (typeof шаг !== "string" && шаг.проверить) {
    try {
      шаг.проверить(JSON.parse(текст));
    } catch (e) {
      провалы.push(`GET ${path}: ${e.message}`);
      return;
    }
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

  try {
    await проверитьМеста();
    console.log("  ok  сценарий: место реестра, два аппарата на нём, снятие одного");
  } catch (e) {
    провалы.push(`места: ${e.message}`);
  }

  try {
    await проверитьУзлы();
    console.log("  ok  сценарий: узел — установка, занято, мойка, возврат, история по серийнику");
  } catch (e) {
    провалы.push(`узлы: ${e.message}`);
  }

  try {
    await проверитьПродажиТовара();
    console.log("  ok  сценарий: продажи товара по имени карточки");
  } catch (e) {
    провалы.push(`продажи товара: ${e.message}`);
  }
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

console.log(`\nВсё прошло: ${ЧТЕНИЕ.length} чтений, ${ЗАПИСЬ.length} записей, 3 сценария.`);
