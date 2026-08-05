#!/usr/bin/env node
/**
 * Снять чужие связки «приход → договор» в базе GLOBERENT.
 *
 * ЗАЧЕМ. Приход одной компании, стоящий на договоре другой, — это неверная
 * дебиторка сразу у обоих: у одного долг из воздуха, у второго закрытый.
 * Новые такие связки Core больше не ставит (запрет живёт в WHERE привязки),
 * но проставленные прошлым разбором остались в базе. Импорт про них говорит,
 * а снять их молча не может: руками владельца могла быть проставлена любая.
 *
 * ПО УМОЛЧАНИЮ НИЧЕГО НЕ ПИШЕТ: показывает отчёт с обеими сторонами и суммой
 * и выходит. Запись — только с флагом --write.
 *
 * Отвязка не удаляет деньги: приход остаётся, у него лишь пропадает договор.
 * Следующий импорт поставит его на верный договор сам — привязка ищет ровно
 * записи с пустым contract_id.
 *
 * Запуск НА СЕРВЕРЕ (Core слушает локально):
 *   cd /opt/mydon-app
 *   docker compose -f deploy/docker-compose.yml --env-file .env \
 *     exec -T mydon-core node tools/unlink-foreign-contracts.mjs
 *
 *   ... --write                       # снять все связки из отчёта
 *   ... --only "СФ 2026-83,СФ 2026-10" --write   # снять только названные
 */
const CORE = process.env.CORE_API_URL ?? "http://127.0.0.1:3001";
const TOKEN = process.env.SERVICE_TOKEN ?? "";
const WRITE = process.argv.includes("--write");

const onlyArg = process.argv.indexOf("--only");
const only =
  onlyArg === -1
    ? null
    : new Set(
        (process.argv[onlyArg + 1] ?? "")
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s.length > 0),
      );
if (only !== null && only.size === 0) {
  console.error("--only без списка номеров: перечислите docNo через запятую.");
  process.exit(1);
}

const money = (v) => `${new Intl.NumberFormat("ru-RU").format(Math.round(Number(v) || 0))} сум`;

/** «1 связка», «2 связки», «6 связок» — отчёт читает человек, а не парсер. */
const plural = (n, one, few, many) => {
  const mod100 = n % 100;
  const mod10 = n % 10;
  if (mod100 >= 11 && mod100 <= 14) return many;
  if (mod10 === 1) return one;
  if (mod10 >= 2 && mod10 <= 4) return few;
  return many;
};
const links_ = (n) => `${n} ${plural(n, "связка", "связки", "связок")}`;

const res = await fetch(`${CORE}/registry-import/globerent/foreign-links`);
if (!res.ok) {
  console.error(`Core ответил ${res.status}: ${(await res.text()).slice(0, 300)}`);
  process.exit(1);
}
const all = await res.json();
const links = only === null ? all : all.filter((l) => only.has(l.docNo));

// --only, не нашедший связки, — это опечатка в номере, а не пустая работа:
// молча снять «ничего» здесь хуже, чем остановиться и сказать.
if (only !== null) {
  const missing = [...only].filter((no) => !all.some((l) => l.docNo === no));
  if (missing.length > 0) {
    console.error(`Нет чужой связки по номерам: ${missing.join(", ")}`);
    process.exit(1);
  }
}

if (links.length === 0) {
  console.log("Чужих связок «приход → договор» в базе нет.");
  process.exit(0);
}

console.log(`Чужие связки «приход → договор» в GLOBERENT: ${links.length}`);
let total = 0;
for (const l of links) {
  total += Number(l.amountUzs) || 0;
  const payerInn = l.payer.inn ? ` ИНН ${l.payer.inn}` : "";
  const buyerInn = l.buyer.inn ? ` ИНН ${l.buyer.inn}` : "";
  console.log(`\n  ${l.docNo ?? "(без номера)"} — ${money(l.amountUzs)}, ${l.date}`);
  console.log(`    заплатил:   «${l.payer.name}»${payerInn}`);
  console.log(`    договор:    «${l.contractNo}» от ${l.contractDate}`);
  console.log(`    покупатель: «${l.buyer.name}»${buyerInn}`);
  if (l.purpose) console.log(`    назначение: ${l.purpose}`);
}
console.log(`\nИтого: ${links_(links.length)} на ${money(total)}.`);

if (!WRITE) {
  console.log("\nЭто отчёт. Чтобы снять — запустите с --write.");
  process.exit(0);
}

if (!TOKEN) {
  console.error("\nSERVICE_TOKEN не задан — мутации Core закрыты без него (возьми из .env).");
  process.exit(1);
}

const applied = await fetch(`${CORE}/registry-import/globerent/foreign-links/unlink`, {
  method: "POST",
  headers: { "Content-Type": "application/json", "x-service-token": TOKEN },
  body: JSON.stringify({ flowIds: links.map((l) => l.flowId) }),
});
if (!applied.ok) {
  console.error(`Core ответил ${applied.status}: ${(await applied.text()).slice(0, 300)}`);
  process.exit(1);
}
const result = await applied.json();
console.log(`\nСнято: ${links_(result.unlinked.length)}`);
for (const u of result.unlinked) {
  console.log(`  ${u.docNo ?? "(без номера)"} — снят с «${u.contractNo}»`);
}
if (result.skipped > 0) {
  console.log(`  не тронуто: ${result.skipped} (связка уже снята или не была чужой)`);
}
console.log("\nДеньги на месте — у приходов пропал только договор.");
