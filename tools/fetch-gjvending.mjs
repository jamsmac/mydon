#!/usr/bin/env node
/**
 * Снять отчёт Order Query из панели gjvending и положить в сырой слой MYDON.
 *
 * Панель отдаёт данные не выгрузкой, а напрямую: POST /api/order/list. За один
 * запрос — тысячи строк. Строки кладутся как пришли, полями API (order_no,
 * machine_code, operate_goods_name…). Роли колонок знают оба словаря панели,
 * поэтому сопоставление с карточками работает одинаково и для файла, и для API.
 *
 * ДОСТУП. Вход в панель защищён капчей, поэтому сессию открывает человек, а
 * скрипт работает уже в открытой: cookie и token берутся из браузера. Пароли
 * скрипт не спрашивает и не вводит.
 *
 * Где взять cookie и token (в браузере, где панель уже открыта):
 *   F12 → Network → любой запрос к /api/... → Headers
 *   Cookie целиком        → VH_PANEL_COOKIE
 *   поле формы `token`    → VH_PANEL_TOKEN
 *
 * ВАЖНО: панель держит ОДНУ сессию на учётную запись. Пока идёт сбор, не
 * входи в панель с другого места — прежняя сессия выбьется, и сбор оборвётся.
 *
 * Запуск на сервере (Core рядом, туннель не нужен):
 *   cd /opt/mydon-app
 *   docker compose -f deploy/docker-compose.yml --env-file .env exec -T \
 *     -e CORE_API_URL=http://127.0.0.1:3001 \
 *     -e VH_PANEL_COOKIE='...' -e VH_PANEL_TOKEN='...' \
 *     mydon-core node tools/fetch-gjvending.mjs --from 2024-05 --to 2026-07
 *
 * Сначала стоит прогнать один месяц: `--from 2026-07 --to 2026-07`.
 */

const BASE = process.env.VH_PANEL_BASE ?? "https://www.gjvending.net";
const COOKIE = process.env.VH_PANEL_COOKIE ?? "";
const TOKEN = process.env.VH_PANEL_TOKEN ?? "";
const LANG = process.env.VH_PANEL_LANG ?? "ru";
const CORE = process.env.CORE_API_URL ?? "http://127.0.0.1:13001";
const KEY = process.env.INGEST_KEY ?? "";

const args = process.argv.slice(2);
const opt = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};
const DRY = args.includes("--dry");
const FROM = opt("from", "2024-05");
const TO = opt("to", new Date().toISOString().slice(0, 7));
/** Сколько строк просить у панели за раз. 5000 проверено на живой панели. */
const PAGE_ROWS = Number(opt("page-rows", 5000));
/** Сколько строк отправлять в Core за раз: тело запроса ограничено мегабайтом. */
const CHUNK = Number(opt("chunk", 1000));
const ACCOUNT = opt("account", null);

/**
 * Порядок полей строки — как их перечисляет сама панель.
 * Порядок колонок это часть данных, поэтому он задан явно, а не выведен из
 * порядка ключей JSON: в JSON порядок ключей не гарантирован ничем.
 */
const COLUMNS = [
  "order_no", "gmt_create", "payment_time", "brewing_time", "gmt_modify",
  "return_time", "return_time_goods", "machine_code", "address", "operate_code",
  "operate_goods_name", "taste_name", "order_source", "order_type",
  "payment_status", "payState", "brewing_status", "orderPrice", "originalPrice",
  "payment_amount", "cup_price", "discountedPrice", "exchange_num", "couponCode",
  "username", "userid", "remark", "oremark", "printerState", "result_code", "action",
];

class SessionDead extends Error {}

function months(a, b) {
  const out = [];
  let [y, m] = a.split("-").map(Number);
  const [ey, em] = b.split("-").map(Number);
  while (y < ey || (y === ey && m <= em)) {
    const first = `${y}-${String(m).padStart(2, "0")}-01`;
    const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
    out.push([first, `${y}-${String(m).padStart(2, "0")}-${lastDay}`]);
    if (m === 12) { y += 1; m = 1; } else { m += 1; }
  }
  return out;
}

async function fetchPage(start, over, page, rows) {
  if (!COOKIE || !TOKEN) {
    throw new SessionDead("не заданы VH_PANEL_COOKIE и VH_PANEL_TOKEN — открой панель в браузере и возьми их оттуда");
  }
  const body = new URLSearchParams({
    token: TOKEN, language: LANG, orderNo: "", goodsName: "", address: "",
    machineCode: "", startDate: start, overDate: over,
    page: String(page), rows: String(rows),
  });
  const res = await fetch(`${BASE}/api/order/list`, {
    method: "POST",
    headers: {
      Cookie: COOKIE,
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      "X-Requested-With": "XMLHttpRequest",
    },
    body,
    signal: AbortSignal.timeout(Number(process.env.VH_TIMEOUT ?? 180) * 1000),
  });
  if (!res.ok) throw new Error(`панель ответила HTTP ${res.status}`);
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    // Живая сессия отдаёт JSON. HTML значит, что нас разлогинило.
    throw new SessionDead("панель вернула не JSON — сессия истекла или её выбил вход с другого места");
  }
  if (json.code === 401 || (json.code !== 1 && json.code !== undefined && !json.rows)) {
    throw new SessionDead(`панель отклонила запрос: ${String(json.msg ?? json.code).slice(0, 120)}`);
  }
  return json;
}

