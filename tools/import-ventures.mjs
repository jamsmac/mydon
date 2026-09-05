#!/usr/bin/env node
/**
 * Импорт карточек кандидатов Venture Factory (сессия Scout + Analyst) в MYDON Core.
 *
 * Реестр фабрики — не файл, а карточки `entity(type='venture_candidate')` в Core
 * (решение 05.09.2026, `docs/decisions/2026-09-05-venture-factory-interactive.md`).
 * Файл сессии `data/ventures/<дата>-session-<n>.json` — формат авторства и сид:
 * его пишет навык `mydon-venture-factory` в интерактивном режиме, а источником
 * истины после импорта становится база — тот же паттерн, что у паспортов агентов.
 *
 * Вход: JSON `{ session, market, cards: [{ title, url, source, foundAt, what,
 * revenueProof, operations, entryThreshold, transfer, ownerAssets, verdict,
 * hardChecks, failReason?, softScore?, parkCondition?, nextStep? }] }`.
 *
 * Запуск НА СЕРВЕРЕ (Core слушает локально, мутации закрыты сервис-токеном):
 *   cd /opt/mydon-app
 *   docker compose -f deploy/docker-compose.yml --env-file .env \
 *     exec -T mydon-core node tools/import-ventures.mjs \
 *       --file=data/ventures/2026-09-05-session-1.json --dry-run
 *   ... node tools/import-ventures.mjs --file=data/ventures/2026-09-05-session-1.json
 *
 * Идемпотентно: «виденное» — это `externalRef` карточки (seenHash от url и
 * заголовка), второй прогон того же файла не создаёт ничего. Дедуп работает и
 * внутри файла: две карточки на один url — одна запись.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CORE = process.env.CORE_API_URL ?? "http://127.0.0.1:3001";
const TOKEN = process.env.SERVICE_TOKEN ?? "";

/** Домен карточек: до появления `ventures` в `DOMAINS` фабрика живёт в `mydon`. */
export const VENTURE_DOMAIN = "mydon";
export const VENTURE_TYPE = "venture_candidate";
/** MAX_ENTITY_NAME из `packages/shared/src/entity-name.ts` (DTO Core его и проверяет). */
export const MAX_NAME = 512;
/**
 * MAX_FIND_LIMIT Core. Предел спрашиваем явно: по умолчанию `find` отдаёт 500,
 * и молча обрезанная выборка читалась бы как «в реестре этого нет» — то есть
 * дала бы дубли ровно тогда, когда реестр вырос.
 */
const FIND_LIMIT = 5000;

/**
 * Нормализация url для сигнатуры «виденного»: регистр, протокол, `www.`,
 * хвостовой слэш и utm-метки не делают находку новой.
 */
export function normalizeUrl(raw) {
  const s = String(raw ?? "").trim().toLowerCase();
  const hashAt = s.indexOf("#");
  const body = hashAt >= 0 ? s.slice(0, hashAt) : s;
  const hash = hashAt >= 0 ? s.slice(hashAt) : "";
  const queryAt = body.indexOf("?");
  const head = (queryAt >= 0 ? body.slice(0, queryAt) : body)
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/+$/, "");
  const kept = (queryAt >= 0 ? body.slice(queryAt + 1) : "")
    .split("&")
    .filter((part) => part !== "" && !part.startsWith("utm_"));
  return `${head}${kept.length > 0 ? `?${kept.join("&")}` : ""}${hash}`;
}

/** Нормализация заголовка: регистр и лишние пробелы не делают находку новой. */
export function normalizeTitle(raw) {
  return String(raw ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

/** Сигнатура находки: sha256 от `нормализованный url|нормализованный заголовок`. */
export function seenHash(url, title) {
  return createHash("sha256").update(`${normalizeUrl(url)}|${normalizeTitle(title)}`).digest("hex");
}

const defined = (obj) => Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));

/** Сумма мягких баллов S1–S6; без баллов (вердикт NO по H-провалу) — undefined. */
export function softTotal(softScore) {
  if (!softScore || typeof softScore !== "object") return undefined;
  const values = Object.values(softScore).filter((v) => typeof v === "number");
  return values.length > 0 ? values.reduce((a, b) => a + b, 0) : undefined;
}

/**
 * Карточка сессии → карточка Core.
 *
 * `session` — идентификатор сессии из шапки файла («2026-09-05-1»), `market` —
 * целевой рынок оттуда же (по умолчанию берётся из переноса самой карточки).
 * Длинный заголовок обрезается: DTO Core отказал бы всей карточке, а имя
 * находки — не документ.
 */
export function toEntity(card, session, market = card?.transfer?.toMarket) {
  const title = String(card.title ?? "").trim();
  const name = title.length > MAX_NAME ? `${title.slice(0, MAX_NAME - 1)}…` : title;
  return {
    domain: VENTURE_DOMAIN,
    type: VENTURE_TYPE,
    name,
    externalRef: seenHash(card.url, card.title),
    attrs: defined({
      source: card.source,
      url: card.url,
      foundAt: card.foundAt,
      what: card.what,
      revenueProof: card.revenueProof,
      operations: card.operations,
      entryThreshold: card.entryThreshold,
      transfer: card.transfer,
      ownerAssets: card.ownerAssets,
      verdict: card.verdict,
      hardChecks: card.hardChecks,
      failReason: card.failReason,
      softScore: card.softScore,
      softTotal: softTotal(card.softScore),
      parkCondition: card.parkCondition,
      nextStep: card.nextStep,
      session,
      market,
    }),
    createdFrom: `venture-factory:${session}`,
  };
}

