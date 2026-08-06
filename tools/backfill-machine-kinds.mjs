#!/usr/bin/env node
/**
 * Разметить вид уже заведённых автоматов (WAREHOUSE_SPEC §4.0, PR 0).
 *
 * Одноразовый: после него вид живёт в карточке `machine_card`, задаётся при
 * заведении и правится владельцем. Скрипт нужен ровно затем, чтобы 29
 * существующих автоматов не пришлось размечать руками.
 *
 * Правило разметки — тот самый инференс, который до сих пор жил в коде:
 * привязан к кофейной точке → `coffee`. Здесь он применяется ОДИН РАЗ и
 * записывается как факт; в Core его больше нет.
 *
 * Всё, что не привязано, помечается `other` = «не размечен», а НЕ `snack`.
 * Угадывать по названию («· снек») — тот же инференс с другой стороны:
 * имя карточки заводили для чтения человеком, а не для классификации.
 * Владелец разметит эти автоматы сам, их единицы.
 *
 * Запуск НА СЕРВЕРЕ:
 *   cd /opt/mydon-app
 *   docker compose -f deploy/docker-compose.yml --env-file .env \
 *     exec -T mydon-core node tools/backfill-machine-kinds.mjs --dry-run
 *   ... без --dry-run — записать
 *
 * Идемпотентно: уже размеченные автоматы пропускаются, решение владельца
 * повторный прогон не перетирает.
 */
const CORE = process.env.CORE_API_URL ?? "http://127.0.0.1:3001";
const TOKEN = process.env.SERVICE_TOKEN ?? "";
const DRY = process.argv.includes("--dry-run");

if (!TOKEN && !DRY) {
  console.error("SERVICE_TOKEN не задан — мутации Core закрыты без него (возьми из .env).");
  process.exit(1);
}

async function get(path) {
  const res = await fetch(`${CORE}${path}`, { headers: { "x-service-token": TOKEN } });
  if (!res.ok) throw new Error(`GET ${path} → ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

async function main() {
  const [machines, locations, cards] = await Promise.all([
    get("/entities?domain=vendhub&type=machine"),
    get("/coffee/locations"),
    get("/entities/machine-cards/all"),
  ]);

  const isCoffee = new Set(locations.map((l) => l.entityId).filter(Boolean));
  const marked = new Set(cards.map((c) => c.entityId));
  const todo = machines
    .filter((m) => !marked.has(m.id))
    .map((m) => ({ ...m, kind: isCoffee.has(m.id) ? "coffee" : "other" }));

  const coffee = todo.filter((m) => m.kind === "coffee").length;
  console.log(`Автоматов: ${machines.length}, уже размечено: ${marked.size}`);
  console.log(`К разметке: ${todo.length} — кофейных ${coffee}, «не размечен» ${todo.length - coffee}`);

  if (todo.length === 0) {
    console.log("Размечать нечего.");
    return;
  }
  if (DRY) {
    for (const m of todo) console.log(`  · ${m.name} → ${m.kind}`);
    console.log("Пробный прогон — ничего не записано.");
    console.log("Автоматы со значением other владелец размечает сам:");
    console.log("  панель → карточка автомата, либо PATCH /entities/<id>/machine-kind");
    return;
  }

  let ok = 0;
  for (const m of todo) {
    const res = await fetch(`${CORE}/entities/${m.id}/machine-kind`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "x-service-token": TOKEN },
      body: JSON.stringify({ kind: m.kind, actor: "tool:backfill-machine-kinds" }),
    });
    if (!res.ok) {
      throw new Error(`${m.name}: Core ответил ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
    ok += 1;
  }
  console.log(`Готово: размечено ${ok}.`);
  console.log(
    `Из них «не размечен» ${todo.length - coffee} — их надо разобрать вручную, ` +
      "иначе кофейные нормативы им не достанутся.",
  );
}

main().catch((err) => {
  console.error(String(err));
  process.exit(1);
});
