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
 * Группа-источник (указана владельцем 2026-08-03): t.me/c/3307473916 —
 * приватная группа заливок; для Bot API это чат -1003307473916 (см.
 * TELEGRAM_COFFEE_HISTORY_CHAT в .env.example). Экспортировать её историю
 * может участник группы через Telegram Desktop.
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

import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
const opt = (name, def = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : def;
};
const DRY = args.includes("--dry");
const PHOTOS = args.includes("--photos");
// Фото только из одной темы форума (id из fetch-telegram-history.mjs --topics):
// тема «Заполнение бункеров» — таблицы, остальные темы vision не гоняем.
const PHOTO_TOPIC = opt("photo-topic") !== null ? Number(opt("photo-topic")) : null;
// Готовый payload прошлого прогона (страховка): сразу к согласованию, без LLM.
const PAYLOAD_FILE = opt("payload");
const LIMIT = Number(opt("limit", "100000"));
const BATCH_SIZE = 250;
const CORE = process.env.CORE_API_URL ?? "http://127.0.0.1:3001";
// Модель разбора (слово владельца, 2026-08-03): Sonnet — точный на чтении
// таблиц и экономит лимиты подписки на сотнях пачек. Прогон не зависит от
// того, какая модель выбрана в Claude Code запускающего.
const MODEL = process.env.COFFEE_IMPORT_MODEL ?? "claude-sonnet-5";

/** Подсказка модели, если формат сообщений в конкретной группе нестандартный (например «АХ б7 1200/2»). */
const HINT = process.env.TELEGRAM_COFFEE_HINT ?? "";

