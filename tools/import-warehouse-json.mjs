#!/usr/bin/env node
/**
 * Стартовые остатки товаров из `vending-ops/warehouse.json` (У6, R-PU-10):
 * фактическая инвентаризация владельца → пересчёт склада вендинга
 * (`POST /vending/stock`). Двойная запись кладёт то же в леджер по карточкам
 * товаров, поэтому сначала должны существовать карточки:
 *   POST /stock/vending-cards (панель /stock/goods → «Карточки для товаров»).
 *
 * Формат файла: { "as_of": "01.09.2026, …", "stock": { "Snickers": 40, … } }.
 * Дата берётся из `as_of` (дд.мм.гггг) — пересчёт ложится своим числом, и
 * более поздний пересчёт из бота его не откатит.
 *
 * Запуск НА СЕРВЕРЕ:
 *   docker compose -f deploy/docker-compose.yml --env-file .env \
 *     exec -T mydon-core node tools/import-warehouse-json.mjs --file=/opt/warehouse.json --dry-run
 *   … без --dry-run — записать.
 */
import fs from "node:fs";

const CORE = process.env.CORE_API_URL ?? "http://127.0.0.1:3001";
const TOKEN = process.env.SERVICE_TOKEN ?? "";
const args = process.argv.slice(2);
const DRY = args.includes("--dry-run");
const file = args.find((a) => a.startsWith("--file="))?.slice("--file=".length) ?? "warehouse.json";

export function parseWarehouseJson(raw) {
  const data = JSON.parse(raw);
  if (!data || typeof data.stock !== "object") throw new Error("В файле нет поля stock {имя: количество}");
  const m = /(\d{2})\.(\d{2})\.(\d{4})/.exec(String(data.as_of ?? ""));
  const countedAt = m ? `${m[3]}-${m[2]}-${m[1]}T06:00:00+05:00` : null;
  const items = Object.entries(data.stock)
    .map(([product, quantity]) => ({ product: String(product).trim(), quantity: Number(quantity) }))
    .filter((it) => it.product && Number.isInteger(it.quantity) && it.quantity >= 0);
  return { countedAt, items, asOf: data.as_of ?? null };
}

async function main() {
  if (!TOKEN && !DRY) {
    console.error("SERVICE_TOKEN не задан — мутации Core закрыты без него (возьми из .env).");
    process.exit(1);
  }
  const { countedAt, items, asOf } = parseWarehouseJson(fs.readFileSync(file, "utf8"));
  console.log(`Файл: ${file} · инвентаризация: ${asOf ?? "дата не указана"} · позиций: ${items.length} · единиц: ${items.reduce((s, it) => s + it.quantity, 0)}`);
  if (DRY) {
    for (const it of items) console.log(`  ${it.product.padEnd(20)} ${it.quantity}`);
    console.log("--dry-run: ничего не записано.");
    return;
  }
  const res = await fetch(`${CORE}/vending/stock`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-service-token": TOKEN },
    body: JSON.stringify({ items, ...(countedAt ? { countedAt } : {}) }),
  });
  if (!res.ok) throw new Error(`POST /vending/stock → ${res.status}: ${(await res.text()).slice(0, 400)}`);
  const report = await res.json();
  console.log("Записано:", JSON.stringify(report).slice(0, 600));
  const parity = await fetch(`${CORE}/stock/vending-parity`, { headers: { "x-service-token": TOKEN } });
  if (parity.ok) {
    const p = await parity.json();
    console.log(`Сверка с леджером: позиций прайса ${p.products ?? p.rows.length}, без строки в таблице ${p.missingRows ?? 0}, расхождений ${p.mismatched}, без карточки ${p.unlinked}.`);
    if (p.unlinked > 0) console.log("Заведи карточки: панель /stock/goods → «Карточки для товаров», затем повтори импорт.");
  }
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
