#!/usr/bin/env node
/**
 * Завести стандартные нормативы обслуживания на весь парк автоматов.
 *
 * Числа подтверждены владельцем 06.08.2026 и лежат в
 * `packages/shared/src/maintenance-norms.ts`:
 *   мойка миксера 10 дней · фильтр воды 45 дней · плановое ТО 90 дней.
 *
 * Первые два — только кофейным автоматам (привязанным к кофейной точке).
 * У снек-автомата нет ни миксера, ни фильтра, и такой график краснел бы за
 * работу, которой не существует. Плановое ТО идёт всем.
 *
 * Запуск НА СЕРВЕРЕ (Core слушает локально, мутации закрыты сервис-токеном):
 *   cd /opt/mydon-app
 *   docker compose -f deploy/docker-compose.yml --env-file .env \
 *     exec -T mydon-core node tools/apply-maintenance-norms.mjs
 *
 * Сначала посмотреть, что будет сделано, ничего не меняя:
 *   ... node tools/apply-maintenance-norms.mjs --dry-run
 *
 * Идемпотентно: Core пропускает уже заведённые нормативы и не переписывает
 * их. Правка владельца («этот моем реже») повторный прогон переживает.
 *
 * Сроки считаются от дня заведения, а не задним числом: иначе при запуске
 * весь парк встанет красным, и в график перестанут смотреть на второй день.
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
  const machines = await get("/entities?domain=vendhub&type=machine");
  if (machines.length === 0) {
    console.log("Автоматов в реестре нет — заводить нормативы не на что.");
    return;
  }

  // Что уже есть, считаем сами: так владелец видит цифру ДО записи, а не
  // только постфактум. Core всё равно проверит повторно — доверять этому
  // подсчёту как гарантии нельзя, между двумя вызовами парк может измениться.
  // Вместе с выключенными: норматив, снятый с паузы (автомат в ремонте),
  // существует и заводить его заново не надо. Без этого флага каждый прогон
  // считал бы его недостающим и печатал «не хватает», а Core молча пропускал.
  const plans = await get("/maintenance/plans?includeInactive=1");
  const covered = new Set(plans.map((p) => `${p.entityId}|${p.kind}|${p.partKind ?? ""}`));

  // Кофейный автомат — привязанный к кофейной точке. Решает это Core (он же
  // и применяет), здесь только предпросмотр: показать разные числа для кофе
  // и снека честнее, чем одно общее, за которым не видно, что кому достанется.
  const locations = await get("/coffee/locations");
  const isCoffee = new Set(locations.map((l) => l.entityId).filter(Boolean));
  const NORMS = {
    coffee: [
      ["cleaning", "mixer"],
      ["part_replace", "water_filter"],
      ["service", ""],
    ],
    other: [["service", ""]],
  };
  const normsOf = (m) => (isCoffee.has(m.id) ? NORMS.coffee : NORMS.other);
  const missing = machines.filter((m) =>
    normsOf(m).some(([kind, part]) => !covered.has(`${m.id}|${kind}|${part}`)),
  );
  const coffeeCount = machines.filter((m) => isCoffee.has(m.id)).length;

  console.log(`Автоматов: ${machines.length} (кофейных ${coffeeCount}, прочих ${machines.length - coffeeCount})`);
  console.log(`Нормативов сейчас: ${plans.length}. Не хватает у автоматов: ${missing.length}`);
  console.log("Кофейным — мойка миксера 10, фильтр воды 45, ТО 90. Прочим — только ТО 90.");
  if (DRY) {
    for (const m of missing.slice(0, 20)) {
      console.log(`  · ${m.name}${isCoffee.has(m.id) ? " [кофе]" : " [прочий: только ТО]"}`);
    }
    if (missing.length > 20) console.log(`  … и ещё ${missing.length - 20}`);
    console.log("Пробный прогон — ничего не записано.");
    return;
  }
  if (missing.length === 0) {
    console.log("Всё уже заведено.");
    return;
  }

  // Партиями по 200: ограничение DTO — 500 объектов за вызов, берём с запасом.
  let created = 0;
  let skipped = 0;
  for (let i = 0; i < missing.length; i += 200) {
    const batch = missing.slice(i, i + 200).map((m) => m.id);
    const res = await fetch(`${CORE}/maintenance/plans/standard`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-service-token": TOKEN },
      body: JSON.stringify({ entityIds: batch, actor: "tool:apply-maintenance-norms" }),
    });
    if (!res.ok) {
      throw new Error(`Core ответил ${res.status}: ${(await res.text()).slice(0, 500)}`);
    }
    const out = await res.json();
    created += out.created;
    skipped += out.skipped;
  }
  console.log(`Готово: заведено ${created}, пропущено (уже были) ${skipped}.`);
  console.log("Кофейным ушло по три норматива, прочим — по одному (плановое ТО).");
  console.log("Проверить: панель → Обслуживание → раздел «Графики».");
}

main().catch((err) => {
  console.error(String(err));
  process.exit(1);
});
