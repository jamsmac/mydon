#!/usr/bin/env node
/**
 * Завести узлы по составу кофейного автомата на весь парк (R-PU-3).
 *
 * Слово владельца 04.09.2026: в каждом кофейном аппарате 4 миксера, 1 гриндер,
 * 1 варка, 8 бункеров (+ фильтр воды по нормативу). Карточки заводит система,
 * номера присваивает сама (M-001…, H-<набор>-<позиция> у бункеров с известным
 * набором), а сотрудники наклеивают их и подтверждают в очереди «Наклеить
 * номер» (панель /parts/queue, бот «🔢 Номера узлов»).
 *
 * Запуск НА СЕРВЕРЕ (Core слушает локально, мутации закрыты сервис-токеном):
 *   cd /opt/mydon-app
 *   docker compose -f deploy/docker-compose.yml --env-file .env \
 *     exec -T mydon-core node tools/provision-parts.mjs --dry-run
 *   ... node tools/provision-parts.mjs                 # завести
 *   ... node tools/provision-parts.mjs --machine=<uuid> # один автомат
 *
 * Идемпотентно: повторный прогон ничего не дублирует (ключ — автомат + вид +
 * слот). Состав правится в панели: Система · Настройки · PARTS_TEMPLATE_COFFEE.
 */
const CORE = process.env.CORE_API_URL ?? "http://127.0.0.1:3001";
const TOKEN = process.env.SERVICE_TOKEN ?? "";
const args = process.argv.slice(2);
const DRY = args.includes("--dry-run");
const machineIds = args.filter((a) => a.startsWith("--machine=")).map((a) => a.slice("--machine=".length)).filter(Boolean);

if (!TOKEN && !DRY) {
  console.error("SERVICE_TOKEN не задан — мутации Core закрыты без него (возьми из .env).");
  process.exit(1);
}

async function main() {
  const res = await fetch(`${CORE}/parts/provision`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-service-token": TOKEN },
    body: JSON.stringify({ dryRun: DRY, ...(machineIds.length ? { machineIds } : {}), actorRef: "owner" }),
  });
  if (!res.ok) throw new Error(`POST /parts/provision → ${res.status}: ${(await res.text()).slice(0, 400)}`);
  const report = await res.json();
  console.log(`Состав: ${report.template.map((t) => `${t.kind}×${t.count}`).join(", ")}`);
  for (const m of report.machines) {
    const numbered = m.numbered ?? [];
    const head =
      `${m.machineName}: стоит ${m.existing}, ${DRY ? "заведём" : "заведено"} ${m.created.length}` +
      (numbered.length ? `, без номера ${numbered.length} — ${DRY ? "присвоим" : "присвоено"}` : "");
    const busy = m.created.length + numbered.length;
    console.log(busy ? `\n${head}${m.hopperSetsFound ? ` (наборов бункеров найдено ${m.hopperSetsFound})` : ""}` : head);
    for (const c of m.created) console.log(`  + ${c}`);
    for (const n of numbered) console.log(`  № ${n}`);
  }
  console.log("");
  console.log(
    DRY
      ? `Предпросмотр: автоматов ${report.machines.length}, узлов к заведению ${report.createdTotal}, номеров к присвоению ${report.numberedTotal ?? 0}. Ничего не записано.`
      : `Готово: автоматов ${report.machines.length}, заведено узлов ${report.createdTotal}, присвоено номеров ${report.numberedTotal ?? 0}. Дальше — очередь «Наклеить номер» в панели /parts/queue.`,
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
