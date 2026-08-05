#!/usr/bin/env node
/**
 * Пересобрать связки «счёт книги → договор Didox» в сиде GLOBERENT.
 *
 * ЗАЧЕМ. Связки в сиде проставил разовый скрипт, которого в репозитории нет.
 * Часть из них оказалась неверной: счёт одной компании висел на договоре
 * другой — у одного покупателя долг из воздуха, у второго закрытый. Правило
 * связки теперь живёт в коде (@mydon/connectors, linkInvoicesToContracts) и
 * покрыто тестами, а этот инструмент применяет его к сиду.
 *
 * ПО УМОЛЧАНИЮ НИЧЕГО НЕ ПИШЕТ: показывает отчёт и выходит. Запись — только
 * с флагом --write, чтобы правку данных нельзя было сделать случайно.
 *
 * Запуск из корня репозитория:
 *   node tools/relink-globerent-contracts.mjs            # отчёт
 *   node tools/relink-globerent-contracts.mjs --write    # применить
 *
 * Перед запуском собрать коннекторы: pnpm --filter @mydon/connectors build
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { linkInvoicesToContracts } from "../packages/connectors/dist/didox.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA = path.join(ROOT, "data/globerent");
const WRITE = process.argv.includes("--write");

const read = (name) => JSON.parse(fs.readFileSync(path.join(DATA, name), "utf8"));
const didoxPath = path.join(DATA, "didox-2026-08-04.json");
const didox = JSON.parse(fs.readFileSync(didoxPath, "utf8"));
const workbook = read("workbook-2026-08-04.json");
const flowsSeed = read("flows-2026-08-04.json");

// Денежные записи, которые реально существуют: связка на несуществующий
// приход — это не связка, а мусор в сиде.
const knownDocNos = new Set([
  ...(flowsSeed.flows ?? []).map((f) => f.docNo),
  ...(didox.flows ?? []).map((f) => f.docNo),
]);

// Счета обеих книг: своя рабочая книга владельца + то, что нашлось только в Didox.
const invoices = [...(workbook.invoices ?? []), ...(didox.invoices ?? [])].map((i) => ({
  ref: i.ref,
  inn: i.attrs?.["ИНН"] ?? null,
  contractRef: i.attrs?.["договор"] ?? null,
}));

const contracts = didox.contracts ?? [];
const { byContract, unlinked } = linkInvoicesToContracts(contracts, invoices);

// Было — как в сиде сейчас; стало — как даёт правило.
const before = new Map(contracts.map((c) => [c.contractNo, [...(c.flowDocNos ?? [])]]));
let dropped = 0;
let added = 0;
let noMoney = 0;
const crossInn = [];
const byRefAfter = new Map();
for (const [no, refs] of Object.entries(byContract))
  for (const ref of refs) byRefAfter.set(ref, no);

for (const c of contracts) {
  const next = (byContract[c.contractNo] ?? []).filter((ref) => {
    if (knownDocNos.has(ref)) return true;
    noMoney += 1;
    return false;
  });
  const prev = before.get(c.contractNo) ?? [];
  for (const ref of prev) {
    if (!next.includes(ref)) {
      dropped += 1;
      const now = byRefAfter.get(ref);
      // Куда счёт уходил раньше и куда его ставит правило — видно поимённо.
      const to =
        now === undefined
          ? "без договора"
          : now === c.contractNo
            ? "снят: денежной записи с таким номером нет"
            : `«${now}»`;
      crossInn.push(`${ref}: было «${c.contractNo}», ${to}`);
    }
  }
  for (const ref of next) if (!prev.includes(ref)) added += 1;
  if (next.length > 0) c.flowDocNos = next;
  else delete c.flowDocNos;
}

const totalAfter = contracts.reduce((n, c) => n + (c.flowDocNos?.length ?? 0), 0);
const totalBefore = [...before.values()].reduce((n, l) => n + l.length, 0);

console.log("Связки счетов с договорами GLOBERENT:");
console.log(`  было в сиде: ${totalBefore}`);
console.log(`  стало по правилу: ${totalAfter} (снято ${dropped}, добавлено ${added})`);
console.log(`  правило дало связку, но денежной записи нет: ${noMoney}`);
console.log(`  счетов без договора (с причиной): ${unlinked.length}`);

const reasons = new Map();
for (const u of unlinked) {
  const kind = u.reason.replace(/ИНН \d+/, "ИНН …").replace(/«[^»]*»/, "«…»");
  reasons.set(kind, (reasons.get(kind) ?? 0) + 1);
}
for (const [kind, n] of [...reasons].sort((a, b) => b[1] - a[1])) {
  console.log(`    ${n} × ${kind}`);
}
if (crossInn.length > 0) {
  console.log("  снятые связки:");
  for (const line of crossInn) console.log(`    ${line}`);
}

if (WRITE) {
  fs.writeFileSync(didoxPath, `${JSON.stringify(didox, null, 2)}\n`);
  console.log(`\nЗаписано: ${path.relative(ROOT, didoxPath)}`);
} else {
  console.log("\nЭто отчёт. Чтобы применить — запустите с --write.");
}
