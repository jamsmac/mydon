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
  flows: { created: 0, skipped: 0, errors: [] },
  contracts: { created: 0, skipped: 0, flowsLinked: 0, updated: 0, deleted: 0, errors: [] },
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
  if (!res.ok)
    throw new Error(
      `Core ответил ${res.status} на own-company: ${(await res.text()).slice(0, 300)}`,
    );
  add(totals.ownCompany, (await res.json()).ownCompany);
}

// Ставки растаможки (ТН ВЭД + БРВ) — через штатные ручки каталога.
// Идемпотентность здесь, по GET-листингу: код+название / значение+дата.
const customsPath = path.join(ROOT, "data/globerent/customs-rates.json");
const customsTotals = { tnved: { created: 0, skipped: 0 }, brv: { created: 0, skipped: 0 } };
if (fs.existsSync(customsPath)) {
  const customs = JSON.parse(fs.readFileSync(customsPath, "utf8"));
  const headers = { "Content-Type": "application/json", "x-service-token": TOKEN };
  const existing = await (await fetch(`${CORE}/catalog/tnved?all=1`)).json();
  const seen = new Set(existing.map((r) => `${r.code}|${r.nameRu}`));
  for (const row of customs.tnved ?? []) {
    if (seen.has(`${row.code}|${row.nameRu}`)) {
      customsTotals.tnved.skipped += 1;
      continue;
    }
    const res = await fetch(`${CORE}/catalog/tnved`, {
      method: "POST",
      headers,
      body: JSON.stringify({ ...row, notes: customs.source }),
    });
    if (!res.ok)
      throw new Error(
        `Core ответил ${res.status} на ТН ВЭД ${row.code}: ${(await res.text()).slice(0, 300)}`,
      );
    customsTotals.tnved.created += 1;
  }
  if (customs.brv) {
    const brvList = await (await fetch(`${CORE}/catalog/brv`)).json();
    const has = brvList.some(
      (b) => Number(b.valueUzs) === customs.brv.valueUzs && b.validFrom === customs.brv.validFrom,
    );
    if (has) customsTotals.brv.skipped += 1;
    else {
      const res = await fetch(`${CORE}/catalog/brv`, {
        method: "PUT",
        headers,
        body: JSON.stringify(customs.brv),
      });
      if (!res.ok)
        throw new Error(`Core ответил ${res.status} на БРВ: ${(await res.text()).slice(0, 300)}`);
      customsTotals.brv.created += 1;
    }
  }
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

// Денежный контур: приход по счетам-фактурам + сервисные расходы.
// Отдельный сид — после машин: продажи привязываются к единицам по VIN.
const flowsPath = path.join(ROOT, "data/globerent/flows-2026-08-04.json");
if (fs.existsSync(flowsPath)) {
  const flowsSeed = JSON.parse(fs.readFileSync(flowsPath, "utf8"));
  for (const batch of chunks(flowsSeed.flows ?? [], 200)) {
    const res = await fetch(`${CORE}/registry-import/globerent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-service-token": TOKEN },
      body: JSON.stringify({ source: flowsSeed.source, flows: batch }),
    });
    if (!res.ok)
      throw new Error(`Core ответил ${res.status} на flows: ${(await res.text()).slice(0, 300)}`);
    add(totals.flows, (await res.json()).flows);
  }
}

// Реестры Didox: недостающие СФ + их приходы, новые контрагенты и договоры
// покупателей. После книги — договоры привязывают приходы (и книжные тоже)
// к contract_id по docNo счетов.
const didoxPath = path.join(ROOT, "data/globerent/didox-2026-08-04.json");
if (fs.existsSync(didoxPath)) {
  const didox = JSON.parse(fs.readFileSync(didoxPath, "utf8"));
  const postDidox = async (payload) => {
    const res = await fetch(`${CORE}/registry-import/globerent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-service-token": TOKEN },
      body: JSON.stringify({ source: didox.source, ...payload }),
    });
    if (!res.ok) {
      throw new Error(`Core ответил ${res.status} на didox: ${(await res.text()).slice(0, 500)}`);
    }
    return res.json();
  };
  for (const batch of chunks(didox.contractors ?? [], 200)) {
    add(totals.contractors, (await postDidox({ contractors: batch })).contractors);
  }
  for (const batch of chunks(didox.invoices ?? [], 150)) {
    add(totals.invoices, (await postDidox({ invoices: batch })).invoices);
  }
  for (const batch of chunks(didox.flows ?? [], 200)) {
    add(totals.flows, (await postDidox({ flows: batch })).flows);
  }
  // contractsFinal на последней партии: Core удалит свои карточки, которых
  // в наборе больше нет (следы прошлой версии разбора выгрузки).
  const contractBatches = chunks(didox.contracts ?? [], 100);
  for (const [i, batch] of contractBatches.entries()) {
    const part = (
      await postDidox({ contracts: batch, contractsFinal: i === contractBatches.length - 1 })
    ).contracts;
    add(totals.contracts, part);
    totals.contracts.flowsLinked += part.flowsLinked ?? 0;
    totals.contracts.updated += part.updated ?? 0;
    totals.contracts.deleted += part.deleted ?? 0;
  }
}

console.log("Импорт книги завершён:");
for (const [k, label] of [
  ["ownCompany", "моя компания"],
  ["contractors", "контрагенты"],
  ["models", "модели"],
  ["invoices", "счета-фактуры"],
  ["units", "машины склада"],
  ["flows", "денежные записи"],
  ["contracts", "договоры (Didox)"],
]) {
  const t = totals[k];
  console.log(`  ${label}: создано ${t.created}, пропущено (уже были) ${t.skipped}`);
  for (const e of t.errors) console.log(`    ⚠ ${e}`);
}
console.log(
  `  договоры: обновлено ${totals.contracts.updated}, удалено устаревших ${totals.contracts.deleted}`,
);
console.log(`  приходов привязано к договорам: ${totals.contracts.flowsLinked}`);
console.log(
  `  ставки ТН ВЭД: создано ${customsTotals.tnved.created}, пропущено ${customsTotals.tnved.skipped}; ` +
    `БРВ: создано ${customsTotals.brv.created}, пропущено ${customsTotals.brv.skipped}`,
);
