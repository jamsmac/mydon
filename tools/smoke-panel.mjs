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
import { setTimeout as sleep } from "node:timers/promises";

const PORT = process.env.SMOKE_PANEL_PORT ?? "3098";
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

async function проверить({ path, должно }) {
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
