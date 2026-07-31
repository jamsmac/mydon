#!/usr/bin/env node
/**
 * Снять отчёт из кабинета VendHub office (vendinghub.uz) и положить в сырой слой.
 *
 * Кабинет не отдаёт ни файла, ни JSON-API: это AJAX-оболочка, где каждая
 * страница приходит куском HTML с server-rendered таблицей. Поэтому «выгрузка»
 * здесь — сама страница отчёта, а разбор живёт в @mydon/shared и покрыт тестами.
 *
 * ЧЕМ ЭТОТ ОТЧЁТ ЦЕНЕН. В строке спрятан раскрывающийся блок, а в нём — JSON
 * заказа (orderNo, machineCode, goodsName, orderPrice…) И ФИСКАЛЬНЫЕ ПОЛЯ:
 * ИКПУ, упаковка, штрих-код, маркировка. Ни в одной другой системе владельца
 * их нет, а без них чек по товару не собирается.
 *
 * ДОСТУП. Кабинет пускает по заголовку `X-Session`. Сессию открывает человек в
 * браузере, скрипт работает уже в открытой. Пароли скрипт не спрашивает и не
 * вводит — то же правило, что и с панелью gjvending.
 *
 * Где взять значение (в браузере, где кабинет уже открыт):
 *   F12 → Application → Local Storage → vendinghub.uz → ключ `session` → id
 *   либо F12 → Network → любой запрос к /office/... → Headers → X-Session
 *
 * ВНИМАНИЕ, ЭТО ВАЖНО. На 31.07.2026 отчёт отдаётся и по сессии, ВЫДАННОЙ
 * АНОНИМУ страницей /office/: логин при этом не спрашивается. Скрипт этим
 * НЕ пользуется намеренно — он требует сессию владельца. Причина простая:
 * когда дыру закроют, сбор должен продолжить работать, а не сломаться. Про
 * саму дыру владельцу сказано отдельно.
 *
 * Запуск на сервере (Core рядом, туннель не нужен):
 *   cd /opt/mydon-app
 *   docker compose -f deploy/docker-compose.yml --env-file .env exec -T \
 *     -e CORE_API_URL=http://127.0.0.1:3001 \
 *     -e VH_OFFICE_SESSION='...' \
 *     mydon-core node tools/fetch-vendinghub.mjs --report operating
 *
 * Сначала стоит посмотреть, что придёт: добавь `--dry`.
 */

// Путь относительный, как у остальных скриптов в tools/: каталог не входит в
// рабочее пространство pnpm, и по имени пакета отсюда ничего не разрешается.
import { parseOfficeReport } from "../packages/shared/dist/vendinghub.js";

const BASE = process.env.VH_OFFICE_BASE ?? "https://vendinghub.uz";
const SESSION = process.env.VH_OFFICE_SESSION ?? "";
const CORE = process.env.CORE_API_URL ?? "http://127.0.0.1:13001";
const KEY = process.env.INGEST_KEY ?? "";

const args = process.argv.slice(2);
const opt = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};
const DRY = args.includes("--dry");

/** Отчёты кабинета: код в справочнике MYDON → путь внутри кабинета. */
const REPORTS = {
  operating: "/office/operatingReport/",
};

const REPORT = opt("report", "operating");
const PATH = opt("path", REPORTS[REPORT]);

/** Пачка строк за раз: тело запроса к Core ограничено мегабайтом. */
const CHUNK = 500;

async function main() {
  if (!PATH) {
    console.error(
      `Неизвестный отчёт «${REPORT}». Известны: ${Object.keys(REPORTS).join(", ")}.\n` +
        "Путь можно задать прямо: --path /office/…/",
    );
    process.exit(1);
  }
  if (!SESSION) {
    console.error(
      "Не задан VH_OFFICE_SESSION.\n" +
        "Открой кабинет в браузере и возьми: F12 → Application → Local Storage →\n" +
        "vendinghub.uz → session → id. Пароль скрипту не нужен и не принимается.",
    );
    process.exit(1);
  }

  const url = `${BASE}${PATH}`;
  process.stdout.write(`Читаю ${url}\n`);
  const res = await fetch(url, {
    headers: { "X-Session": SESSION, "X-Requested-With": "XMLHttpRequest" },
  });
  if (!res.ok) {
    console.error(`Кабинет ответил HTTP ${res.status}. Сессия могла протухнуть — возьми свежую.`);
    process.exit(1);
  }
  const html = await res.text();

  // Кабинет на протухшую сессию отвечает не ошибкой, а коротким телом с
  // просьбой войти. Отличаем это от пустого отчёта: «сессия кончилась» и
  // «данных нет» — разные беды, и путать их нельзя.
  const report = parseOfficeReport(html);
  if (report.columns.length === 0) {
    console.error(
      `Таблицы на странице нет (получено ${html.length} байт).\n` +
        (html.length < 5000
          ? "Похоже, сессия протухла: возьми свежую в браузере."
          : "Похоже, у отчёта другая разметка — проверь путь."),
    );
    process.exit(1);
  }

  process.stdout.write(
    `Колонок ${report.columns.length}, строк ${report.rows.length}` +
      (report.withoutJson > 0 ? `, без JSON заказа ${report.withoutJson}` : "") +
      "\n",
  );
  process.stdout.write(`Колонки: ${report.columns.join(" | ")}\n`);

  if (DRY) {
    process.stdout.write("\nПервая строка:\n");
    for (const [i, c] of report.columns.entries()) {
      process.stdout.write(`   ${c} = ${report.rows[0]?.[i] ?? ""}\n`);
    }
    process.stdout.write("\n--dry: в Core ничего не отправлено.\n");
    return;
  }

  if (!KEY) {
    console.error("Не задан INGEST_KEY: без него Core выгрузку не примет.");
    process.exit(1);
  }

  // Время съёма — сейчас: страница отдаёт то, что в кабинете на эту минуту.
  const fetchedAt = new Date().toISOString();
  let sent = 0;
  for (let i = 0; i < report.rows.length; i += CHUNK) {
    const body = {
      source: "vendinghub",
      report: REPORT,
      fetchedAt,
      columns: report.columns,
      rows: report.rows.slice(i, i + CHUNK),
      offset: i,
      append: i > 0,
      importedBy: "tools/fetch-vendinghub",
      note:
        `Снято со страницы ${PATH}` +
        (report.withoutJson > 0 ? `; строк без JSON заказа: ${report.withoutJson}` : ""),
    };
    const r = await fetch(`${CORE}/raw/import/${encodeURIComponent(KEY)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      console.error(`Core ответил HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`);
      process.exit(1);
    }
    sent += body.rows.length;
    process.stdout.write(`  отправлено ${sent} из ${report.rows.length}\n`);
  }
  process.stdout.write("Готово. Дальше — «Источники → VendHub office».\n");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
