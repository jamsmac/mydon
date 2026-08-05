#!/usr/bin/env node
/**
 * Собрать сид договоров GLOBERENT напрямую из Didox по API.
 *
 * ЗАЧЕМ. Прежний путь — человек качает реестр из кабинета, парсер угадывает
 * номер договора и покупателя из текстовых колонок. В API это отдельные поля
 * (`contract_number`, `contract_date`, `partnerTin`), угадывать нечего.
 * Оба пути живут рядом: выгрузка остаётся, пока API не подключён.
 *
 * ДОСТУП. Нужны два токена, оба из окружения (.env на сервере):
 *   DIDOX_PARTNER_TOKEN — партнёрский, выдаёт аккаунт-менеджер Didox
 *                         (t.me/Didox_account), НЕ личный кабинет;
 *   DIDOX_TAX_ID + DIDOX_PASSWORD — вход пользователя (токен живёт 6 часов).
 *
 * Связки счетов с договорами берутся тем же правилом, что и для выгрузки
 * (@mydon/connectors, linkInvoicesToContracts): счёт привязывается только к
 * договору своего ИНН, при неоднозначности — не привязывается вовсе, и это
 * попадает в отчёт, а не в тишину.
 *
 * Запуск из корня репозитория:
 *   node tools/fetch-didox.mjs                       # отчёт, ничего не пишет
 *   node tools/fetch-didox.mjs --write               # записать сид
 *   node tools/fetch-didox.mjs --from 2023-01-01     # с даты документа
 *
 * Перед запуском собрать коннекторы: pnpm --filter @mydon/connectors build
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  contractorsFromDocuments,
  contractsFromDocuments,
  didoxFromEnv,
  linkInvoicesToContracts,
} from "../packages/connectors/dist/didox.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA = path.join(ROOT, "data/globerent");
const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const WRITE = argv.includes("--write");

if (!process.env.DIDOX_PARTNER_TOKEN) {
  console.error(
    "Нет DIDOX_PARTNER_TOKEN. Партнёрский токен выдаёт аккаунт-менеджер Didox\n" +
      "(t.me/Didox_account, +998 50 122 05 18), в личном кабинете его нет.\n" +
      "Положите токен в .env вместе с DIDOX_TAX_ID и DIDOX_PASSWORD.",
  );
  process.exit(1);
}

const client = didoxFromEnv();
const query = { owner: 1 };
const from = flag("--from");
const to = flag("--to");
if (from !== undefined) query.docDateFromCreated = from;
if (to !== undefined) query.docDateToCreated = to;

console.log("Читаю документы Didox…");
const docs = await client.allDocuments(query);
console.log(`  документов получено: ${docs.length}`);

const { contracts, skipped } = contractsFromDocuments(docs);
const contractors = contractorsFromDocuments(docs);
console.log(`  договоров собрано: ${contracts.length}`);
console.log(`  контрагентов: ${contractors.length}`);
if (skipped.length > 0) console.log(`  документов не разобрано: ${skipped.length}`);

// Счета книги владельца — источник связок с деньгами. Их номера («СФ 2024-30»)
// внутренние, в Didox их нет, поэтому мост строится здесь.
const bookPath = path.join(DATA, "workbook-2026-08-04.json");
let linked = { byContract: {}, unlinked: [] };
if (fs.existsSync(bookPath)) {
  const book = JSON.parse(fs.readFileSync(bookPath, "utf8"));
  const invoices = (book.invoices ?? []).map((i) => ({
    ref: i.ref,
    inn: i.attrs?.["ИНН"] ?? null,
    contractRef: i.attrs?.["договор"] ?? null,
  }));
  linked = linkInvoicesToContracts(contracts, invoices);
  for (const c of contracts) {
    const refs = linked.byContract[c.contractNo];
    if (refs !== undefined && refs.length > 0) c.flowDocNos = refs;
  }
  const n = Object.values(linked.byContract).reduce((a, l) => a + l.length, 0);
  console.log(`  приходов связано с договорами: ${n}`);
  console.log(`  счетов без договора (нужен разбор глазами): ${linked.unlinked.length}`);
} else {
  console.log("  книги владельца рядом нет — связки с приходами не строятся");
}

const day = (flag("--as-of") ?? new Date().toISOString()).slice(0, 10);
const out = flag("--out") ?? path.join(DATA, `didox-${day}.json`);
const seed = {
  source: `Didox: API /v2/documents, выгрузка ${day}`,
  contractors,
  contracts,
};

if (WRITE) {
  fs.writeFileSync(out, `${JSON.stringify(seed, null, 2)}\n`);
  console.log(`\nЗаписано: ${path.relative(ROOT, out)}`);
  console.log("Дальше: node tools/import-globerent-registry.mjs");
} else {
  console.log("\nЭто отчёт. Чтобы записать сид — запустите с --write.");
}