if (!file) {
  console.error(
    "Использование: node tools/import-telegram-coffee.mjs <result.json> [--photos] [--photo-topic N] [--limit N] [--dry]\n" +
      "  result.json — экспорт чата/канала (Telegram Desktop → Настройки → Экспорт данных → JSON).\n" +
      "  --photos — разбирать фото-таблицы (экспорт должен включать картинки; лежат рядом с result.json).\n" +
      "  --photo-topic N — фото только из темы форума N (id — из fetch-telegram-history.mjs --topics).\n" +
      "  --payload файл — отправить на согласование готовый payload прошлого прогона (без пере-разбора).",
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

const { parseContainerReturnMessage } = await import("../packages/shared/dist/coffee-calc.js");

// ── 1. Читаем экспорт ──────────────────────────────────────────────────────
let raw;
try {
  raw = JSON.parse(readFileSync(file, "utf8"));
} catch (err) {
  console.error(`Не удалось прочитать/разобрать ${file}: ${err.message}`);
  process.exit(1);
}
const allMessages = Array.isArray(raw.messages) ? raw.messages : [];

// Готовый payload прошлого прогона: сразу на согласование, без LLM-разбора.
if (PAYLOAD_FILE) {
  const p = JSON.parse(readFileSync(PAYLOAD_FILE, "utf8"));
  try {
    await submitApproval(p.records ?? [], p.returns ?? [], p.consumables ?? [], p.newLocations ?? []);
  } catch (err) {
    console.error(`Отправка согласования не удалась: ${err.message}`);
    console.error("Проверь туннель к Core (порт 3001) и SERVICE_TOKEN, затем повтори ту же команду.");
    process.exit(1);
  }
  process.exit(0);
}
const textMessages = allMessages
  .filter((m) => m.type === "message" && textOf(m).trim().length > 0)
  .slice(0, LIMIT)
  .map((m) => ({ date: m.date, from: m.from ?? m.actor ?? "?", text: textOf(m).trim() }));

// ── 0. Детерминированный проход: возвраты «позиция. набор. вес» ────────────
// Формат известен точно (тема «Остатки с бункеров») — регулярка надёжнее
// модели: ни одного выдуманного числа. Разобранные сообщения в LLM не идут.
const returns = [];
const returnsRejected = [];
const messages = [];
for (const m of textMessages) {
  const parsed = parseContainerReturnMessage(m.text);
  if (parsed.returns.length === 0 && parsed.rejected.length === 0) {
    messages.push(m); // не про возвраты — пойдёт в общий LLM-разбор
    continue;
  }
  const returnedDate = String(m.date ?? "").slice(0, 10);
  for (const r of parsed.returns) {
    returns.push({ ...r, returnedDate, ...(parsed.locationNote ? { locationNote: parsed.locationNote } : {}) });
  }
  for (const line of parsed.rejected) returnsRejected.push(`[${m.date}] ${line}`);
}
console.log(
  `Экспорт «${raw.name ?? file}»: сообщений всего ${allMessages.length}, с текстом ${textMessages.length}; ` +
    `возвратов наборов разобрано детерминированно: ${returns.length}${returnsRejected.length ? ` (отклонено строк: ${returnsRejected.length})` : ""}.`,
);
// Фото считаются работой тоже: экспорт одной фото-темы текста может не иметь.
const hasPhotosToDo =
  PHOTOS && allMessages.some((m) => m.type === "message" && typeof m.photo === "string" && m.photo.length > 0);
if (messages.length === 0 && returns.length === 0 && !hasPhotosToDo) {
  console.log("Разбирать нечего.");
  process.exit(0);
}
// Просят фильтр по теме, а выгрузка тем не знает — сказать ДО того, как
// потрачены LLM-прогоны, а не в середине.
if (
  PHOTO_TOPIC !== null &&
  hasPhotosToDo &&
  !allMessages.some((m) => m.type === "message" && m.photo && m.topicId)
) {
  console.error(
    `--photo-topic ${PHOTO_TOPIC}: в экспорте нет topicId — он из старой выгрузки. ` +
      "Перегони: node tools/fetch-telegram-history.mjs --out <та же папка> (фото возьмутся из кэша).",
  );
  process.exit(1);
}

// ── 2. Известные точки — справочник, не угадываем ──────────────────────────
let locations;
try {
  locations = await coreFetch("/coffee/locations");
} catch (err) {
  console.error(`Core недоступен (${err.message}).`);
  console.error("Подними туннель к серверу: ssh -N -L 3001:127.0.0.1:3001 root@<mydon-os> — и задай SERVICE_TOKEN.");
  process.exit(1);
}
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

// Исторические точки: валидная запись с адресом, которого в справочнике уже
// нет (точку закрыли, машину перевезли), не выбрасывается — уходит в payload
// с locationName, а имя копится в newLocations. Создаст их Core, и только
// после «Одобрить» — владелец видит список новых точек в сводке согласования.
const newLocationNames = new Map(); // lower → каноничное имя (первое встреченное)
function rememberNewLocation(raw) {
  const name = String(raw ?? "").trim();
  if (name.length < 2 || name.length > 128) return null;
  const key = name.toLowerCase();
  if (!newLocationNames.has(key)) newLocationNames.set(key, name);
  return newLocationNames.get(key);
}

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
      model: MODEL,
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
    const position = Number(r.position);
    const filledWeight = Number(r.filledWeight);
    if (!(position >= 1 && position <= 8) || !(filledWeight > 0) || !/^\d{4}-\d{2}-\d{2}$/.test(String(r.enteredDate))) {
      unmatchedLocationName.push(`${r.locationName}: кривые данные (бункер ${r.position}, ${r.filledWeight}г, ${r.enteredDate})`);
      continue;
    }
    const canonName = loc ? null : rememberNewLocation(r.locationName);
    if (!loc && !canonName) {
      unmatchedLocationName.push(`${r.locationName} (бункер ${r.position}, ${r.filledWeight}г, ${r.enteredDate})`);
      continue;
    }
    records.push({
      ...(loc ? { locationId: loc.id } : { locationName: canonName }),
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

// ── 3b. Фото-таблицы: заливки и расходники (--photos) ──────────────────────
// В теме «Заполнение бункеров» данные живут в скриншотах таблиц референс-
// приложения: «Таблица бункеров - YYYY-MM-DD» (адрес × позиция, в ячейке
// набор+вес) и «Вода, стаканчики и крышки - YYYY-MM-DD». Дата — в заголовке
// самой картинки, поэтому модель читает её ОТТУДА, а дата сообщения — запасная.
const consumables = [];
const allPhotoMessages = allMessages.filter((m) => m.type === "message" && typeof m.photo === "string" && m.photo.length > 0);
const photoMessages =
  PHOTO_TOPIC === null ? allPhotoMessages : allPhotoMessages.filter((m) => Number(m.topicId) === PHOTO_TOPIC);
if (PHOTO_TOPIC !== null) {
  console.log(`\nФото: тема ${PHOTO_TOPIC} — ${photoMessages.length} из ${allPhotoMessages.length} в экспорте.`);
}
if (!PHOTOS && photoMessages.length > 0) {
  console.log(`\nФото в экспорте: ${photoMessages.length} — пропущены (запусти с --photos и экспортом, включающим картинки).`);
}
if (PHOTOS && photoMessages.length > 0) {
  const exportDir = dirname(file);
  const MEDIA_TYPE = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp" };
  const photos = [];
  let missing = 0;
  for (const m of photoMessages.slice(0, LIMIT)) {
    const path = join(exportDir, m.photo);
    const mediaType = MEDIA_TYPE[extname(path).toLowerCase()];
    if (!mediaType || !existsSync(path)) {
      missing += 1;
      continue;
    }
    photos.push({ date: String(m.date ?? "").slice(0, 10), path, mediaType });
  }
  console.log(`\nФото-таблиц к разбору: ${photos.length}${missing ? ` (не найдено файлов/формат: ${missing})` : ""}.`);

  const photoSchema = {
    type: "object",
    properties: {
      refills: {
        type: "array",
        items: {
          type: "object",
          properties: {
            locationName: { type: "string" },
            position: { type: "integer", description: "Колонка 1–8" },
            containerNumber: { type: "integer", description: "Номер набора из ячейки (зелёная пометка), 1–27" },
            filledWeight: { type: "integer", description: "Вес из ячейки, грамм" },
            date: { type: "string", description: "Дата из ЗАГОЛОВКА таблицы, YYYY-MM-DD" },
          },
          required: ["locationName", "position", "filledWeight", "date"],
        },
      },
      consumables: {
        type: "array",
        items: {
          type: "object",
          properties: {
            locationName: { type: "string" },
            date: { type: "string", description: "Дата из заголовка таблицы, YYYY-MM-DD" },
            water: { type: "integer" },
            cups: { type: "integer" },
            lids: { type: "integer" },
          },
          required: ["locationName", "date"],
        },
      },
      unreadable: { type: "array", items: { type: "string" }, description: "Что не удалось прочитать и почему" },
    },
    required: ["refills", "consumables", "unreadable"],
  };

  const PHOTO_BATCH = 3;
  const unreadablePhotos = [];
  for (let i = 0; i < photos.length; i += PHOTO_BATCH) {
    const batch = photos.slice(i, i + PHOTO_BATCH);
    console.log(`Фото-пачка ${Math.floor(i / PHOTO_BATCH) + 1}/${Math.ceil(photos.length / PHOTO_BATCH)}…`);
    const content = [
      {
        type: "text",
        text: [
          "На картинках — скриншоты дневных таблиц кофе-бункеров.",
          "Виды таблиц: «Таблица бункеров - ДАТА» (строки — адреса, колонки — позиции 1–8;",
          "в заполненной ячейке два числа: номер набора (зелёная пометка, 1–27) и вес в граммах)",
          "и «Вода, стаканчики и крышки - ДАТА» (адрес → вода/стаканчики/крышки; строку «Итого» пропускай).",
          "Таблицу «Потраченные ингредиенты» пропускай — это производные данные.",
          `Известные точки (locationName пиши максимально близко к списку): ${knownLocations}`,
          "Дату бери из ЗАГОЛОВКА таблицы. Читай ТОЛЬКО то, что видно; нечитаемое — в unreadable.",
          `Даты сообщений по порядку картинок (запасные): ${batch.map((p) => p.date).join(", ")}`,
        ].join("\n"),
      },
      ...batch.map((p) => ({
        type: "image",
        source: { type: "base64", media_type: p.mediaType, data: readFileSync(p.path).toString("base64") },
      })),
    ];
    async function* photoPrompt() {
      yield { type: "user", message: { role: "user", content }, parent_tool_use_id: null };
    }

    const q = query({
      prompt: photoPrompt(),
      options: {
        systemPrompt: "Ты аккуратно читаешь таблицы с картинок и переносишь числа как есть, не выдумывая.",
        model: MODEL,
        tools: [],
        settingSources: [],
        maxTurns: 1,
        persistSession: false,
        outputFormat: { type: "json_schema", schema: photoSchema },
      },
    });
    let extracted = null;
    for await (const msg of q) {
      if (msg.type === "result") {
        if (msg.subtype !== "success" || msg.is_error) {
          console.error(`  фото-пачка: не разобралась (${msg.subtype}) — пропущена`);
          continue;
        }
        extracted = msg.structured_output;
      }
    }
    if (!extracted) continue;

    for (const r of extracted.refills ?? []) {
      const loc = locationByName.get(String(r.locationName ?? "").toLowerCase().trim());
      const position = Number(r.position);
      const filledWeight = Number(r.filledWeight);
      const date = /^\d{4}-\d{2}-\d{2}$/.test(String(r.date)) ? r.date : batch[0]?.date;
      if (!(position >= 1 && position <= 8) || !(filledWeight > 0) || !/^\d{4}-\d{2}-\d{2}$/.test(String(date))) {
        unmatchedLocationName.push(`${r.locationName} (фото: бункер ${r.position}, ${r.filledWeight}г, ${r.date})`);
        continue;
      }
      const canonName = loc ? null : rememberNewLocation(r.locationName);
      if (!loc && !canonName) {
        unmatchedLocationName.push(`${r.locationName} (фото: бункер ${r.position}, ${r.filledWeight}г, ${r.date})`);
        continue;
      }
      records.push({
        ...(loc ? { locationId: loc.id } : { locationName: canonName }),
        position,
        filledWeight,
        enteredDate: date,
        ...(Number.isInteger(r.containerNumber) && r.containerNumber >= 1 && r.containerNumber <= 27
          ? { containerNumber: r.containerNumber }
          : {}),
      });
    }
    for (const c of extracted.consumables ?? []) {
      const loc = locationByName.get(String(c.locationName ?? "").toLowerCase().trim());
      const date = /^\d{4}-\d{2}-\d{2}$/.test(String(c.date)) ? c.date : batch[0]?.date;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date))) {
        unmatchedLocationName.push(`${c.locationName} (фото расходников, ${c.date})`);
        continue;
      }
      const canonName = loc ? null : rememberNewLocation(c.locationName);
      if (!loc && !canonName) {
        unmatchedLocationName.push(`${c.locationName} (фото расходников, ${c.date})`);
        continue;
      }
      const num = (v) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Math.trunc(Number(v)) : 0);
      consumables.push({
        ...(loc ? { locationId: loc.id } : { locationName: canonName }),
        loggedDate: date,
        water: num(c.water),
        cups: num(c.cups),
        lids: num(c.lids),
      });
    }
    unreadablePhotos.push(...(extracted.unreadable ?? []));
  }
  if (unreadablePhotos.length > 0) {
    console.log("\nНечитаемое на фото (первые 10):");
    for (const u of unreadablePhotos.slice(0, 10)) console.log(`  • ${u}`);
  }
}

