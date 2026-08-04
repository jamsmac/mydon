#!/usr/bin/env node
/**
 * Импорт реестра GLOBERENT из сида книги владельца в MYDON Core.
 *
 * Сид: data/globerent/workbook-*.json (сгенерирован из рабочей книги
 * «Реестр 2020–2026»; контрагенты, счета-фактуры, модели, машины склада).
 *
 * Запуск НА СЕРВЕРЕ (Core слушает локально, мутации закрыты сервис-токеном):
 *   cd /opt/mydon-app
 *   docker compose -f deploy/docker-compose.yml --env-file .env \
 *     exec -T mydon-core node tools/import-globerent-registry.mjs
 *
 * Идемпотентно: Core пропускает контрагентов по ИНН, счета по номеру,
 * модели по имени, машины по серийнику — повторный прогон ничего не задвоит.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const seedPath = process.argv[2] ?? path.join(ROOT, "data/globerent/workbook-2026-08-04.json");
const CORE = process.env.CORE_API_URL ?? "http://127.0.0.1:3001";
const TOKEN = process.env.SERVICE_TOKEN ?? "";

if (!TOKEN) {
  console.error("SERVICE_TOKEN не задан — мутации Core закрыты без него (возьми из .env).");
  process.exit(1);
}
if (!fs.existsSync(seedPath)) {
  console.error(`Сид не найден: ${seedPath}`);
  process.exit(1);
}

const seed = JSON.parse(fs.readFileSync(seedPath, "utf8"));

function chunks(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

async function post(payload) {
  const res = await fetch(`${CORE}/registry-import/globerent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-service-token": TOKEN },
    body: JSON.stringify({ source: seed.source, ...payload }),
  });
  if (!res.ok) {
    throw new Error(`Core ответил ${res.status}: ${(await res.text()).slice(0, 500)}`);
  }
  return res.json();
}

function add(total, part) {
  total.created += part.created;
  total.skipped += part.skipped;
  if (part.errors?.length) total.errors.push(...part.errors);
}

const totals = {
  contractors: { created: 0, skipped: 0, errors: [] },
  invoices: { created: 0, skipped: 0, errors: [] },
  models: { created: 0, skipped: 0, errors: [] },
  units: { created: 0, skipped: 0, errors: [] },
  ownCompany: { created: 0, skipped: 0, errors: [] },
};

// Реквизиты своей компании — отдельный сид: они не из книги, а из
// свидетельства о госрегистрации и слов владельца. Нет файла — шаг молчит.
const ownPath = path.join(ROOT, "data/globerent/own-company.json");
if (fs.existsSync(ownPath)) {
  const own = JSON.parse(fs.readFileSync(ownPath, "utf8"));
  const res = await fetch(`${CORE}/registry-import/globerent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-service-token": TOKEN },
    body: JSON.stringify({ source: own.source, ownCompany: own.ownCompany }),
  });
  if (!res.ok) throw new Error(`Core ответил ${res.status} на own-company: ${(await res.text()).slice(0, 300)}`);
  add(totals.ownCompany, (await res.json()).ownCompany);
}

// Порядок обязателен: машины ссылаются на модели и контрагентов по ключам.
for (const batch of chunks(seed.contractors ?? [], 200)) {
  add(totals.contractors, (await post({ contractors: batch })).contractors);
}
for (const batch of chunks(seed.models ?? [], 200)) {
  add(totals.models, (await post({ models: batch })).models);
}
for (const batch of chunks(seed.invoices ?? [], 150)) {
  add(totals.invoices, (await post({ invoices: batch })).invoices);
}
for (const batch of chunks(seed.units ?? [], 100)) {
  add(totals.units, (await post({ units: batch })).units);
}

console.log("Импорт книги завершён:");
for (const [k, label] of [
  ["ownCompany", "моя компания"],
  ["contractors", "контрагенты"],
  ["models", "модели"],
  ["invoices", "счета-фактуры"],
  ["units", "машины склада"],
]) {
  const t = totals[k];
  console.log(`  ${label}: создано ${t.created}, пропущено (уже были) ${t.skipped}`);
  for (const e of t.errors) console.log(`    ⚠ ${e}`);
}
