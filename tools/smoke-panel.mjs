#!/usr/bin/env node
/**
 * Дымовой прогон ПАНЕЛИ: страницы должны отдаваться, а не падать в 500.
 *
 * ЗАЧЕМ. `next build` не отрисовывает страницы, объявленные `force-dynamic`, —
 * он их только компилирует. Значит целый класс ошибок сборка не видит в
 * принципе, а типы не видят тем более:
 *
 *   · 08.08.2026 — `/places` падала в 500 на живом запросе: Leaflet трогает
 *     `window` при вычислении модуля, а `"use client"` серверный рендер не
 *     отменяет. Лечится `next/dynamic` с `ssr: false` — образец в панели уже
 *     был (`map-panel.tsx`), но новая форма его не повторила;
 *   · раньше — несуществующие CSS-классы: строка в `className` компилятору
 *     безразлична, экран просто выходил без вёрстки.
 *
 * ЧТО ДЕЛАЕТ. Поднимает собранную панель против УЖЕ РАБОТАЮЩЕГО Core и
 * дёргает страницы. Проверяем не только код ответа: 200 с пустым телом или с
 * экраном ошибки — тоже провал, поэтому у каждой страницы есть слово, которое
 * обязано в ней встретиться.
 *
 * Запуск: CORE_API_URL=… node tools/smoke-panel.mjs
 */
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";

async function свободныйПорт() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : null;
      server.close((error) => {
        if (error) reject(error);
        else if (port === null) reject(new Error("Не удалось выбрать свободный порт панели"));
        else resolve(String(port));
      });
    });
  });
}

const PORT = process.env.SMOKE_PANEL_PORT ?? (await свободныйПорт());
const BASE = `http://127.0.0.1:${PORT}`;
const СТАРТ_ТАЙМАУТ_МС = 90_000;

/**
 * Страницы и слово-опознаватель.
 *
 * Слово должно быть из САМОЙ страницы, а не из общего каркаса: иначе проверка
 * пройдёт и на экране ошибки, у которого шапка и меню на месте.
 */
const СТРАНИЦЫ = [
  { path: "/places", должно: "Новое место" },
  // Единственный вход в рабочие места с телефона: сайдбар скрыт ниже 900 px,
  // а в нижнюю панель направления не попадают вовсе.
  { path: "/mydon", должно: "Направления" },
  { path: "/domain/vendhub", должно: "VendHub" },
  { path: "/maintenance", должно: "Обслуживание" },
  { path: "/tasks", должно: "Задачи" },
  // Дефолт группы задан явно (`NavGroup.defaultLeaf`), а не «первым листом с
  // ненулевым счётчиком»: раньше точку входа выбирали ДАННЫЕ, и достаточно
  // было завести первую запись в пустом листе, чтобы вход молча переехал.
  // Слово берём из самого листа, а не из каркаса.
  { path: "/domain/vendhub?tab=reports", должно: "По источникам" },
  { path: "/domain/vendhub?tab=settings", должно: "Автоматы" },
  // «Себестоимость» раньше молча открывала «По источникам»: у листа не было
  // типа, адрес строился по подписи, резолвер его не находил.
  { path: "/domain/vendhub?tab=reports:cost", должно: "Себестоимость" },
  // Вкладка «⚙ Настройки» — новый ключ `system`. Без собственной ветки
  // рендера она открылась бы ПУСТОЙ: ряд её показывает, содержимого нет.
  { path: "/domain/vendhub?tab=system", должно: "Настройки направления" },
  // «Полевая работа» впервые получила второй уровень: раньше три
  // полноразмерные панели-формы лежали простынёй на одной вкладке, и
  // навигации внутри не было вовсе — только скролл. Проверяем, что пять
  // адресов открывают РАЗНОЕ, а не один и тот же верх страницы.
  { path: "/domain/vendhub?tab=service", должно: "Полевая работа" },
  { path: "/domain/vendhub?tab=service:coffee", должно: "Кофе" },
  { path: "/domain/vendhub?tab=service:snack", должно: "Снек" },
  { path: "/domain/vendhub?tab=service:collection", должно: "Инкассация" },
  { path: "/domain/vendhub?tab=service:machine_stock", должно: "Остатки" },
  // «Приход» переехал в отчёты; мастер импорта стал кнопкой внутри него.
  // Проверяем и то, что лист открывается, и то, что мастер на месте.
  { path: "/domain/vendhub?tab=reports:purchase", должно: "Импорт истории закупок" },
  // Срез П5a: «что купить» — маршрут, купить/склад/убрано, слоты, кнопка
  // «Оформить закуп». Число совпадает с ботом — считает одно и то же ядро.
  { path: "/domain/vendhub?tab=reports:buy_plan", должно: "План закупа" },
  // Срез П4: лист «Усушка» — детектор заливок + недостача по дням без заливок.
  { path: "/domain/vendhub?tab=reports:shrinkage", должно: "Усушка" },
  // «Хвосты» (R-H-5): лист «Журнал заливок» — мёртвый клиент `vendingRefillEvents`
  // получает потребителя. Слово берём из содержимого листа, а не из чипа
  // навигации: чип рисуется на КАЖДОМ листе группы «Отчёты».
  { path: "/domain/vendhub?tab=reports:refill_events", должно: "Журнал заливок" },
  // Срез П5b: три листа аналитики снек-контура. Слово берём из содержимого
  // листа, а не из чипа навигации: чипы группы рисуются на КАЖДОМ её листе,
  // и проверка по подписи прошла бы даже на чужом отчёте.
  { path: "/domain/vendhub?tab=reports:margin", должно: "Маржа по проданному" },
  { path: "/domain/vendhub?tab=reports:dead_stock", должно: "без движения" },
  { path: "/domain/vendhub?tab=reports:prices", должно: "Витрина против эталона" },
  // Срез П5a: блок / исключение из закупки / фикс-количество по товару.
  { path: "/domain/vendhub?tab=settings:purchase_rules", должно: "Правила закупа" },
  // Слияния Номенклатуры: 14 листьев свелись к 8. Пять фискальных
  // справочников (62 записи, ноль правок за 25 дней) — один хаб.
  { path: "/domain/vendhub?tab=settings:refs", должно: "Классификатор" },
  // Старые адреса слитых листьев обязаны приводить туда же, а не в никуда.
  { path: "/domain/vendhub?tab=settings:ikpu", редиректНа: "settings:refs" },
  { path: "/domain/vendhub?tab=settings:recipe", редиректНа: "settings:product" },
  // Переезды листьев из предыдущих шагов — тем же способом.
  { path: "/domain/vendhub?tab=reports:collection", редиректНа: "service:collection" },
  { path: "/domain/vendhub?tab=settings:purchase", редиректНа: "reports:purchase" },
];