// ── 4. Итог ──────────────────────────────────────────────────────────────
const newLocations = [...newLocationNames.values()];
console.log(`\nРаспознано заливок: ${records.length}`);
console.log(`Возвратов наборов (детерминированно): ${returns.length}`);
console.log(`Расходников (вода/стаканчики/крышки): ${consumables.length}`);
console.log(`Кривые данные (выброшено): ${unmatchedLocationName.length}`);
console.log(`Похоже на заливку, но неполно: ${unmatchedFromModel.length}`);
if (newLocations.length > 0) {
  console.log(`\nИсторические точки, которых нет в справочнике (${newLocations.length}) — будут созданы после «Одобрить»:`);
  for (const n of newLocations) console.log(`  • ${n}`);
  if (newLocations.length > 50) {
    console.log("  ⚠ больше 50 — Core создаст только первые 50; проверь, не разъехались ли имена одной точки.");
  }
}
if (returnsRejected.length > 0) {
  console.log("\nОтклонённые строки возвратов (числа вне диапазонов, первые 20):");
  for (const u of returnsRejected.slice(0, 20)) console.log(`  • ${u}`);
}
if (unmatchedLocationName.length > 0) {
  console.log("\nНе распознанные точки (первые 20):");
  for (const u of unmatchedLocationName.slice(0, 20)) console.log(`  • ${u}`);
}
if (unmatchedFromModel.length > 0) {
  console.log("\nНеполные записи (первые 20) — проверь глазами, возможно нужна подсказка TELEGRAM_COFFEE_HINT:");
  for (const u of unmatchedFromModel.slice(0, 20)) console.log(`  • ${u}`);
}