/** Строка панели → массив значений в порядке COLUMNS. Ничего не приводим к типам. */
function toCells(row, columns) {
  return columns.map((c) => {
    const v = row[c];
    return v === null || v === undefined ? "" : String(v);
  });
}

async function push(payload) {
  const res = await fetch(`${CORE}/raw/import/${encodeURIComponent(KEY)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`Core ответил ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

async function main() {
  if (!KEY && !DRY) {
    console.error("Не задан INGEST_KEY: без него Core выгрузку не примет.");
    process.exit(1);
  }
  const period = months(FROM, TO);
  console.log(`Панель: ${BASE}`);
  console.log(`Период: ${FROM} … ${TO} (${period.length} мес.), строк за запрос: ${PAGE_ROWS}`);

  // Сколько всего строк обещает панель за весь период — одним лёгким запросом.
  // Это число ложится в снимок как «сколько было у источника»: если соберём
  // меньше, панель честно скажет об этом надписью «снимок неполный».
  let rowsTotal = null;
  try {
    const probe = await fetchPage(period[0][0], period[period.length - 1][1], 1, 1);
    rowsTotal = Number(probe.total) || null;
    console.log(`Панель показывает за период: ${rowsTotal === null ? "неизвестно" : rowsTotal.toLocaleString("ru-RU")} строк`);
  } catch (err) {
    if (err instanceof SessionDead) {
      console.error(`Сессия не годится: ${err.message}`);
      process.exit(1);
    }
    console.log(`Общее число строк узнать не удалось (${err.message}) — продолжаю без него.`);
  }

  if (DRY) {
    console.log("--dry: сессия рабочая, ничего не отправлено.");
    return;
  }

  // Время съёма одно на весь прогон: все части лягут в ОДИН снимок.
  const fetchedAt = new Date().toISOString();
  const meta = {
    source: "gjvending",
    report: "order_query",
    fetchedAt,
    periodFrom: period[0][0],
    periodTo: period[period.length - 1][1],
    ...(ACCOUNT ? { account: ACCOUNT } : {}),
    ...(rowsTotal ? { rowsTotal } : {}),
    columns: COLUMNS,
    note: `Прямой сбор из /api/order/list за ${FROM}…${TO}`,
    importedBy: "owner",
  };

  let offset = 0;
  let first = true;
  for (const [start, over] of period) {
    let page = 1;
    let read = 0;
    for (;;) {
      const json = await fetchPage(start, over, page, PAGE_ROWS);
      const rows = json.rows ?? [];
      if (rows.length === 0) break;

      // Панель добавила поле, которого нет в нашем порядке колонок. Молча
      // выбросить его нельзя — это потеря данных на слое, который для того и
      // существует, чтобы ничего не терять.
      const extra = [...new Set(rows.flatMap((r) => Object.keys(r)))].filter((k) => !COLUMNS.includes(k));
      if (extra.length > 0) {
        console.error(`Панель отдала неизвестные поля: ${extra.join(", ")}.`);
        console.error("Добавь их в COLUMNS этого скрипта и запусти заново — иначе они потеряются.");
        process.exit(1);
      }

      for (let i = 0; i < rows.length; i += CHUNK) {
        const cells = rows.slice(i, i + CHUNK).map((r) => toCells(r, COLUMNS));
        await push({ ...meta, rows: cells, offset, ...(first ? {} : { append: true }) });
        offset += cells.length;
        first = false;
      }
      read += rows.length;
      process.stdout.write(`  ${start.slice(0, 7)}: ${read.toLocaleString("ru-RU")} строк\r`);

      const total = Number(json.total);
      if (Number.isFinite(total) && read >= total) break;
      page += 1;
    }
    console.log(`  ${start.slice(0, 7)}: ${read.toLocaleString("ru-RU")} строк`);
  }

  console.log(`Готово: ${offset.toLocaleString("ru-RU")} строк в снимке от ${fetchedAt}.`);
  console.log("Открой панель: VendHub → Источники → Order Query → Сопоставление с реестром.");
}

main().catch((err) => {
  if (err instanceof SessionDead) {
    console.error(`Сбор прерван: ${err.message}`);
    console.error("Возьми свежие cookie и token из браузера и запусти заново — уже собранное останется на месте.");
  } else {
    console.error(`Не получилось: ${err.message}`);
  }
  process.exit(1);
});