const провалы = [];

async function ждатьПанель(proc) {
  const дедлайн = Date.now() + СТАРТ_ТАЙМАУТ_МС;
  while (Date.now() < дедлайн) {
    if (proc.exitCode !== null) throw new Error(`панель умерла на старте (код ${proc.exitCode})`);
    try {
      const r = await fetch(BASE + "/", { signal: AbortSignal.timeout(5000) });
      if (r.status < 500) return;
    } catch {
      // ещё не поднялась
    }
    await sleep(700);
  }
  throw new Error(`панель не поднялась за ${СТАРТ_ТАЙМАУТ_МС / 1000} с`);
}

/**
 * `должно` — слово с самой страницы. `редиректНа` — адрес, куда страница
 * обязана увести.
 *
 * ПОЧЕМУ РЕДИРЕКТ ПРОВЕРЯЕТСЯ ОТДЕЛЬНО. Страница направления асинхронная и
 * стримится, поэтому `redirect()` уезжает ВНУТРЬ потока: ответ приходит с
 * кодом 200 и оболочкой, а не с 307. Браузер такой переход выполняет, а
 * обычный `fetch` — нет, и проверка «есть ли слово с целевой страницы»
 * провалилась бы на исправном коде. Поэтому ищем в теле сам факт перехода и
 * его цель — так проверка ловит именно то, что нужно: редирект СРАБОТАЛ и
 * ведёт КУДА НАДО.
 */
async function проверить({ path, должно, редиректНа }) {
  let r;
  try {
    r = await fetch(BASE + path, { signal: AbortSignal.timeout(60_000) });
  } catch (e) {
    провалы.push(`GET ${path}: ${e.message}`);
    return;
  }
  const html = await r.text();
  if (!r.ok) {
    провалы.push(`GET ${path} → ${r.status}`);
    return;
  }
  if (редиректНа) {
    const цель = encodeURIComponent(редиректНа);
    if (!html.includes("NEXT_REDIRECT")) {
      провалы.push(`GET ${path} → 200, но перехода нет вовсе (ожидался на «${редиректНа}»)`);
    } else if (!html.includes(цель)) {
      провалы.push(`GET ${path} → переход есть, но не на «${редиректНа}»`);
    }
    return;
  }
  if (!html.includes(должно)) {
    провалы.push(`GET ${path} → 200, но на странице нет «${должно}» (${html.length} байт)`);
    return;
  }
  console.log(`  ok  GET ${path}`);
}

// Запускаем бинарник напрямую, а не через `npx`: лишний процесс-посредник
// переживал снятие, и его дети оставались висеть.
//
// `detached: true` даёт свою группу процессов — снимаем её целиком, иначе
// сервер Next остаётся жить: он форкает рабочие процессы, и убийство только
// родителя оставляет сирот.
const panel = spawn("node_modules/.bin/next", ["start", "-p", PORT], {
  cwd: "apps/cc",
  env: { ...process.env, PORT },
  stdio: ["ignore", "pipe", "pipe"],
  detached: true,
});
const логи = [];
panel.stdout.on("data", (d) => логи.push(String(d)));
panel.stderr.on("data", (d) => логи.push(String(d)));

try {
  await ждатьПанель(panel);
  console.log("Панель поднялась, идём по страницам\n");
  for (const с of СТРАНИЦЫ) await проверить(с);
} catch (e) {
  провалы.push(`старт: ${e.message}`);
} finally {
  снятьГруппу("SIGTERM");
  await sleep(500);
  if (panel.exitCode === null) снятьГруппу("SIGKILL");
}

function снятьГруппу(сигнал) {
  try {
    // Минус перед pid — вся группа, а не один процесс.
    process.kill(-panel.pid, сигнал);
  } catch {
    try {
      panel.kill(сигнал);
    } catch {
      // уже умер — это и требовалось
    }
  }
}

if (провалы.length > 0) {
  console.error(`\nПРОВАЛОВ: ${провалы.length}`);
  for (const p of провалы) console.error(`  ✗ ${p}`);
  console.error("\n--- последние строки лога панели ---");
  console.error(логи.join("").split("\n").slice(-30).join("\n"));
  process.exit(1);
}

console.log(`\nВсё прошло: ${СТРАНИЦЫ.length} страниц.`);