/**
 * Что заводить, а что уже в реестре. `existing` — карточки Core (строки с
 * `externalRef`), список сигнатур или их набор: сравнение идёт по сигнатуре, а
 * не по url, иначе utm-хвост завёл бы ту же находку второй раз.
 */
export function plan(cards, existing = []) {
  const list = Array.isArray(existing) ? existing : [...existing];
  const seen = new Set(
    list.map((e) => (typeof e === "string" ? e : e?.externalRef)).filter((ref) => typeof ref === "string"),
  );
  const create = [];
  const skip = [];
  for (const card of cards ?? []) {
    const ref = seenHash(card.url, card.title);
    if (seen.has(ref)) {
      skip.push(card);
      continue;
    }
    // Внутрифайловый дубль тоже пропуск: сигнатура добавляется сразу, а не
    // после записи, иначе одна сессия задвоила бы находку сама себе.
    seen.add(ref);
    create.push(card);
  }
  return { create, skip };
}

function parseArgs(argv) {
  const value = (flag) => {
    const hit = argv.find((a) => a.startsWith(`${flag}=`));
    return hit ? hit.slice(flag.length + 1) : undefined;
  };
  return { file: value("--file"), dry: argv.includes("--dry-run") };
}

async function fetchExisting() {
  const res = await fetch(`${CORE}/entities?type=${VENTURE_TYPE}&limit=${FIND_LIMIT}`);
  if (!res.ok) throw new Error(`GET /entities → ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const body = await res.json();
  // Ручка отдаёт массив; форму `{items}` терпим, чтобы импортёр не сломался от
  // пагинации, если она когда-нибудь появится.
  const rows = Array.isArray(body) ? body : (body?.items ?? []);
  if (rows.length >= FIND_LIMIT) {
    console.log(`⚠ реестр вернул ${rows.length} карточек при пределе ${FIND_LIMIT} — выборка могла быть обрезана.`);
  }
  return rows;
}

async function main() {
  const { file, dry } = parseArgs(process.argv.slice(2));
  if (!file) {
    console.error("Укажи файл сессии: --file=data/ventures/<дата>-session-<n>.json [--dry-run]");
    process.exit(1);
  }
  const filePath = path.isAbsolute(file) ? file : path.join(ROOT, file);
  if (!fs.existsSync(filePath)) {
    console.error(`Файл сессии не найден: ${filePath}`);
    process.exit(1);
  }
  if (!TOKEN && !dry) {
    console.error("SERVICE_TOKEN не задан — мутации Core закрыты без него (возьми из .env).");
    process.exit(1);
  }

  const seed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  const cards = Array.isArray(seed.cards) ? seed.cards : [];
  if (!seed.session) {
    console.error("В шапке файла нет `session` — без него карточка не знает, из какой она сессии.");
    process.exit(1);
  }

  // Предпросмотр обязан работать без Core: карточки пишутся на ноутбуке
  // владельца, а Core слушает на сервере. Но тогда дедуп по реестру не
  // проверен, и об этом говорится прямо, а не подразумевается.
  let existing = [];
  try {
    existing = await fetchExisting();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!dry) {
      console.error(`Реестр не прочитан (${message}) — без него импорт задвоил бы находки. Остановлено.`);
      process.exit(1);
    }
    console.log(`⚠ Core недоступен (${message}) — план построен только по файлу, дедуп по реестру НЕ проверен.`);
  }

  const { create, skip } = plan(cards, existing);
  const inRegistry = new Set(
    (Array.isArray(existing) ? existing : []).map((e) => e?.externalRef).filter((ref) => typeof ref === "string"),
  );
  const shown = path.relative(ROOT, filePath);
  console.log(`Сессия ${seed.session}, рынок ${seed.market ?? "—"}: файл ${shown.startsWith("..") ? filePath : shown}`);
  for (const card of skip) {
    const ref = seenHash(card.url, card.title);
    // Дубль из реестра и дубль внутри файла — разные новости для владельца:
    // первое значит «уже смотрели», второе — «Scout нашёл дважды за сессию».
    const why = inRegistry.has(ref) ? "уже в реестре" : "дубль внутри сессии";
    console.log(`  = ${card.title} — ${why} (${ref.slice(0, 12)}…)`);
  }

  let failed = 0;
  for (const card of create) {
    const entity = toEntity(card, seed.session, seed.market);
    const total = entity.attrs.softTotal;
    console.log(`  + ${entity.name} — ${card.verdict ?? "без вердикта"}${total !== undefined ? ` (${total}/30)` : ""}`);
    if (dry) continue;
    try {
      const res = await fetch(`${CORE}/entities`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-service-token": TOKEN },
        body: JSON.stringify(entity),
      });
      if (!res.ok) throw new Error(`${res.status}: ${(await res.text()).slice(0, 400)}`);
    } catch (error) {
      // Отказ по одной карточке не должен уносить остальные: сессия — это
      // 3–7 находок, и терять шесть из-за одной битой незачем.
      failed += 1;
      console.log(`  ! не записана: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const created = dry ? create.length : create.length - failed;
  console.log(
    `\nКарточек: ${cards.length}, новых: ${created}, уже в реестре: ${skip.length}` +
      (failed > 0 ? `, ошибок: ${failed}` : "") +
      (dry ? ". Ничего не записано (--dry-run)." : "."),
  );
  process.exit(failed > 0 ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
