#!/usr/bin/env node
/**
 * Исторический импорт заливок кофейных бункеров из экспорта Telegram.
 *
 * Bot API истории ДО подключения бота не отдаёт (у ботов нет метода
 * getHistory) — читать её можно либо MTProto-клиентом от имени личного
 * аккаунта (что mydon-agent-os сознательно не делает, ToS), либо через
 * штатный экспорт Telegram Desktop (Настройки → Экспорт данных → JSON,
 * без медиа хватит). Этот инструмент — второй путь: безопасный, без чужих
 * учётных данных, ничего не тянет из сети сам.
 *
 * Как работает (тот же принцип, что и tools/ingest-site.mjs — T0-гейт,
 * ничего не пишет в базу напрямую):
 *   1. читает result.json экспорта конкретного чата/канала;
 *   2. пачками прогоняет текст сообщений через модель (подписка владельца),
 *      она пытается вытащить «точка / бункер / вес / упаковки / дата»;
 *   3. имя точки сверяется со справочником /coffee/locations — то, что не
 *      совпало, идёт в отчёт «не распознано», а не в базу с угадыванием;
 *   4. одно согласование со всем, что удалось распознать. Реальные строки
 *      coffee_refill появятся ТОЛЬКО после «Одобрить» в панели
 *      (approvals.service.ts executeCoffeeImport) — владелец видит список
 *      до того, как он попадёт в учёт.
 *
 * Запуск (на Маке; Core доступен через SSH-туннель или локально):
 *   SERVICE_TOKEN=<из .env сервера> \
 *   node tools/import-telegram-coffee.mjs <result.json> [--limit 5000] [--dry]
 *
 * Формат экспорта — стандартный Telegram Desktop JSON: {messages: [{type,
 * date, from, text}]}. `text` — строка или массив {type, text} (entities);
 * оба варианта разбираются.
 *
 * Формат сообщений в реальном чате владелец видит только сам — регулярки
 * здесь НЕ используются намеренно (угадать формат заранее нельзя), решает
 * модель по контексту известных адресов/бункеров. Если после первого прогона
 * распознаётся мало — проверьте --dry вывод и уточните HINT ниже под то, как
 * реально писали в группе.
 */

import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
const opt = (name, def = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : def;
};
const DRY = args.includes("--dry");
const LIMIT = Number(opt("limit", "100000"));
const BATCH_SIZE = 250;
const CORE = process.env.CORE_API_URL ?? "http://127.0.0.1:3001";

/** Подсказка модели, если формат сообщений в конкретной группе нестандартный (например «АХ б7 1200/2»). */
const HINT = process.env.TELEGRAM_COFFEE_HINT ?? "";

if (!file) {
  console.error(
    "Использование: node tools/import-telegram-coffee.mjs <result.json> [--limit N] [--dry]\n" +
      "  result.json — экспорт чата/канала (Telegram Desktop → Настройки → Экспорт данных → JSON).",
  );
  process.exit(1);
}