if (records.length === 0 && returns.length === 0 && consumables.length === 0) {
  console.log("\nПредлагать нечего — согласование не создаётся.");
  process.exit(0);
}
if (DRY) {
  console.log("\n(сухой прогон — согласование не создано)");
  process.exit(0);
}

// ── 5. Одно согласование со всем списком (T0 — владелец решает) ────────────
// Многочасовой vision-разбор не должен пропасть из-за отвалившегося туннеля к
// Core: payload сохраняется на диск ДО отправки, повтор — через --payload.
const payloadPath = join(dirname(file), "coffee-import-payload.json");
writeFileSync(payloadPath, JSON.stringify({ records, returns, consumables, newLocations }, null, 1));
console.log(`\nPayload сохранён: ${payloadPath}`);
try {
  await submitApproval(records, returns, consumables, newLocations);
} catch (err) {
  console.error(`\nОтправка согласования не удалась: ${err.message}`);
  console.error(
    `Разбор цел. Повторная отправка без пере-разбора:\n  node tools/import-telegram-coffee.mjs ${file} --payload ${payloadPath}`,
  );
  process.exit(1);
}

async function submitApproval(records, returns, consumables, newLocations = []) {
  if (records.length === 0 && returns.length === 0 && consumables.length === 0) {
    console.log("Предлагать нечего — согласование не создаётся.");
    return;
  }
  const parts = [];
  if (records.length > 0) parts.push(`${records.length} заливок`);
  if (returns.length > 0) parts.push(`${returns.length} возвратов наборов`);
  if (consumables.length > 0) parts.push(`${consumables.length} строк расходников`);
  if (newLocations.length > 0) parts.push(`${newLocations.length} новых точек`);
  const approval = await coreFetch("/approvals", {
    method: "POST",
    body: JSON.stringify({
      agent: "telegram-coffee-import",
      action: `Занести из «${raw.name ?? file}»: ${parts.join(", ")} (история Telegram)`,
      tier: "T0",
      payload: { source: file, coffeeImport: { records, returns, consumables, newLocations } },
    }),
  });
  console.log(`\nСогласование создано: ${approval.id}`);
  console.log("Открой панель → Согласования. После «Одобрить» записи появятся в кофе-бункерах VendHub.");
}
