#!/usr/bin/env node
/**
 * Сбор данных с сайта → согласование в MYDON.
 *
 * Решение владельца (2026-07-28): старую базу не грузим, данные только новые —
 * система берёт их с сайтов, куда владелец даёт доступ.
 *
 * Как работает:
 *   1. читает страницу (доступ к закрытым — через --cookie/--header от владельца);
 *   2. извлекает записи моделью Claude (подписка владельца, структурный вывод);
 *   3. показывает, что нашлось, и создаёт ОДНО согласование со списком.
 * Карточки появятся в реестре ТОЛЬКО после «Одобрить» в панели — T0 в действии.
 *
 * Запуск (на Маке; Core доступен через SSH-туннель):
 *   ssh -f root@100.81.197.68 -L 13001:127.0.0.1:3001 sleep 120
 *   SERVICE_TOKEN=<из .env сервера> \
 *   node tools/ingest-site.mjs <url> --type contractor --domain globerent \
 *     [--hint "таблица дилеров"] [--cookie "..."] [--dry]
 *
 * SERVICE_TOKEN обязателен: создание согласования — мутация, а Core отклоняет
 * мутации без токена (401). Значение — то же, что в /opt/mydon-app/.env.
 *
 * Типы: contractor, contract, machine, equipment, object, invoice.
 */

import { fetchPage } from "../packages/connectors/dist/web.js";

const args = process.argv.slice(2);
const url = args.find((a) => !a.startsWith("--"));
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : null;
};
const DRY = args.includes("--dry");
const type = opt("type");
const domain = opt("domain");
const hint = opt("hint") ?? "";
const cookie = opt("cookie");
const CORE = process.env.CORE_API_URL ?? "http://127.0.0.1:13001";

if (!url || !type || !domain) {
  console.error(
    "Использование: node tools/ingest-site.mjs <url> --type <тип> --domain <направление> [--hint ...] [--cookie ...] [--dry]",
  );
  process.exit(1);
}

// ── 1. Страница ──────────────────────────────────────────────────────────────
const page = await fetchPage(url, {
  ...(cookie ? { headers: { Cookie: cookie } } : {}),
});
if (page.status >= 400) {
  console.error(`Страница ответила HTTP ${page.status} — проверь адрес и доступ.`);
  process.exit(1);
}
console.log(`Страница прочитана: ${page.text.length} знаков${page.truncated ? " (обрезана)" : ""}`);

// ── 2. Извлечение записей моделью (подписка Claude владельца) ────────────────
// Путь через пакет assistant: папка tools — не workspace, прямое имя не найдётся.
const { query } = await import(
  "../packages/assistant/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs"
);

const schema = {
  type: "object",
  properties: {
    records: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string", description: "Название записи (контрагент, машина, договор…)" },
          externalRef: { type: "string", description: "Идентификатор из источника: ИНН, номер, артикул" },
          attrs: { type: "object", description: "Остальные факты со страницы: телефон, адрес, цена…" },
        },
        required: ["name"],
      },
    },
    note: { type: "string", description: "Что это за данные и чего на странице НЕ нашлось" },
  },
  required: ["records"],
};

const q = query({
  prompt: [
    `Извлеки записи типа «${type}» для направления «${domain}» из текста страницы.`,
    hint ? `Подсказка владельца: ${hint}.` : "",
    "Бери только то, что реально есть в тексте — ничего не выдумывай.",
    "Мусор навигации и рекламу пропускай.",
    "",
    `--- ТЕКСТ СТРАНИЦЫ (${page.url}) ---`,
    page.text.slice(0, 120_000),
  ].join("\n"),
  options: {
    systemPrompt: "Ты аккуратно извлекаешь структурированные данные из текста веб-страниц.",
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
      console.error(`Извлечение не удалось (${msg.subtype}).`);
      process.exit(1);
    }
    extracted = msg.structured_output;
  }
}

const records = (extracted?.records ?? []).filter((r) => r?.name?.trim());
console.log(`\nНайдено записей: ${records.length}`);
if (extracted?.note) console.log(`Модель: ${extracted.note}`);
for (const r of records.slice(0, 15)) {
  console.log(` • ${r.name}${r.externalRef ? ` (${r.externalRef})` : ""}`);
}
if (records.length > 15) console.log(` …и ещё ${records.length - 15}`);

if (records.length === 0) {
  console.log("Предлагать нечего — согласование не создаётся.");
  process.exit(0);
}
if (DRY) {
  console.log("\n(сухой прогон — согласование не создано)");
  process.exit(0);
}

// ── 3. Одно согласование со всем списком ─────────────────────────────────────
const res = await fetch(`${CORE}/approvals`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    ...(process.env.SERVICE_TOKEN ? { "x-service-token": process.env.SERVICE_TOKEN } : {}),
  },
  body: JSON.stringify({
    agent: "site-ingest",
    action: `Завести ${records.length} карточек «${type}» в ${domain} с сайта ${new URL(url).hostname}`,
    tier: "T0",
    payload: { source: url, import: { domain, type, records } },
  }),
  signal: AbortSignal.timeout(15_000),
});
if (!res.ok) {
  console.error(`Core ответил HTTP ${res.status} — согласование не создано.`);
  process.exit(1);
}
const approval = await res.json();
console.log(`\nСогласование создано: ${approval.id}`);
console.log("Открой панель → Согласования. После «Одобрить» карточки появятся в реестре.");