async function coreFetch(path, init) {
  const res = await fetch(`${CORE}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(process.env.SERVICE_TOKEN ? { "x-service-token": process.env.SERVICE_TOKEN } : {}),
      ...(init?.headers ?? {}),
    },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const j = await res.json();
      if (j.message) detail = Array.isArray(j.message) ? j.message.join("; ") : String(j.message);
    } catch {
      /* тело не JSON */
    }
    throw new Error(`${init?.method ?? "GET"} ${path}: ${detail}`);
  }
  return res.status === 204 ? null : res.json();
}

/** Текст сообщения экспорта: строка или массив {type,text} entities. */
function textOf(msg) {
  if (typeof msg.text === "string") return msg.text;
  if (Array.isArray(msg.text)) {
    return msg.text.map((t) => (typeof t === "string" ? t : (t?.text ?? ""))).join("");
  }
  return "";
}

// ── 1. Читаем экспорт ──────────────────────────────────────────────────────
let raw;
try {
  raw = JSON.parse(readFileSync(file, "utf8"));
} catch (err) {
  console.error(`Не удалось прочитать/разобрать ${file}: ${err.message}`);
  process.exit(1);
}
const allMessages = Array.isArray(raw.messages) ? raw.messages : [];
const messages = allMessages
  .filter((m) => m.type === "message" && textOf(m).trim().length > 0)
  .slice(0, LIMIT)
  .map((m) => ({ date: m.date, from: m.from ?? m.actor ?? "?", text: textOf(m).trim() }));

console.log(`Экспорт «${raw.name ?? file}»: сообщений всего ${allMessages.length}, с текстом ${messages.length}.`);
if (messages.length === 0) {
  console.log("Разбирать нечего.");
  process.exit(0);
}

// ── 2. Известные точки — справочник, не угадываем ──────────────────────────
const locations = await coreFetch("/coffee/locations");
const locationByName = new Map(locations.map((l) => [l.name.toLowerCase().trim(), l]));
console.log(`Точек в справочнике: ${locations.length}.`);

// ── 3. Пачками через модель ─────────────────────────────────────────────────
const { query } = await import("../packages/assistant/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs");

const schema = {
  type: "object",
  properties: {
    records: {
      type: "array",
      items: {
        type: "object",
        properties: {
          locationName: { type: "string", description: "Название точки максимально близко к тому, как в справочнике" },
          position: { type: "integer", description: "Номер бункера 1–8" },
          containerNumber: { type: "integer", description: "Номер набора/контейнера 1–27, если упомянут" },
          filledWeight: { type: "integer", description: "Вес после засыпки, грамм" },
          packageCount: { type: "integer", description: "Число упаковок, если упомянуто" },
          enteredDate: { type: "string", description: "Дата сообщения в формате YYYY-MM-DD" },
        },
        required: ["locationName", "position", "filledWeight", "enteredDate"],
      },
    },
    unmatched: {
      type: "array",
      items: { type: "string" },
      description: "Сообщения, где явно похоже на заливку бункера, но не хватило данных для полной записи",
    },
  },
  required: ["records", "unmatched"],
};

const knownLocations = locations.map((l) => l.name).join(", ");
const records = [];
const unmatchedFromModel = [];
const unmatchedLocationName = [];

for (let i = 0; i < messages.length; i += BATCH_SIZE) {
  const batch = messages.slice(i, i + BATCH_SIZE);
  console.log(`Пачка ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(messages.length / BATCH_SIZE)} (${batch.length} сообщ.)…`);

  const q = query({
    prompt: [
      "Это переписка техников о заливке бункеров кофемашин: точка (адрес), номер бункера (1–8),",
      "вес после засыпки (граммы), иногда номер набора-контейнера (1–27) и число упаковок.",
      `Известные точки (сверяй locationName максимально близко к этому списку): ${knownLocations}`,
      HINT ? `Подсказка владельца по формату сообщений: ${HINT}` : "",
      "Извлекай ТОЛЬКО то, что реально написано — ничего не выдумывай и не досчитывай недостающее.",
      "Сообщение без явного веса или без понятной точки — не запись, а в unmatched (если похоже на заливку, но неполно).",
      "Дата — из даты сообщения (уже дана рядом с текстом), не текущая.",
      "",
      "--- СООБЩЕНИЯ ---",
      batch.map((m) => `[${m.date}] ${m.from}: ${m.text}`).join("\n"),
    ].join("\n"),
    options: {
      systemPrompt: "Ты аккуратно извлекаешь структурированные записи из переписки техников про кофейные бункеры.",
      tools: [],
      settingSources: [],
      maxTurns: 1,
      persistSession: false,
      outputFormat: { type: "json_schema", schema },
    },
  });

  let extracted = null;
  for await (const msg of q) {
    if (msg.type === "result") {
      if (msg.subtype !== "success" || msg.is_error) {
        console.error(`  пачка ${Math.floor(i / BATCH_SIZE) + 1}: извлечение не удалось (${msg.subtype}) — пропущена`);
        continue;
      }
      extracted = msg.structured_output;
    }
  }
  if (!extracted) continue;

  for (const r of extracted.records ?? []) {
    const key = String(r.locationName ?? "").toLowerCase().trim();
    const loc = locationByName.get(key);
    if (!loc) {
      unmatchedLocationName.push(`${r.locationName} (бункер ${r.position}, ${r.filledWeight}г, ${r.enteredDate})`);
      continue;
    }
    const position = Number(r.position);
    const filledWeight = Number(r.filledWeight);
    if (!(position >= 1 && position <= 8) || !(filledWeight > 0) || !/^\d{4}-\d{2}-\d{2}$/.test(String(r.enteredDate))) {
      unmatchedLocationName.push(`${r.locationName}: кривые данные (бункер ${r.position}, ${r.filledWeight}г, ${r.enteredDate})`);
      continue;
    }
    records.push({
      locationId: loc.id,
      position,
      filledWeight,
      enteredDate: r.enteredDate,
      ...(Number.isInteger(r.containerNumber) && r.containerNumber >= 1 && r.containerNumber <= 27
        ? { containerNumber: r.containerNumber }
        : {}),
      ...(Number.isInteger(r.packageCount) && r.packageCount >= 1 ? { packageCount: r.packageCount } : {}),
    });
  }
  unmatchedFromModel.push(...(extracted.unmatched ?? []));
}

// ── 4. Итог ──────────────────────────────────────────────────────────────
console.log(`\nРаспознано записей: ${records.length}`);
console.log(`Точка не найдена в справочнике: ${unmatchedLocationName.length}`);
console.log(`Похоже на заливку, но неполно: ${unmatchedFromModel.length}`);
if (unmatchedLocationName.length > 0) {
  console.log("\nНе распознанные точки (первые 20):");
  for (const u of unmatchedLocationName.slice(0, 20)) console.log(`  • ${u}`);
}
if (unmatchedFromModel.length > 0) {
  console.log("\nНеполные записи (первые 20) — проверь глазами, возможно нужна подсказка TELEGRAM_COFFEE_HINT:");
  for (const u of unmatchedFromModel.slice(0, 20)) console.log(`  • ${u}`);
}

if (records.length === 0) {
  console.log("\nПредлагать нечего — согласование не создаётся.");
  process.exit(0);
}
if (DRY) {
  console.log("\n(сухой прогон — согласование не создано)");
  process.exit(0);
}

// ── 5. Одно согласование со всем списком (T0 — владелец решает) ────────────
const approval = await coreFetch("/approvals", {
  method: "POST",
  body: JSON.stringify({
    agent: "telegram-coffee-import",
    action: `Занести ${records.length} исторических заливок бункеров из «${raw.name ?? file}»`,
    tier: "T0",
    payload: { source: file, coffeeImport: { records } },
  }),
});
console.log(`\nСогласование создано: ${approval.id}`);
console.log("Открой панель → Согласования. После «Одобрить» записи появятся в /coffee → История ввода.");
