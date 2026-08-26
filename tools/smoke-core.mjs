#!/usr/bin/env node
/**
 * Дымовой прогон Core против НАСТОЯЩЕГО Postgres.
 *
 * ЗАЧЕМ. Между «тесты зелёные» и «работает» есть непроверенная зона: весь
 * сырой SQL в сервисах. Заглушка БД в юнит-тестах не исполняет запросы — она
 * возвращает заготовленный ответ на `.delete().where().returning()`, поэтому
 * зеленеет на любом синтаксисе. Шаг CI «Migrations (real postgres)» проверяет
 * только миграции.
 *
 * 07.08.2026 в эту зону зашли дважды за день:
 *   · regexp-нормализация серийника (#116) — прогнали руками до мёржа, пронесло;
 *   · `coilId <> all(${массив})` в уборке слотов (#122) — не прогнали, и прод
 *     ответил 500 на приём слотов: Drizzle разворачивает JS-массив в список
 *     плейсхолдеров, Postgres требует массив («op ANY/ALL (array) requires
 *     array on right side»).
 *
 * ЧТО ДЕЛАЕТ. Поднимает Core, дожидается health и дёргает набор путей, каждый
 * из которых доходит до базы. Цель не в проверке бизнес-логики — её проверяют
 * юнит-тесты, — а в том, чтобы КАЖДЫЙ запрос был выполнен настоящим Postgres
 * хотя бы раз. Ошибка синтаксиса или типов вылезет здесь, а не на проде.
 *
 * Запуск: DATABASE_URL=… SERVICE_TOKEN=… node tools/smoke-core.mjs
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const КОРЕНЬ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// `postgres` — зависимость @mydon/db, в корне монорепо её нет: резолвим оттуда,
// где она объявлена, а не подкладываем вторую копию ради дымового прогона.
const require = createRequire(path.join(КОРЕНЬ, "packages/db/package.json"));
const postgres = require("postgres");

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("DATABASE_URL не задан — дымовой прогон Core выполнять негде.");
  process.exit(1);
}

/** Хост базы — ЕДИНСТВЕННОЕ, что можно печатать наружу: в URL живёт пароль (R-FW-S1). */
function хостБазы(url) {
  try {
    return new URL(url).host || "unix-сокет";
  } catch {
    return "неразбираемый URL";
  }
}

/**
 * Scratch ли база ПО ИМЕНИ. Та же застава, что у `smoke-import.mjs` (R-FW-S9).
 *
 * Проверяется ИМЯ БАЗЫ, а не хост: SSH-туннель на `localhost:5432` обходит
 * заставу по хосту целиком, а имя боевой базы через туннель не меняется.
 */
function scratchПоИмени(url) {
  try {
    return /smoke/i.test(new URL(url).pathname.replace(/^\//, ""));
  } catch {
    return false;
  }
}

// ЗАСТАВА ДО ПЕРВОЙ ЗАПИСИ (R-FW-S9). Этот прогон ПИШЕТ: фикстурные автоматы
// SMOKE-0001, свои пересчёты склада, заявки, накладные, приёмки — и с «Хвостов»
// пересчёты получили витрину в панели и цель ретенции, то есть ошибочный прогон
// по проду стал видимым для владельца, а не только для `curl`. Рядом, в отчётах
// выкатки, операторов учат `export DATABASE_URL=…`; один такой экспорт с боевой
// строкой — и в проде появляются данные, которых никто не заводил. Сообщение
// НЕ несёт строку подключения: в ней пароль.
if (process.env.SMOKE_SCRATCH !== "1" && !scratchПоИмени(DATABASE_URL)) {
  console.error(
    `Смоук Core ПИШЕТ в базу и потому требует явного scratch: SMOKE_SCRATCH=1 либо имя базы со словом «smoke» ` +
      `(хост ${хостБазы(DATABASE_URL)}). Так закрыт SSH-туннель на localhost:5432, которым обходятся заставы по хосту.`,
  );
  process.exit(1);
}

async function свободныйПорт() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : null;
      server.close((error) => {
        if (error) reject(error);
        else if (port === null) reject(new Error("Не удалось выбрать свободный порт"));
        else resolve(String(port));
      });
    });
  });
}

/** Своё подключение к той же базе: сценарий ретенции сеет строку, которую HTTP-путём не датировать. */
const sql = postgres(DATABASE_URL, { prepare: false, max: 1, onnotice: () => {} });

const PORT = process.env.SMOKE_PORT ?? (await свободныйПорт());
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = process.env.SERVICE_TOKEN ?? "smoke-token";
const СТАРТ_ТАЙМАУТ_МС = 60_000;

/** Пути, каждый из которых доходит до базы. Читающие — безопасны и идемпотентны. */
const ЧТЕНИЕ = [
  "/health",
  "/entities?domain=vendhub&type=machine",
  "/entities/machine-cards/all",
  "/maintenance/due",
  "/maintenance/plans",
  "/maintenance/plans?includeInactive=1",
  "/maintenance/log",
  "/maintenance/parts/storage",
  "/sales/aliases",
  "/maintenance/parts/history?model=smoke-model",
  "/vending/machines",
  "/vending/deficit",
  "/vending/plan",
  {
    // Прайс обязан доносить ЭТАЛОН витрины до клиента (П5b): колонка 0068
    // новая, и «поле есть в сервисе» ещё не значит «поле доехало до панели».
    // На засеянной базе эталон не задан — это `null`, а не ноль и не пропуск
    // ключа: пропущенный ключ панель прочтёт как «эталон не пришёл».
    path: "/vending/products",
    проверить: (ответ) => {
      if (!Array.isArray(ответ) || ответ.length === 0) throw new Error("прайс вендинга пуст — засеян ли seed-vending?");
      for (const p of ответ) {
        if (!("salePrice" in p)) throw new Error(`у «${p.name}» нет ключа salePrice`);
        if (p.salePrice !== null && typeof p.salePrice !== "number") throw new Error(`salePrice=${p.salePrice} у «${p.name}»`);
      }
    },
  },
  "/vending/sync",
  "/vending/refill-events?days=14",
  {
    // «Хвосты» (R-H-5): потолок ЧТЕНИЯ журнала — 90, а не чужие 30. Юнит на
    // заглушке проверяет зажим, но не то, что DTO пропустит значение через
    // HTTP: `@Max(30)` отдал бы 400 там, где панель рисует кнопку «90 дн».
    path: "/vending/refill-events?days=90",
    проверить: (о) => {
      // R-FW-S7: ответ — ОБЪЕКТ с признаком обрезки, а не голый массив. Лист
      // печатал `${rows.length} событий`, то есть на переполнении говорил ровно
      // «500 событий» и выдавал обрезок за посчитанный итог.
      if (!Array.isArray(о?.rows)) throw new Error("refill-events.rows — не массив");
      if (typeof о?.capped !== "boolean") throw new Error(`refill-events.capped=${о?.capped} — не флаг`);
      if (о.rows.length <= 500 && о.capped !== false) throw new Error("capped взведён на неполном списке");
      for (const e of о.rows) {
        for (const k of ["id", "serial", "name", "windowFrom", "windowTo", "units", "slots", "matchedRefillId"]) {
          if (!(k in e)) throw new Error(`в событии журнала нет ключа ${k}`);
        }
      }
    },
  },
  {
    // П8a: история пересчётов склада. Заглушка юнит-теста SQL не исполняет —
    // здесь проверяется, что окно, сортировка по `counted_at` и потолок строк
    // доезжают до настоящего Postgres. На засеянной базе истории нет, и это
    // законный пустой список: `warnings` тогда тоже пуст (предупреждаем только
    // о ЗАДАННОМ товаре, по которому ничего не нашлось).
    path: "/vending/stock-counts?days=90",
    проверить: (о) => {
      if (!Array.isArray(о?.rows)) throw new Error("stock-counts.rows — не массив");
      if (!Array.isArray(о?.warnings)) throw new Error("stock-counts.warnings — не массив");
      if (о?.days !== 90) throw new Error(`stock-counts.days=${о?.days}`);
      if (typeof о?.since !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(о.since))
        throw new Error(`stock-counts.since=${о?.since} — не голые сутки YYYY-MM-DD`);
      // Ключ `note` обязан ПРИСУТСТВОВАТЬ, даже когда он null: лист группирует
      // по нему, и его отсутствие — это одна безымянная куча вместо истории.
      //
      // На засеянной базе истории здесь ещё нет (чтения идут ДО записей), и
      // молчаливый `for` по пустому массиву проверял бы ровно ничего. Поэтому
      // пустой ответ ЗДЕСЬ пропускается ВСЛУХ, а настоящая проверка поля стоит
      // там, где строки есть по построению — сценарий двух пересчётов подряд.
      if ((о.rows ?? []).length === 0) {
        console.log("      (истории склада на засеянной базе нет — note проверяет сценарий двух пересчётов)");
      } else {
        for (const r of о.rows) {
          if (!("note" in r)) throw new Error("в строке истории склада нет ключа note");
          if (r.note !== null && typeof r.note !== "string") throw new Error(`note=${r.note} — не строка и не null`);
        }
      }
    },
  },
  {
    // Пустое значение — окно по умолчанию, а не 400 (то же правило, что у
    // `?runs=` здоровья сбора: панель шлёт незаполненный фильтр как есть).
    path: "/vending/stock-counts?days=",
    проверить: (о) => {
      if (о?.days !== 90) throw new Error(`пустой ?days= дал окно ${о?.days}, а не дефолт`);
    },
  },
  {
    // Верхняя граница окна стоит на ВХОДЕ, и это 730 суток, не 365
    // (R-FW-P3, П8a fix wave; адверсариал прод-данные №3): начальный остаток
    // донора датирован 2025-08-17, и потолок в год НИКОГДА не показал бы 26
    // самых старых строк истории. На проде `?days=730` возвращает все 460
    // строк донора (см. чек-лист выкатки в docs) — здесь, на пустой
    // засеянной базе, проверяем только то, что окно доезжает до сервиса, а
    // не режется старой границей.
    path: "/vending/stock-counts?days=730",
    проверить: (о) => {
      if (о?.days !== 730) throw new Error(`stock-counts.days=${о?.days}, ждали 730 (потолок П8a fix wave)`);
      // `since` едет и на границе окна: подпись листа «с ДД.ММ.ГГГГ» берётся
      // из ответа, и на самом широком окне ей веры должно быть столько же.
      if (typeof о?.since !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(о.since))
        throw new Error(`stock-counts?days=730 → since=${о?.since} — не голые сутки YYYY-MM-DD`);
    },
  },
  {
    // Сводка снабжения: SQL с коррелированным подзапросом по последним суткам
    // каждого автомата плюс поле `source` — по нему владелец отличает «считаем
    // сами» от «читаем чужую базу» (П2/П4 поглощения).
    path: "/supply/summary",
    проверить: (ответ) => {
      if (!["own", "stock"].includes(ответ?.source)) throw new Error(`supply.summary.source=${ответ?.source}`);
      if (typeof ответ?.emptyPositions !== "number") throw new Error("supply.summary.emptyPositions — не число");
    },
  },
  {
    // Усушка (П4): весь расчёт идёт по снимкам, продажам и событиям заливок —
    // четыре выборки, которых заглушка юнит-теста не исполняет.
    path: "/vending/shrinkage?days=14",
    проверить: (ответ) => {
      if (!Array.isArray(ответ?.machines)) throw new Error("shrinkage.machines — не массив");
      if (!Array.isArray(ответ?.warnings)) throw new Error("shrinkage.warnings — не массив");
      if (typeof ответ?.threshold !== "number") throw new Error("shrinkage.threshold — не число");
    },
  },
  {
    // П5b: маржа. Выборка продаж окна по ташкентским суткам плюс себестоимость
    // из принятых накладных — запросы, которых заглушка юнит-теста не
    // исполняет. На засеянной базе продаж нет, и отчёт ОБЯЗАН сказать это
    // словами: нули без предупреждения читались бы как «маржа ноль».
    path: "/vending/margin?days=30",
    проверить: (о) => {
      for (const ключ of ["machines", "products", "unknownProducts", "excluded", "warnings"]) {
        if (!Array.isArray(о?.[ключ])) throw new Error(`margin.${ключ} — не массив`);
      }
      if (typeof о?.totals?.revenue !== "number") throw new Error("margin.totals.revenue — не число");
      if (typeof о?.lowPct !== "number") throw new Error("margin.lowPct — не число (порог не прочитан из настроек)");
      if (о.machines.length === 0 && !о.warnings.some((w) => w.code === "no_sales")) {
        throw new Error("пустая маржа без предупреждения no_sales — нули выданы за результат");
      }
    },
  },
  {
    // П5b: мёртвый сток. Три выборки движения (продажи, заливки по снимкам,
    // принятые накладные) плюс остаток склада и автоматов.
    path: "/vending/dead-stock?days=21",
    проверить: (о) => {
      for (const ключ of ["warehouse", "machines", "warnings"]) {
        if (!Array.isArray(о?.[ключ])) throw new Error(`dead-stock.${ключ} — не массив`);
      }
      if (typeof о?.totalValue !== "number") throw new Error("dead-stock.totalValue — не число");
      if (typeof о?.since !== "string") throw new Error("dead-stock.since — не дата окна");
      if (!о.warnings.some((w) => w.code === "no_sales")) {
        throw new Error("без продаж весь остаток выглядит мёртвым — это обязано быть сказано");
      }
    },
  },
  {
    // П5b: изменения цен. Ленты собираются из `event` (два типа) и из продаж;
    // `monthly` панель просит без флага, поэтому поле обязано быть всегда.
    path: "/vending/price-changes?days=30",
    проверить: (о) => {
      for (const ключ of ["purchase", "retail", "monthly", "warnings"]) {
        if (!Array.isArray(о?.[ключ])) throw new Error(`price-changes.${ключ} — не массив`);
      }
      if (typeof о?.pct !== "number") throw new Error("price-changes.pct — не число");
    },
  },
  {
    // П5b: разрыв витрины. Факт считает общий пакет из тех же строк продаж,
    // эталон — `vending_product.sale_price` (миграция 0068).
    path: "/vending/price-gap?days=14",
    проверить: (о) => {
      for (const ключ of ["rows", "noReference", "warnings"]) {
        if (!Array.isArray(о?.[ключ])) throw new Error(`price-gap.${ключ} — не массив`);
      }
      if (typeof о?.lostTotal !== "number") throw new Error("price-gap.lostTotal — не число");
    },
  },
  {
    // П5b: недельная сводка. Внутри — четыре расчёта (маржа недели, маржа
    // предыдущей недели, мёртвый сток, цены) плюс четыре недельных агрегата
    // (заливки, приходы, инвентаризации) и здоровье сбора: заглушка юнит-теста
    // не исполняет ни одного из этих запросов. На засеянной базе продаж нет —
    // и сводка ОБЯЗАНА назвать это пустотой, а не нулевой маржой.
    path: "/vending/weekly-digest",
    проверить: (о) => {
      if (!/^\d{4}-\d{2}$/.test(о?.week)) throw new Error(`weekly-digest.week=${о?.week} — не ключ ISO-недели`);
      if (!/^\d{4}-\d{2}$/.test(о?.previousWeek)) throw new Error("weekly-digest.previousWeek — не ключ ISO-недели");
      for (const ключ of ["from", "to"]) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(о?.[ключ])) throw new Error(`weekly-digest.${ключ} — не ташкентские сутки`);
      }
      if (о.from >= о.to) throw new Error("weekly-digest: понедельник недели не раньше воскресенья");
      for (const ключ of ["machines", "topProducts", "worstProducts"]) {
        if (!Array.isArray(о?.[ключ])) throw new Error(`weekly-digest.${ключ} — не массив`);
      }
      if (!Array.isArray(о?.deadStock?.rows)) throw new Error("weekly-digest.deadStock.rows — не массив");
      for (const ключ of ["purchase", "retail"]) {
        if (!Array.isArray(о?.priceChanges?.[ключ])) throw new Error(`weekly-digest.priceChanges.${ключ} — не массив`);
      }
      for (const ключ of ["refills", "intake", "stocktakes"]) {
        if (typeof о?.[ключ] !== "object" || о[ключ] === null) throw new Error(`weekly-digest.${ключ} — не объект`);
      }
      if (о.stocktakes.lastCountedAt !== null && typeof о.stocktakes.lastCountedAt !== "string") {
        throw new Error("weekly-digest.stocktakes.lastCountedAt — не ISO и не null");
      }
      if (typeof о?.delta?.qty !== "number") throw new Error("weekly-digest.delta.qty — не число");
      if (о.machines.length === 0 && о.totals.pct !== null) {
        throw new Error("неделя без продаж отдала процент маржи — нули выданы за результат");
      }
      if (о?.health?.parity == null) throw new Error("weekly-digest.health.parity — null (сверять нечего ≠ паритета нет)");
      // Здоровье ЗА ОТЧЁТНУЮ НЕДЕЛЮ (R-H-9) — рядом с «сейчас», а не вместо:
      // блок, подписанный неделей, но посчитанный моментом отправки, — дефект O7.
      const w = о?.weekHealth;
      if (!w) throw new Error("в сводке нет weekHealth — письмо снова говорило бы про момент отправки");
      if (w.week !== о.week) throw new Error(`weekHealth.week=${w.week}, а письмо про ${о.week}`);
      const разряды = ["success", "partial", "failed", "running"];
      for (const k of [...разряды, "runs", "worstFailedStreak", "parityGreen", "parityRed"]) {
        if (typeof w[k] !== "number") throw new Error(`weekHealth.${k} — не число`);
      }
      // Итог и разряды печатаются в письме ОДНОЙ строкой и обязаны сходиться.
      const сумма = разряды.reduce((n, k) => n + w[k], 0);
      if (w.runs !== сумма) throw new Error(`weekHealth.runs=${w.runs}, а сумма разрядов ${сумма}`);
      for (const k of ["partialWeek", "capped"]) {
        if (typeof w[k] !== "boolean") throw new Error(`weekHealth.${k} — не флаг`);
      }
      if (!Array.isArray(w.parityDays)) throw new Error("weekHealth.parityDays — не массив");
      // `null` — «данные в неделю не приезжали ВОВСЕ», и это не ноль часов.
      if (w.lastDataAt !== null && typeof w.lastDataAt !== "string") throw new Error("weekHealth.lastDataAt — не ISO и не null");
      // Понедельничное письмо всегда про ЗАКОНЧЕННУЮ неделю: `?week=` текущей
      // гасится нормализацией, и взведённый флаг тут значил бы, что она сломана.
      if (w.partialWeek) throw new Error("weekHealth.partialWeek — сводка отдала неделю, которая ещё идёт");
      if (typeof о?.health?.failedStreak !== "number") throw new Error("health «сейчас» пропал из сводки");
      // Секция, которая не посчиталась, обязана быть НАЗВАНА: сводка больше не
      // падает в 500 из-за здоровья сбора, и молчаливая пустота вместо секции
      // читалась бы как «там всё хорошо».
      if (!Array.isArray(о?.warnings)) throw new Error("weekly-digest.warnings — не массив");
    },
  },
  {
    // Пустое значение параметра — документированный «дефолт», а не 400:
    // такую ссылку легче лёгкого собрать руками.
    path: "/vending/weekly-digest?week=",
    проверить: (о) => {
      if (!/^\d{4}-\d{2}$/.test(о?.week)) throw new Error(`weekly-digest?week= → week=${о?.week}`);
    },
  },
  {
    // Неделя вне рабочего диапазона гасится в предыдущую — как негодный ключ.
    // Иначе `?week=` даёт полмиллиона годных ключей, каждый из которых
    // гарантированно мимо кеша (adversarial-security, п. 2).
    path: "/vending/weekly-digest?week=1990-01",
    проверить: (о) => {
      if (о?.week === "1990-01") throw new Error("неделя из 1990-го посчиталась — граница диапазона не действует");
      if (!/^\d{4}-\d{2}$/.test(о?.week)) throw new Error(`weekly-digest.week=${о?.week}`);
      if (о.from < "2024-01-01") throw new Error(`окно ${о.from} старше двух лет — нормализация промахнулась`);
    },
  },
  {
    // Паритет: сырой SQL с канонизацией серийника, теперь в двух половинах
    // (продажи и остатки). Ровно тот класс запросов, ради которого заведён
    // этот прогон.
    path: "/ourvend/parity?days=7",
    проверить: (ответ) => {
      if (!Array.isArray(ответ?.mismatches)) throw new Error("parity.mismatches — не массив");
      if (!Array.isArray(ответ?.stock?.mismatches)) throw new Error("parity.stock.mismatches — не массив");
      if (typeof ответ?.checked !== "number") throw new Error("parity.checked — не число");
      // R-FW-P1a: «в допуске» — ОТДЕЛЬНОЕ число рядом с «совпало», иначе допуск
      // становится способом не заметить убыль остатка.
      if (typeof ответ?.stock?.withinTolerance !== "number") throw new Error("parity.stock.withinTolerance — не число");
      if (typeof ответ?.stock?.tolerance !== "number") throw new Error("parity.stock.tolerance — не число");
      if (!["mirror", "own-vs-donor", "retired"].includes(ответ?.mode)) {
        throw new Error(`parity.mode=${ответ?.mode} — не один из mirror/own-vs-donor/retired`);
      }
    },
  },
  {
    // П8b: серия считается по журналу событий сырым чтением payload — заглушка
    // юнит-теста jsonb не разбирает. На засеянной базе событий нет вовсе, и
    // ответ обязан быть «ноль зелёных», а не пустотой без ключей.
    path: "/ourvend/parity/streak",
    проверить: (о) => {
      if (typeof о?.greenDays !== "number") throw new Error("streak.greenDays — не число");
      if (typeof о?.threshold !== "number") throw new Error("streak.threshold — не число");
      if (typeof о?.readyForCutover !== "boolean") throw new Error("streak.readyForCutover — не булево");
      if (!Array.isArray(о?.days)) throw new Error("streak.days — не массив");
      if (о.lastRed !== null && typeof о.lastRed !== "string") throw new Error("streak.lastRed — не дата и не null");
      if (о.greenDays !== 0 || о.readyForCutover !== false) throw new Error("на пустом журнале серия обязана быть нулевой");
    },
  },
  {
    // Верхняя граница окна сверки: без неё число доезжало до `sql.raw` в
    // сыром SQL, и запрос читал бы всю историю снимков.
    path: "/ourvend/parity?days=31",
    ждёмОтказ: true,
  },
  {
    // Пустое значение — дефолт (7 суток), а не 400.
    path: "/ourvend/parity?days=",
    проверить: (ответ) => {
      if (ответ?.days !== 7) throw new Error(`пустой ?days= дал окно ${ответ?.days}, а не дефолт`);
    },
  },
  {
    // Пустое значение — дефолт, а не 400 (то же правило, что у `?week=`).
    path: "/ourvend/health?runs=",
    проверить: (о) => {
      if (!Array.isArray(о?.runs)) throw new Error("health.runs — не массив");
    },
  },
  {
    // П5b: здоровье сбора. Четыре запроса «последняя строка» по трём таблицам
    // снимков и журналу прогонов плюс весь SQL паритета. На засеянной базе
    // снимков нет вовсе — и лаг ОБЯЗАН быть `null`, а не `0`: ноль читался бы
    // как «только что сняли», то есть ровно наоборот.
    path: "/ourvend/health?runs=20",
    проверить: (о) => {
      if (!Array.isArray(о?.runs)) throw new Error("health.runs — не массив");
      if (typeof о?.failedStreak !== "number") throw new Error("health.failedStreak — не число");
      for (const ключ of ["slotsLagMin", "salesLagH", "productSaleLagH"]) {
        if (о?.[ключ] !== null && typeof о?.[ключ] !== "number") throw new Error(`health.${ключ} — не число и не null`);
      }
      if (о.lastSuccessAt !== null && typeof о.lastSuccessAt !== "string") {
        throw new Error("health.lastSuccessAt — не ISO и не null");
      }
      // П8a: давность успеха и порог застоя. Ключи ОБЯЗАНЫ присутствовать —
      // пропущенный ключ витрина прочтёт как «поле не приехало», а не как
      // «успехов не было». Порог едет числом, чтобы бот и панель сравнивали с
      // базой, а не со своей копией константы.
      if (!("staleHours" in о)) throw new Error("health.staleHours — ключа нет");
      if (о.staleHours !== null && typeof о.staleHours !== "number") {
        throw new Error(`health.staleHours=${о.staleHours} — не число и не null`);
      }
      if (typeof о.staleThresholdH !== "number") throw new Error("health.staleThresholdH — не число");
      // П8b: гейт катовера. Ключи ОБЯЗАНЫ присутствовать — витрина рисует
      // «N зелёных дней из 7» сравнением двух ЧИСЕЛ ответа, и пропущенный ключ
      // она прочтёт как «поле не приехало», а не как «серии нет».
      for (const ключ of ["parityStreak", "cutoverThreshold"]) {
        if (typeof о[ключ] !== "number") throw new Error(`health.${ключ} — не число`);
      }
      if (о.cutoverThreshold < 1) throw new Error("порог катовера меньше суток — гейт снят опиской в настройке");
      // П8b: вердикт «учётный снапшот встал» (R-P8b-5). Ключ ОБЯЗАН быть, даже
      // когда он `false`: витрина отличает «учёт стоит» от «поле не приехало»
      // только его наличием. На засеянной базе снимков нет вовсе — и в режиме
      // `own` (без STOCK_DATABASE_URL другого режима не бывает) это `true`:
      // «снимков нет» тревожнее «снимки старые».
      if (typeof о.snapshotStale !== "boolean") throw new Error("health.snapshotStale — не булево");
      if (о.lastSuccessAt === null && о.staleHours !== null) {
        throw new Error("успехов нет, а давность посчиталась — «не было вовсе» ≠ «ноль часов»");
      }
      if (о?.parity == null) throw new Error("health.parity — null (сверять нечего ≠ паритета нет)");
      if (typeof о.parity.days !== "number" || typeof о.parity.mismatches !== "number") {
        throw new Error("health.parity.days/mismatches — не числа");
      }
      if (typeof о.parity.stockOk !== "boolean") throw new Error("health.parity.stockOk — не флаг");
      // Сверенных пар — числом по обеим половинам: «расхождений 0» при
      // `ok: false` без них читается как «всё плохо, но расхождений нет».
      for (const ключ of ["checked", "stockChecked"]) {
        if (typeof о.parity[ключ] !== "number") throw new Error(`health.parity.${ключ} — не число`);
      }
      // R-FW-P3: С ЧЕМ сверялись. Без режима витрина не отличает «сверили с
      // независимой стороной и всё сошлось» от «сверять было не с чем»: на
      // засеянной базе (без STOCK_DATABASE_URL) это как раз `retired`.
      if (!["mirror", "own-vs-donor", "retired"].includes(о.parity.mode)) {
        throw new Error(`health.parity.mode=${о.parity.mode} — не один из mirror/own-vs-donor/retired`);
      }
      if (о.runs.length === 0 && (о.failedStreak !== 0 || о.lastSuccessAt !== null)) {
        throw new Error("прогонов нет, а серия/успех не пусты — журнал прочитан не оттуда");
      }
      if (о.runs.length > 20) throw new Error("health.runs длиннее запрошенного — граница ?runs= не действует");
    },
  },
  "/coffee/locations",
  "/coffee/placements",
  "/tasks",
  "/people",
  "/approvals",
  {
    path: "/registry/briefing",
    проверить: (ответ) => {
      for (const key of ["overdueMoney", "idleMachines", "pendingApprovals", "overdueTasks"]) {
        if (typeof ответ?.[key] !== "number") throw new Error(`briefing.${key} — не число`);
      }
      if (ответ?.tz !== "Asia/Tashkent") throw new Error(`briefing.tz=${ответ?.tz}`);
    },
  },
  // Предел выборки — параметр, а не зашитое число. Раньше он был зашит, и
  // выборка обрезалась молча: проверка реестра видела первые 500 карточек из
  // 1156 и печатала «расхождений не найдено». Заглушка БД `.limit()` не
  // исполняет, поэтому проверить это можно только против живого Postgres.
  {
    path: "/entities?limit=1",
    проверить: (ответ) => {
      if (!Array.isArray(ответ)) throw new Error("ожидали массив карточек");
      if (ответ.length > 1) throw new Error(`limit=1 вернул ${ответ.length} карточек`);
    },
  },
  { path: "/entities?limit=999999", ждёмОтказ: true },
  {
    // П8b: тумблеры катовера обязаны доехать до панели «Система» ЧЕРЕЗ HTTP.
    // Ключ, которого нет в белом списке, панель просто не покажет, и владелец
    // будет искать переключатель, которого в интерфейсе нет.
    path: "/system/config",
    проверить: (о) => {
      const карта = new Map((о ?? []).map((i) => [i.key, i]));
      for (const [ключ, дефолт] of [
        ["OURVEND_ACCOUNTING_SOURCE", "stock"],
        ["CUTOVER_GREEN_DAYS", "7"],
        ["SNAPSHOT_STALE_HOURS", "36"],
        ["SNAPSHOT_RETENTION_DAYS", "180"],
        // «Хвосты» (T7 Q3): у истории склада СВОЙ ключ ретенции, и он обязан
        // доехать до панели «Система» тем же путём. Ключ, выпавший из белого
        // списка контроллера, панель просто не покажет — узнать об этом было
        // бы неоткуда.
        ["STOCK_COUNT_RETENTION_DAYS", "730"],
      ]) {
        const i = карта.get(ключ);
        if (!i) throw new Error(`в /system/config нет ключа ${ключ}`);
        if (i.source === "default" && i.value !== дефолт) throw new Error(`${ключ}=${i.value}, ждали ${дефолт}`);
      }
      if (карта.get("OURVEND_ACCOUNTING_SOURCE").kind !== "select") throw new Error("источник учёта — не select");
      // R-FW-S5: рядом с записанным значением — ДЕЙСТВУЮЩИЙ источник. Без
      // STOCK_DATABASE_URL (а смоук гоняется именно так) записано `stock`, а
      // учёт уже `own`: панель, показывающая одно записанное, врёт на том
      // самом экране, на который смотрят в дни катовера.
      const источник = карта.get("OURVEND_ACCOUNTING_SOURCE");
      if (!["stock", "own"].includes(источник.effective)) {
        throw new Error(`OURVEND_ACCOUNTING_SOURCE.effective=${источник.effective} — не stock и не own`);
      }
      if (!process.env.STOCK_DATABASE_URL && источник.effective !== "own") {
        throw new Error("зеркала нет, а действующий источник не own — фолбэк не применён");
      }
      // Пустой вариант первым — задокументированный откат шага 1 катовера.
      if ((источник.options ?? [])[0] !== "") throw new Error("у источника учёта нет пустого варианта для сброса");
      if (карта.get("STOCK_PARITY_TOLERANCE") === undefined) throw new Error("нет ключа STOCK_PARITY_TOLERANCE");
      if (о.some((i) => /API_KEY|TOKEN|SECRET|PASSWORD/i.test(i.key))) throw new Error("в тумблерах секрет");
    },
  },
];

/**
 * Записи, ради которых всё и затевалось: они несут сырой SQL.
 *
 * `/vending/ingest` — тот самый путь, где жила уборка слотов с `<> all(...)`.
 * Отправляем два слота, потом один: второй вызов ОБЯЗАН выполнить DELETE
 * лишнего, то есть пройти по ветке, которая уронила прод.
 */
/**
 * Автомат и окно для сценария детектора заливок (П4). Время берётся ОТ
 * ТЕКУЩЕГО момента: прогон детектора смотрит на сутки назад, а сам смоук
 * гоняют и по второму разу на одной базе.
 */
const P4_АВТОМАТ = "SMOKE-P4";
/** Товар из прайса вендинга (seed-vending) — на нём проверяется бэкфилл ссылки. */
const P4_ТОВАР = "Coca-Cola Classic 0,5";
const P4_ДО = new Date(Date.now() - 2 * 3_600_000);
const P4_ПОСЛЕ = new Date(Date.now() - 3_600_000);

const ЗАПИСЬ = [
  {
    имя: "приём слотов (первый снимок)",
    path: "/vending/ingest",
    body: {
      machines: [
        {
          serial: "SMOKE-0001",
          slots: [
            { coilId: "1", product: "Smoke A", capacity: 5, quantity: 5 },
            { coilId: "2", product: "Smoke B", capacity: 5, quantity: 4 },
          ],
        },
      ],
    },
  },
  {
    имя: "приём слотов (слот исчез → уборка зеркала)",
    path: "/vending/ingest",
    body: {
      machines: [
        {
          serial: "SMOKE-0001",
          slots: [{ coilId: "1", product: "Smoke A", capacity: 5, quantity: 3 }],
        },
      ],
    },
    проверить: (ответ) => {
      if (ответ.pruned !== 1) {
        throw new Error(`уборка не сработала: pruned=${ответ.pruned}, ожидали 1`);
      }
    },
  },
  // ── Детектор заливок по снимкам (П4) ────────────────────────────────────
  //
  // Заглушка БД в юнит-тестах не исполняет ни оконную выборку `slot_snapshot`,
  // ни `jsonb` со слотами, ни `onConflictDoNothing` по составному уникальному
  // ключу (serial, window_to) — а именно на этом ключе держится идемпотентность
  // крона, который бежит по перекрывающемуся окну каждые 3 часа. Поэтому пара
  // снимков подаётся НАСТОЯЩЕЙ: «до» и «после» с приходом 14 единиц.
  {
    имя: "приём слотов П4 (снимок «до»)",
    path: "/vending/ingest",
    body: {
      capturedAt: P4_ДО.toISOString(),
      machines: [
        {
          serial: P4_АВТОМАТ,
          slots: [
            { coilId: "1", product: "Smoke P4 A", capacity: 20, quantity: 1 },
            { coilId: "2", product: "Smoke P4 B", capacity: 20, quantity: 0 },
          ],
        },
      ],
    },
  },
  {
    имя: "приём слотов П4 (снимок «после»: приход 14 единиц)",
    path: "/vending/ingest",
    body: {
      capturedAt: P4_ПОСЛЕ.toISOString(),
      machines: [
        {
          serial: P4_АВТОМАТ,
          slots: [
            { coilId: "1", product: "Smoke P4 A", capacity: 20, quantity: 9 },
            { coilId: "2", product: "Smoke P4 B", capacity: 20, quantity: 6 },
          ],
        },
      ],
    },
  },
  {
    имя: "детектор заливок по снимкам (П4)",
    path: "/vending/refill-events/detect",
    body: { days: 1 },
    проверить: (о) => {
      for (const key of ["machines", "events", "matched"]) {
        if (typeof о?.[key] !== "number" || о[key] < 0) throw new Error(`detect.${key}=${о?.[key]}`);
      }
      if (!Array.isArray(о.skipped)) throw new Error("detect.skipped — не массив");
      for (const s of о.skipped) {
        if (!["dead", "uncalibrated", "no_slots"].includes(s?.reason)) throw new Error(`skipped.reason=${s?.reason}`);
      }
      if (о.events < 1) throw new Error(`детектор не увидел заливку: events=${о.events}`);
      if (о.matched !== 0) throw new Error(`записи оператора ещё нет, а matched=${о.matched}`);
    },
  },
  {
    // Тот самый повтор, ради которого стоит уникальный ключ.
    имя: "детектор заливок (повтор по тому же окну — дубля нет)",
    path: "/vending/refill-events/detect",
    body: { days: 1 },
    проверить: (о) => {
      if (о.events !== 0) throw new Error(`повторный прогон записал ${о.events} событий`);
    },
  },
  {
    имя: "заливка оператора в окне детектора",
    path: "/vending/refills",
    body: {
      machineSerial: P4_АВТОМАТ,
      productName: "Smoke P4 A",
      qty: 8,
      performedAt: new Date(P4_ПОСЛЕ.getTime() - 30 * 60_000).toISOString(),
      clientKey: `smoke-p4-${P4_ПОСЛЕ.getTime()}`,
      source: "panel",
    },
    проверить: (о) => {
      if (о?.duplicate !== false) throw new Error("заливка должна записаться впервые");
    },
  },
  {
    // Оператор дошёл до бота после прогона: событие уже записано, дубля не
    // будет, и без UPDATE запись осталась бы «заливкой без отчёта» навсегда.
    имя: "детектор доклеивает запись оператора к событию",
    path: "/vending/refill-events/detect",
    body: { days: 1 },
    проверить: (о) => {
      if (о.events !== 0) throw new Error(`доклейка не должна плодить события: events=${о.events}`);
      if (о.matched < 1) throw new Error("запись оператора не сопоставилась с событием");
    },
  },
  // ── Бэкфилл product_id: ветка КОНФЛИКТА (П4) ────────────────────────────
  //
  // Оба апсерта пишут `product_id` сырым SQL (`coalesce(excluded.…)` и
  // `case … is distinct from …`), а заглушка БД в юнит-тестах SQL не исполняет
  // — она проверяет только ТЕКСТ выражения. Синтаксис и семантику проверяет
  // этот сценарий: товар из прайса кладётся дважды (повтор → ветка конфликта),
  // потом слот меняет товар на неизвестный.
  {
    имя: "склад: первый пересчёт известного товара (product_id проставлен)",
    path: "/vending/stock",
    body: { items: [{ product: P4_ТОВАР, quantity: 5 }] },
  },
  {
    имя: "склад: повторный пересчёт — ссылка на карточку уцелела",
    path: "/vending/stock",
    body: { items: [{ product: P4_ТОВАР, quantity: 7 }] },
    после: async () => {
      const строки = await читать("/vending/stock");
      const строка = строки.find((r) => r.product === P4_ТОВАР);
      if (!строка) throw new Error(`строка склада «${P4_ТОВАР}» не найдена`);
      if (строка.quantity !== 7) throw new Error(`пересчёт не применился: quantity=${строка.quantity}`);
      // Строго: прогон обязан идти по базе с прайсом (`seed-vending.js` в
      // шаге CI). Молчаливое «прайса нет, проверку пропустили» — это способ
      // однажды перестать проверять и не заметить.
      if (строка.productId === null) {
        throw new Error(
          `product_id обнулился повторным пересчётом (или прайс вендинга не засеян: node packages/db/dist/seed-vending.js)`,
        );
      }
      // П8a: два пересчёта подряд — РОВНО две строки истории. Это проверка
      // того самого частичного уникального индекса (0069) против настоящего
      // Postgres: `onConflictDoNothing` с предикатом `source = 'own'` в
      // заглушке юнит-теста не исполняется вовсе, а ошибка в предикате даёт
      // либо «no unique constraint matching», либо молчаливую потерю строки.
      const история = await читать(`/vending/stock-counts?product=${encodeURIComponent(P4_ТОВАР)}`);
      const свои = история.rows.filter((r) => r.product === P4_ТОВАР);
      if (свои.length < 2) {
        throw new Error(`история пересчётов «${P4_ТОВАР}»: строк ${свои.length}, ожидали два пересчёта подряд`);
      }
      const [первая, вторая] = свои; // ответ отсортирован «свежее сверху»
      // Количества именно ЭТОГО прогона, а не «сколько всего строк»: смоук
      // могли пустить и по базе, где история уже есть.
      if (первая.qty !== 7 || вторая.qty !== 5) {
        throw new Error(`два свежих пересчёта дали ${первая.qty}/${вторая.qty}, ожидали 7/5`);
      }
      if (!(первая.countedAt > вторая.countedAt)) throw new Error("история отдана не «свежее сверху»");
      if (первая.source !== "own" || вторая.source !== "own") {
        throw new Error(`свой пересчёт помечен не «own»: ${первая.source}/${вторая.source}`);
      }
      // «Хвосты» (R-H-2): у СВОЕЙ строки `note` — это КТО считал. Контроллер
      // зовёт `ingestStock(dto)` без актора, значит доехать обязано «owner».
      // Проверка стоит здесь, а не на шаге чтения: там на засеянной базе строк
      // нет вовсе, и цикл по `rows` не делал бы ни одной итерации.
      if (первая.note !== "owner" || вторая.note !== "owner") {
        throw new Error(`note своего пересчёта: ${первая.note}/${вторая.note}, ждали owner/owner`);
      }
    },
  },
  {
    имя: "приём слотов: смена товара в слоте на неизвестный (ветка конфликта)",
    path: "/vending/ingest",
    body: {
      machines: [
        {
          serial: P4_АВТОМАТ,
          slots: [
            { coilId: "1", product: "Smoke P4 Загадка", capacity: 20, quantity: 9 },
            { coilId: "2", product: "Smoke P4 B", capacity: 20, quantity: 6 },
          ],
        },
      ],
    },
    проверить: (о) => {
      if (о.slots !== 2) throw new Error(`ожидали 2 слота, получили ${о.slots}`);
    },
  },
  {
    имя: "приём продаж (привязка автомата по канону серийника)",
    path: "/vending/ingest-sales",
    body: {
      periodStart: "2026-08-01T00:00:00.000Z",
      periodEnd: "2026-08-07T00:00:00.000Z",
      productSales: [{ serial: "SMOKE-0001", product: "Smoke A", quantity: 3 }],
      machineSales: [{ serial: "SMOKE-0001", totalAmount: 15000, totalCount: 3 }],
    },
  },
  {
    // Ответ 200 с ok:false — штатный отказ сервиса (не 4xx), поэтому проверяем
    // тело: путь дошёл до базы и вернул решение, а не упал на SQL.
    имя: "правила товара (не найден → not_found)",
    path: "/vending/product-rules",
    body: { product: "Smoke Нет Такого", packSize: 5 },
    проверить: (о) => {
      if (о.ok !== false) throw new Error("ожидали not_found");
      if (о.reason !== "not_found") throw new Error(`reason=${о.reason}`);
    },
  },
  {
    // П5b: бутстрап эталонов витрины. На засеянной базе продаж (`sale`) нет —
    // значит проставить нечего, и весь смысл проверки в том, что путь ДОШЁЛ до
    // базы: агрегат Σamount/Σqty с окном по ташкентским суткам заглушка не
    // исполняет, а Postgres — да. Пропущенные обязаны быть НАЗВАНЫ: молчаливый
    // пустой ответ читался бы как «эталоны проставлены».
    имя: "витрина как факт: бутстрап эталонов (нет продаж → всех назвали)",
    path: "/vending/sale-price/bootstrap",
    body: { days: 14 },
    проверить: (о) => {
      if (!Array.isArray(о.set)) throw new Error("set — не массив");
      if (!Array.isArray(о.skipped) || о.skipped.length === 0) throw new Error("skipped пуст: пропущенных обязаны назвать");
      // Причин пропуска ЧЕТЫРЕ, и гейт выкатки обязан знать все: `inactive`
      // (товар снят с продажи) и `no_fact` (продажи есть, а цена из них не
      // выводится) законны ровно так же, как две первые. Первый снятый товар
      // в прайсе иначе красил бы CI по чужому поводу.
      const ПРИЧИНЫ = ["already_set", "no_sales", "no_fact", "inactive"];
      const чужие = о.skipped.filter((s) => !ПРИЧИНЫ.includes(s.reason));
      if (чужие.length > 0) throw new Error(`неизвестная причина пропуска: ${JSON.stringify(чужие[0])}`);
      if (!о.skipped.some((s) => s.reason === "no_sales")) throw new Error("ждали товары без факта витрины");
    },
  },
  {
    // Прямая установка эталона: гейт сравнивает с ФАКТОМ витрины, а факта на
    // засеянной базе нет — значит первый эталон проходит без подтверждения.
    имя: "эталон витрины: прямая установка",
    path: "/vending/sale-price",
    body: { product: P4_ТОВАР, price: 15000 },
    проверить: (о) => {
      if (о.ok !== true) throw new Error(`ожидали ok, получили ${JSON.stringify(о)}`);
      if (о.newPrice !== 15000) throw new Error(`newPrice=${о.newPrice}`);
      if (о.factPrice !== null) throw new Error(`факта витрины на засеянной базе быть не должно: ${о.factPrice}`);
    },
    // Ответ записи не показывает, что стало со строкой: проверяем ТЕМ ЖЕ
    // путём, которым прайс читает панель.
    после: async () => {
      const прайс = await читать("/vending/products");
      const строка = прайс.find((p) => p.name === P4_ТОВАР);
      if (!строка) throw new Error(`товара «${P4_ТОВАР}» нет в прайсе`);
      if (строка.salePrice !== 15000) throw new Error(`эталон не доехал до прайса: salePrice=${строка.salePrice}`);
    },
  },
  {
    // Мусорная цена обязана называться мусорной ценой, а не «товар не найден»:
    // DTO её и не пропустит (400), и это тоже часть контракта записи.
    имя: "эталон витрины: цена 0 отвергается на границе (400)",
    path: "/vending/sale-price",
    body: { product: P4_ТОВАР, price: 0 },
    ждёмОтказ: true,
  },
  {
    // Повтор той же командой вдвое дороже. Гейт «точно» сравнивает с ФАКТОМ
    // витрины, а не с прошлым эталоном (R-P5b-6), и на засеянной базе факта
    // нет — значит правка обязана пройти, а не быть отбита как «скачок».
    // Проверяется именно это: молчащий гейт при отсутствии факта — решение,
    // а не недосмотр (иначе первый эталон нового товара было бы не задать).
    имя: "эталон витрины: повтор без факта гейтом не отбивается",
    path: "/vending/sale-price",
    body: { product: P4_ТОВАР, price: 30000 },
    проверить: (о) => {
      if (о.ok !== true) throw new Error(`ожидали ok без факта витрины, получили ${JSON.stringify(о)}`);
      if (о.oldPrice !== 15000) throw new Error(`oldPrice=${о.oldPrice} — прошлый эталон не прочитан`);
      if (о.newPrice !== 30000) throw new Error(`newPrice=${о.newPrice}`);
    },
  },
];

/**
 * Срез Б: место — обычная карточка реестра, аппаратов на нём может быть несколько.
 *
 * Ради этого сценария дымовой прогон и нужен: `linkLocation` — это
 * `and(eq(место), eq(аппарат), isNull(конец))` плюс join размещений с
 * карточками. Заглушка БД в юнит-тестах таких запросов не исполняет, она лишь
 * возвращает заготовленный ответ — и уже дважды зеленела на SQL, который
 * Postgres отвергал.
 */
async function проверитьМеста() {
  const создать = async (type, name) => {
    const r = await fetch(`${BASE}/entities`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-service-token": TOKEN },
      body: JSON.stringify({ domain: "vendhub", type, name }),
      signal: AbortSignal.timeout(20_000),
    });
    const текст = await r.text();
    if (!r.ok) throw new Error(`создание ${type} «${name}» → ${r.status}: ${текст.slice(0, 200)}`);
    return JSON.parse(текст).id;
  };
  const поставить = async (locationId, entityId) => {
    const r = await fetch(`${BASE}/coffee/location-link`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "x-service-token": TOKEN },
      body: JSON.stringify({ locationId, entityId }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!r.ok) throw new Error(`привязка → ${r.status}: ${(await r.text()).slice(0, 200)}`);
  };
  const мест = async () => {
    const r = await fetch(`${BASE}/coffee/locations`, { signal: AbortSignal.timeout(20_000) });
    if (!r.ok) throw new Error(`/coffee/locations → ${r.status}`);
    return JSON.parse(await r.text());
  };

  const place = await создать("location", "Дымовая точка");
  const m1 = await создать("machine", "Дымовой автомат 1");
  const m2 = await создать("machine", "Дымовой автомат 2");

  await поставить(place, m1);
  await поставить(place, m2);
  const после = (await мест()).find((l) => l.id === place);
  if (!после) throw new Error("созданное место не вернулось в /coffee/locations");
  if (после.machines.length !== 2) {
    throw new Error(`на месте ожидали 2 аппарата, вернулось ${после.machines.length}`);
  }

  // Повтор той же привязки период-дубль не открывает.
  await поставить(place, m1);
  const повтор = (await мест()).find((l) => l.id === place);
  if (повтор.machines.length !== 2) {
    throw new Error(`повторная привязка размножила размещения: ${повтор.machines.length}`);
  }

  // Снятие адресуется аппаратом — соседа по месту не трогает.
  const r = await fetch(`${BASE}/coffee/machine-link/${m1}`, {
    method: "DELETE",
    headers: { "x-service-token": TOKEN },
    signal: AbortSignal.timeout(20_000),
  });
  if (!r.ok) throw new Error(`снятие → ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const итог = (await мест()).find((l) => l.id === place);
  if (итог.machines.length !== 1 || итог.machines[0].entityId !== m2) {
    throw new Error(
      `после снятия ожидали ровно второй аппарат, получили ${JSON.stringify(итог.machines)}`,
    );
  }

  // Уход в ремонт с указанием мастерской. Тот же класс сырого SQL: закрытие
  // открытого периода по `and(eq(аппарат), isNull(конец))` плюс вставка нового.
  const shop = await создать("workshop", "Дымовая мастерская");
  const статус = await fetch(`${BASE}/entities/${m2}/machine-status`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", "x-service-token": TOKEN },
    body: JSON.stringify({ status: "repair", placeId: shop, note: "дымовой прогон" }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!статус.ok)
    throw new Error(`ремонт → ${статус.status}: ${(await статус.text()).slice(0, 200)}`);
  const пусто = (await мест()).find((l) => l.id === place);
  if (пусто.machines.length !== 0) {
    throw new Error(
      `уехавший в ремонт всё ещё числится на точке: ${JSON.stringify(пусто.machines)}`,
    );
  }

  // «На складе» требует склада — противоречие должно отвергаться сервером,
  // а не только формой.
  const мимо = await fetch(`${BASE}/entities/${m2}/machine-status`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", "x-service-token": TOKEN },
    body: JSON.stringify({ status: "warehouse", placeId: place }),
    signal: AbortSignal.timeout(20_000),
  });
  if (мимо.ok) throw new Error("«на складе» на точке продаж прошло, а должно было быть отвергнуто");
}

/**
 * Срез В: жизненный цикл узла — установка → занято → снятие в мойку →
 * возврат со склада → история по серийнику.
 *
 * Здесь живёт частичный уникальный индекс `machine_part_open_key`
 * (`where removed_on is null and machine_id is not null`) и парная вставка
 * периодов одной транзакцией — ровно тот SQL, который заглушка юнит-тестов
 * не исполняет.
 */
async function проверитьУзлы() {
  const запрос = async (имя, path, body) => {
    const r = await fetch(`${BASE}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-service-token": TOKEN },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    const текст = await r.text();
    return { ok: r.ok, status: r.status, имя, тело: текст, json: r.ok ? JSON.parse(текст) : null };
  };
  const чтение = async (path) => {
    const r = await fetch(`${BASE}${path}`, { signal: AbortSignal.timeout(20_000) });
    if (!r.ok) throw new Error(`GET ${path} → ${r.status}`);
    return JSON.parse(await r.text());
  };

  const созд = await запрос("автомат", "/entities", {
    domain: "vendhub",
    type: "machine",
    name: `Дымовой автомат узлов ${Date.now()}`,
  });
  if (!созд.ok) throw new Error(`создание автомата → ${созд.status}: ${созд.тело.slice(0, 200)}`);
  const m = созд.json.id;
  const serial = `SMOKE-SN-${Date.now()}`;

  const уст = await запрос("установка", "/maintenance/part-install", {
    machineId: m,
    partKind: "grinder",
    serialNumber: serial,
  });
  if (!уст.ok) throw new Error(`установка узла → ${уст.status}: ${уст.тело.slice(0, 200)}`);
  if (уст.json.installed.location !== "machine") {
    throw new Error(`установленный узел не «на автомате»: ${уст.json.installed.location}`);
  }

  const дубль = await запрос("занятое место", "/maintenance/part-install", {
    machineId: m,
    partKind: "grinder",
  });
  if (дубль.ok) throw new Error("установка на занятое место прошла, а должна была быть отвергнута");

  const снятие = await запрос("снятие", "/maintenance/part-remove", {
    machineId: m,
    partKind: "grinder",
    toLocation: "washing",
  });
  if (!снятие.ok) throw new Error(`снятие узла → ${снятие.status}: ${снятие.тело.slice(0, 200)}`);
  const лежит = снятие.json.stored;
  if (лежит.machineId !== null || лежит.location !== "washing") {
    throw new Error(`снятый узел не в мойке: ${JSON.stringify(лежит)}`);
  }

  const склад = await чтение("/maintenance/parts/storage");
  if (!склад.some((p) => p.id === лежит.id)) {
    throw new Error("снятый узел не вернулся в списке «вне автоматов»");
  }

  const возврат = await запрос("возврат со склада", "/maintenance/part-install", {
    machineId: m,
    partKind: "grinder",
    partId: лежит.id,
  });
  if (!возврат.ok)
    throw new Error(`возврат узла → ${возврат.status}: ${возврат.тело.slice(0, 200)}`);
  if (возврат.json.installed.serialNumber !== serial) {
    throw new Error("серийник не унаследовался при возврате со склада");
  }

  const история = await чтение(`/maintenance/parts/history?serial=${encodeURIComponent(serial)}`);
  // Три периода: на автомате → в мойке → снова на автомате.
  if (история.length < 3) {
    throw new Error(`история по серийнику неполная: ${история.length} периодов, ожидали ≥ 3`);
  }
}

/**
 * Срез Г: продажи по имени товара — карточка товара зовёт /sales/by-product.
 *
 * Таблицу `sale` наполняет только синк из mydon-stock (STOCK_DATABASE_URL),
 * публичного API записи в неё нет — поэтому проверяется ФОРМА ответа и то,
 * что SQL (eq по тексту + группировка + join имён) исполняется живым
 * Postgres, а не количество строк.
 */
async function проверитьПродажиТовара() {
  const r = await fetch(`${BASE}/sales/by-product?name=${encodeURIComponent("Smoke A")}&days=365`, {
    signal: AbortSignal.timeout(20_000),
  });
  if (!r.ok) throw new Error(`/sales/by-product → ${r.status}`);
  const данные = JSON.parse(await r.text());
  if (typeof данные?.total?.qty !== "number" || typeof данные?.total?.amount !== "number") {
    throw new Error(`нет сводки total: ${JSON.stringify(данные).slice(0, 120)}`);
  }
  if (!Array.isArray(данные.machines)) throw new Error("нет разбивки по автоматам");

  // Склейка имён: алиас привязывается, чужое имя не перепривязывается, карточка
  // отдаёт продажи по entityId вместе со списком алиасов.
  const пост = (path, body) =>
    fetch(`${BASE}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-service-token": TOKEN },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
  const карточка = await пост("/entities", {
    domain: "vendhub",
    type: "product",
    name: `Смоук товар ${Date.now()}`,
  });
  if (!карточка.ok) throw new Error(`создание товара → ${карточка.status}`);
  const товарId = JSON.parse(await карточка.text()).id;
  const имя = `Smoke Source ${Date.now()}`;

  const привязка = await пост("/sales/alias", { name: имя, entityId: товарId });
  if (!привязка.ok)
    throw new Error(
      `привязка алиаса → ${привязка.status}: ${(await привязка.text()).slice(0, 200)}`,
    );

  const другая = await пост("/entities", {
    domain: "vendhub",
    type: "product",
    name: `Смоук товар Б ${Date.now()}`,
  });
  const другойId = JSON.parse(await другая.text()).id;
  const перехват = await пост("/sales/alias", { name: имя, entityId: другойId });
  if (перехват.ok) throw new Error("занятый алиас перепривязался молча, а должен был отказать");

  const поКарточке = await fetch(`${BASE}/sales/by-product?entityId=${товарId}&days=90`, {
    signal: AbortSignal.timeout(20_000),
  });
  if (!поКарточке.ok) throw new Error(`/sales/by-product?entityId → ${поКарточке.status}`);
  const пк = JSON.parse(await поКарточке.text());
  if (!Array.isArray(пк.aliases) || !пк.aliases.some((a) => a.name === имя)) {
    throw new Error("привязанный алиас не вернулся в ответе карточки");
  }

  const несвязанные = await fetch(`${BASE}/sales/unmatched-names?days=90`, {
    signal: AbortSignal.timeout(20_000),
  });
  if (!несвязанные.ok) throw new Error(`/sales/unmatched-names → ${несвязанные.status}`);
  if (!Array.isArray(JSON.parse(await несвязанные.text()))) {
    throw new Error("несвязанные имена — не массив");
  }
}

async function jsonRequest(method, path, body, auth = true) {
  const headers = { "Content-Type": "application/json" };
  if (auth) headers["x-service-token"] = TOKEN;
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await r.text();
  let json = null;
  if (text.length > 0) {
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`${method} ${path} вернул не JSON: ${text.slice(0, 160)}`);
    }
  }
  return { r, text, json };
}

/** Согласование должно атомарно создать уже утверждённую карточку. */
async function проверитьСогласование() {
  const marker = `SMOKE-APPROVAL-${Date.now()}`;
  const requested = await jsonRequest("POST", "/approvals", {
    agent: "smoke-agent",
    action: "smoke.registry-import",
    tier: "T1",
    payload: {
      import: {
        domain: "personal",
        type: "smoke_approval",
        records: [{ name: marker, externalRef: marker }],
      },
    },
  });
  if (!requested.r.ok)
    throw new Error(`запрос → ${requested.r.status}: ${requested.text.slice(0, 200)}`);

  const decided = await jsonRequest("POST", `/approvals/${requested.json.id}/decide`, {
    decision: "approved",
    actor: "owner",
  });
  if (!decided.r.ok)
    throw new Error(`решение → ${decided.r.status}: ${decided.text.slice(0, 200)}`);

  const list = await jsonRequest("GET", "/entities?domain=personal&type=smoke_approval&limit=50");
  if (!list.r.ok || !Array.isArray(list.json))
    throw new Error("исполненный импорт не читается из реестра");
  const card = list.json.find((row) => row.externalRef === marker);
  if (!card) throw new Error("одобрение не материализовало карточку");
  if (card.approvedAt === null || card.approvedBy !== "owner") {
    throw new Error(`карточка после одобрения осталась черновиком: ${JSON.stringify(card)}`);
  }

  const repeated = await jsonRequest("POST", `/approvals/${requested.json.id}/decide`, {
    decision: "approved",
  });
  if (repeated.r.ok) throw new Error("повторное решение прошло, хотя запрос уже закрыт");
}

/** Два этапа инкассации и защита от повторного приёма на живом SQL. */
async function проверитьИнкассацию() {
  const machine = await jsonRequest("POST", "/entities", {
    domain: "vendhub",
    type: "machine",
    name: `Дымовой автомат инкассации ${Date.now()}`,
  });
  if (!machine.r.ok)
    throw new Error(`автомат → ${machine.r.status}: ${machine.text.slice(0, 200)}`);

  const collected = await jsonRequest("POST", "/collections", {
    machineId: machine.json.id,
    source: "realtime",
    notes: "smoke",
  });
  if (!collected.r.ok || collected.json.status !== "collected") {
    throw new Error(`сбор → ${collected.r.status}: ${collected.text.slice(0, 200)}`);
  }

  const received = await jsonRequest("POST", `/collections/${collected.json.id}/receive`, {
    amount: 30_000,
    manager: "smoke-owner",
    denominations: { 10000: 3 },
  });
  if (
    !received.r.ok ||
    received.json.status !== "received" ||
    Number(received.json.amount) !== 30_000
  ) {
    throw new Error(`приём → ${received.r.status}: ${received.text.slice(0, 200)}`);
  }

  const repeated = await jsonRequest("POST", `/collections/${collected.json.id}/receive`, {
    amount: 30_000,
  });
  if (repeated.r.ok) throw new Error("повторный приём закрытой инкассации прошёл");
}

/** Договоры и импортные обязательства должны материализоваться атомарно. */
async function проверитьФинансовыеТранзакции() {
  const marker = String(Date.now());
  const contract = await jsonRequest("POST", "/contracts", {
    domain: "globerent",
    contractNo: `SMOKE-${marker}`,
    contractDate: "2026-08-23",
    items: [{ name: "Smoke equipment", qty: 1, price: 1000 }],
    payType: "100",
    docParams: { payDays: 5 },
  });
  if (!contract.r.ok) {
    throw new Error(`договор → ${contract.r.status}: ${contract.text.slice(0, 200)}`);
  }

  const contractBefore = await jsonRequest("GET", `/contracts/${contract.json.id}`);
  if (!contractBefore.r.ok || contractBefore.json.planned?.length !== 1) {
    throw new Error(`график договора не создан: ${contractBefore.text.slice(0, 200)}`);
  }
  const total = Number(contract.json.totalWithVat);
  const payment = await jsonRequest("POST", `/contracts/${contract.json.id}/payments`, {
    amount: total,
    currency: "UZS",
    docNo: `SMOKE-PAY-${marker}`,
  });
  if (!payment.r.ok) {
    throw new Error(`платёж договора → ${payment.r.status}: ${payment.text.slice(0, 200)}`);
  }
  const contractAfter = await jsonRequest("GET", `/contracts/${contract.json.id}`);
  if (
    !contractAfter.r.ok ||
    contractAfter.json.payments?.length !== 1 ||
    contractAfter.json.planned?.length !== 0 ||
    Number(contractAfter.json.paidUzs) !== total
  ) {
    throw new Error(`платёж не закрыл график договора: ${contractAfter.text.slice(0, 240)}`);
  }

  const imported = await jsonRequest("POST", "/imports", {
    domain: "globerent",
    contractNo: `SMOKE-IMPORT-${marker}`,
    contractDate: "2026-08-23",
    currency: "USD",
    items: [{ name: "Smoke import unit", qty: 1, price: 100 }],
    prepaymentAmount: 40,
    prepaymentDueDate: "2026-08-24",
    balanceAmount: 60,
    balanceDueDate: "2026-09-01",
  });
  if (!imported.r.ok) {
    throw new Error(`импортный контракт → ${imported.r.status}: ${imported.text.slice(0, 200)}`);
  }
  const signed = await jsonRequest("PATCH", `/imports/${imported.json.id}/sign`, {});
  if (!signed.r.ok || signed.json.status !== "in_progress" || signed.json.unitsTotal !== 1) {
    throw new Error(`подписание импорта → ${signed.r.status}: ${signed.text.slice(0, 240)}`);
  }
  const paid = await jsonRequest("PATCH", `/imports/${imported.json.id}/paid/prepayment`, {});
  if (!paid.r.ok || paid.json.prepaymentPaidAt === null) {
    throw new Error(`оплата импорта → ${paid.r.status}: ${paid.text.slice(0, 200)}`);
  }
  const paidAgain = await jsonRequest("PATCH", `/imports/${imported.json.id}/paid/prepayment`, {});
  if (paidAgain.r.ok) throw new Error("повторная оплата импортного контракта прошла");
}

/** Незаконченные пачки raw не видны, последняя публикует снимок ровно один раз. */
async function проверитьПакетныйRaw() {
  const fetchedAt = new Date().toISOString();
  const path = "/raw/import/smoke-ingest";
  const base = {
    source: "gjvending",
    report: "order_query",
    fetchedAt,
    columns: ["id", "value"],
    rowsTotal: 3,
    importedBy: "smoke",
  };

  const premature = await jsonRequest(
    "POST",
    path,
    {
      ...base,
      rows: [
        ["1", "a"],
        ["2", "b"],
      ],
      offset: 0,
      append: false,
      complete: true,
    },
    false,
  );
  if (premature.r.ok) throw new Error("неполная последняя пачка была принята");

  const first = await jsonRequest(
    "POST",
    path,
    {
      ...base,
      rows: [
        ["1", "a"],
        ["2", "b"],
      ],
      offset: 0,
      append: false,
      complete: false,
    },
    false,
  );
  if (!first.r.ok) throw new Error(`первая пачка → ${first.r.status}: ${first.text.slice(0, 200)}`);

  const hidden = await jsonRequest("GET", "/raw/report/gjvending/order_query");
  if (!hidden.r.ok || hidden.json.snapshot?.id === first.json.snapshotId) {
    throw new Error("промежуточный снимок стал виден отчётам");
  }

  const final = await jsonRequest(
    "POST",
    path,
    { ...base, rows: [["3", "c"]], offset: 2, append: true, complete: true },
    false,
  );
  if (!final.r.ok || final.json.total !== 3) {
    throw new Error(`последняя пачка → ${final.r.status}: ${final.text.slice(0, 200)}`);
  }

  const published = await jsonRequest("GET", "/raw/report/gjvending/order_query");
  if (!published.r.ok || published.json.snapshot?.rows !== 3) {
    throw new Error(`готовый снимок не опубликован: ${published.text.slice(0, 200)}`);
  }

  // Повторная пакетная запись к уже готовому снимку снова скрывает его до
  // complete=true. Иначе отчёт увидит смесь старого и нового содержимого.
  const reopened = await jsonRequest(
    "POST",
    path,
    { ...base, rows: [["2", "b2"]], offset: 1, append: true, complete: false },
    false,
  );
  if (!reopened.r.ok) {
    throw new Error(
      `повторная промежуточная пачка → ${reopened.r.status}: ${reopened.text.slice(0, 200)}`,
    );
  }
  const hiddenAgain = await jsonRequest("GET", "/raw/report/gjvending/order_query");
  if (!hiddenAgain.r.ok || hiddenAgain.json.snapshot?.id === final.json.snapshotId) {
    throw new Error("повторно открытый снимок остался виден отчётам");
  }

  const republished = await jsonRequest(
    "POST",
    path,
    { ...base, rows: [["3", "c"]], offset: 2, append: true, complete: true },
    false,
  );
  if (!republished.r.ok || republished.json.total !== 3) {
    throw new Error(
      `повторная публикация → ${republished.r.status}: ${republished.text.slice(0, 200)}`,
    );
  }
  const visibleAgain = await jsonRequest("GET", "/raw/report/gjvending/order_query");
  if (!visibleAgain.r.ok || visibleAgain.json.snapshot?.id !== republished.json.snapshotId) {
    throw new Error("повторно завершённый снимок не вернулся в отчёты");
  }
}

/**
 * Усушка (П4): отчёт читает снимки ПО АВТОМАТУ, и без снимков на границах
 * суток этот запрос не исполняется вовсе. Чтение `/vending/shrinkage` в общем
 * списке доходит до базы, но список автоматов там пуст — то есть половина
 * нового SQL оставалась бы непроверенной (урок Task 3: смоук зеленел на
 * `events = 0`, потому что детектор возвращался раньше вставки).
 *
 * Отдельный серийник, чтобы не мешать сценарию детектора: тот меряет приход
 * между двумя снимками часовой давности, а здесь снимки стоят на границах
 * ВЧЕРАШНИХ суток по Ташкенту.
 */
async function проверитьУсушку() {
  const серийник = "SMOKE-SHRINK";
  const сдвиг = 5 * 3_600_000; // Ташкент, без перехода на летнее время
  const сегодня = new Date(Date.now() + сдвиг).toISOString().slice(0, 10);
  const начало = Date.parse(`${сегодня}T00:00:00.000Z`) - сдвиг;
  const вчера = начало - 86_400_000;

  const снимок = async (когда, quantity) => {
    const { r, text } = await jsonRequest("POST", "/vending/ingest", {
      capturedAt: new Date(когда).toISOString(),
      machines: [
        {
          serial: серийник,
          slots: [{ coilId: "1", product: "Smoke Shrink", capacity: 20, quantity }],
        },
      ],
    });
    if (!r.ok) throw new Error(`приём снимка → ${r.status}: ${text.slice(0, 200)}`);
  };

  await снимок(вчера, 12);
  await снимок(начало, 5);

  const { r, text, json } = await jsonRequest("GET", "/vending/shrinkage?days=2");
  if (!r.ok) throw new Error(`отчёт → ${r.status}: ${text.slice(0, 200)}`);
  const автомат = json.machines.find((m) => String(m.serial).toLowerCase() === серийник.toLowerCase());
  if (!автомат) throw new Error(`автомата ${серийник} нет в отчёте — выборка снимков по автомату не отработала`);
  if (!Array.isArray(автомат.refillDays)) throw new Error("refillDays — не массив");
  // Продажи по дням (`sale`) в смоук-базу положить нечем: их наполняет синк из
  // чужой БД, которого здесь нет. Значит день ОБЯЗАН быть пропущен с причиной —
  // молчаливый «ноль усушки» тут был бы худшим из исходов.
  if (автомат.summary.daysCounted !== 0) throw new Error(`день без продаж посчитан: daysCounted=${автомат.summary.daysCounted}`);
  if (!json.warnings.some((w) => w.code === "no_sales_day" && w.message.includes(автомат.name))) {
    throw new Error("нет предупреждения no_sales_day — день пропущен молча");
  }
  // «Ни одного посчитанного дня» — отдельная строка: без неё панель и бот
  // сказали бы «недостач нет» там, где расчёт не дал ничего.
  if (!json.warnings.some((w) => w.code === "no_counted_days" && w.message.includes(автомат.name))) {
    throw new Error("нет предупреждения no_counted_days при daysCounted=0");
  }
}

/**
 * Суточные алерты (П4): их SQL — выборка уже написанных событий за сутки и
 * пакетная вставка — живёт только в кроне, и без ручного роута против
 * настоящего Postgres не исполнялся бы ни разу.
 *
 * Автомат заводится СВОЙ и заведомо пустой: без хотя бы одного события
 * проверка дедупа не значила бы ничего (ноль и во второй раз ноль).
 */
async function проверитьАлертыУсушки() {
  const серийник = "SMOKE-LOW";
  const посчитать = async () => {
    const { r, text, json } = await jsonRequest("GET", `/events/count?type=${encodeURIComponent("machine.low_stock")}`);
    if (!r.ok) throw new Error(`счётчик событий → ${r.status}: ${text.slice(0, 200)}`);
    return json.count;
  };

  const приём = await jsonRequest("POST", "/vending/ingest", {
    capturedAt: new Date().toISOString(),
    machines: [
      {
        serial: серийник,
        slots: [
          { coilId: "1", product: "Smoke Low", capacity: 20, quantity: 0 },
          { coilId: "2", product: "Smoke Low", capacity: 20, quantity: 1 },
        ],
      },
    ],
  });
  if (!приём.r.ok) throw new Error(`приём слотов → ${приём.r.status}: ${приём.text.slice(0, 200)}`);

  const было = await посчитать();
  const первый = await jsonRequest("POST", "/vending/shrinkage/alerts");
  if (!первый.r.ok) throw new Error(`прогон алертов → ${первый.r.status}: ${первый.text.slice(0, 200)}`);
  if (typeof первый.json?.alerts !== "number" || typeof первый.json?.lowStock !== "number") {
    throw new Error(`ответ прогона без счётчиков: ${первый.text.slice(0, 200)}`);
  }
  if (первый.json.lowStock < 1) throw new Error(`пустой автомат не дал алерта: lowStock=${первый.json.lowStock}`);
  const стало = await посчитать();
  if (стало !== было + первый.json.lowStock) {
    throw new Error(`событий записано ${стало - было}, а прогон отчитался о ${первый.json.lowStock}`);
  }

  // Второй прогон в те же сутки: дедуп читает уже записанные события ИЗ БАЗЫ,
  // а не из памяти процесса, — именно этот запрос здесь и проверяется.
  const второй = await jsonRequest("POST", "/vending/shrinkage/alerts");
  if (!второй.r.ok) throw new Error(`повтор прогона → ${второй.r.status}: ${второй.text.slice(0, 200)}`);
  if (второй.json.alerts !== 0) throw new Error(`повтор записал ${второй.json.alerts} событий вместо нуля`);
  if ((await посчитать()) !== стало) throw new Error("повтор прогона задвоил события в базе");
}

/**
 * Ретенция (R-FW-S2): единственный новый сырой SQL среза обязан исполниться
 * НАСТОЯЩИМ Postgres.
 *
 * ЗАЧЕМ. Пятая цель ретенции сравнивает `date`-колонку с ГОЛЫМИ СУТКАМИ-строкой
 * (`dt < '2024-09-06'`), потому что `date < timestamptz` уехало бы на 05:00
 * Ташкента. Юнит-тест проверяет РЕНДЕР запроса — стенд его не выполняет; крон
 * в смоуке не наступает. Если биндинг окажется типизирован как `text`, Postgres
 * ответит «operator does not exist: date < text», и цель будет падать каждое
 * воскресенье в 04:10 — молча для всех, кроме журнала событий.
 *
 * СЦЕНАРИЙ. Кладём в историю склада строку 800-суточной давности (порог — 730)
 * и свежую, гоняем `POST /system/retention/run`, проверяем: старая снесена,
 * свежая цела, событие `system.retention` записано. Прямая запись в базу — не
 * от хорошей жизни: `?dt=` у приёма нет, историю датирует сам сервис.
 */
async function проверитьРетенцию() {
  const ТОВАР = "Smoke Ретенция";
  const сутки = (сдвиг) => new Date(Date.now() - сдвиг * 86_400_000).toISOString().slice(0, 10);
  const СТАРАЯ = сутки(800);
  const СВЕЖАЯ = сутки(1);

  const убрать = () =>
    sql`delete from vending_stock_count where product_name = ${ТОВАР}`.catch(() => {});
  await убрать();
  await sql`
    insert into vending_stock_count (dt, product_name, qty, source, counted_at, note)
    values (${СТАРАЯ}::date, ${ТОВАР}, 5, 'own', ${`${СТАРАЯ}T07:00:00Z`}::timestamptz, 'smoke'),
           (${СВЕЖАЯ}::date, ${ТОВАР}, 7, 'own', ${`${СВЕЖАЯ}T07:00:00Z`}::timestamptz, 'smoke')`;

  const [{ count: событийДо }] = await sql`select count(*)::int as count from event where type = 'system.retention'`;

  try {
    // Примерка: ТОТ ЖЕ предикат, но ни одной удалённой строки. Гоняется первой —
    // если `date < $1` не типизируется, отсюда и прилетит отказ Postgres.
    const примерка = await jsonRequest("POST", "/system/retention/run", { dryRun: true });
    if (!примерка.r.ok) throw new Error(`примерка → ${примерка.r.status}: ${примерка.text.slice(0, 300)}`);
    if (примерка.json?.dryRun !== true) throw new Error(`ответ примерки без признака режима: ${примерка.text.slice(0, 200)}`);
    const цель = (примерка.json.tables ?? []).find((t) => t.table === "vending_stock_count");
    if (!цель) throw new Error("в ответе нет цели vending_stock_count — расклад обязан быть по ВСЕМ пяти таблицам");
    if (цель.deleted < 1) throw new Error(`примерка не увидела строку 800-суточной давности: deleted=${цель.deleted}`);
    const [{ count: послеПримерки }] = await sql`select count(*)::int as count from vending_stock_count where product_name = ${ТОВАР}`;
    if (послеПримерки !== 2) throw new Error(`примерка удалила строки: осталось ${послеПримерки} из 2`);

    const прогон = await jsonRequest("POST", "/system/retention/run", {});
    if (!прогон.r.ok) throw new Error(`прогон → ${прогон.r.status}: ${прогон.text.slice(0, 300)}`);
    const снесено = (прогон.json.tables ?? []).find((t) => t.table === "vending_stock_count");
    if (!снесено || снесено.deleted < 1) throw new Error(`ретенция не снесла старую строку: ${прогон.text.slice(0, 200)}`);
    if (снесено.olderThanDays !== 730) throw new Error(`окно истории склада ${снесено.olderThanDays}, ждали 730`);

    const строки = await sql`select dt::text as dt from vending_stock_count where product_name = ${ТОВАР}`;
    if (строки.length !== 1) throw new Error(`после чистки осталось ${строки.length} строк, ждали одну свежую`);
    if (строки[0].dt !== СВЕЖАЯ) throw new Error(`уцелела не та строка: ${строки[0].dt}, ждали ${СВЕЖАЯ}`);

    const [{ count: событийПосле }] = await sql`select count(*)::int as count from event where type = 'system.retention'`;
    if (событийПосле <= событийДо) throw new Error("событие system.retention не записано — о чистке в журнале ни следа");
  } finally {
    await убрать();
  }
}

/** Глобальный guard обязан реально вернуть 429, а не только присутствовать в модуле. */
/**
 * П5b: приёмка накладной наблюдает закупочную цену позиции
 * (`vending.purchase_price_observed`, R-P5b-5).
 *
 * Заглушка юнит-теста «вставляет» события в массив, поэтому пакетный
 * `insert(event).values(массив)` ВНУТРИ транзакции приёмки настоящим Postgres
 * не исполнялся ни разу — а лента изменений закупочных цен стоит именно на
 * нём. Заодно проверяется главное правило наблюдения: позиция БЕЗ цены его не
 * даёт (0 и мусор — это «цены нет», а не «заплатили ноль»).
 *
 * Путь целиком по HTTP: заявка → согласование (оно и создаёт накладную) →
 * приёмка → счётчик и тело события.
 */
async function проверитьНаблюдениеЦен() {
  const С_ЦЕНОЙ = P4_ТОВАР; // есть в прайсе (seed-vending) — значит у наблюдения будет «было»
  const БЕЗ_ЦЕНЫ = "Fanta C 0,5";
  const ТИП = "vending.purchase_price_observed";
  const посчитать = async () => {
    const { r, text, json } = await jsonRequest("GET", `/events/count?type=${encodeURIComponent(ТИП)}`);
    if (!r.ok) throw new Error(`счётчик наблюдений → ${r.status}: ${text.slice(0, 200)}`);
    return json.count;
  };
  const было = await посчитать();

  const заявка = await jsonRequest("POST", "/approvals", {
    agent: "smoke",
    action: "vending.purchase",
    tier: "T2",
    payload: {
      purchaseOrder: {
        positions: [
          { product: С_ЦЕНОЙ, order: 12, price: 6500 },
          { product: БЕЗ_ЦЕНЫ, order: 6 },
        ],
        totalBuy: 18,
        totalOrder: 18,
        costExact: 78000,
        costRounded: 78000,
        createdBy: "smoke",
      },
    },
  });
  if (!заявка.r.ok) throw new Error(`заявка закупа → ${заявка.r.status}: ${заявка.text.slice(0, 200)}`);
  const заявкаId = заявка.json?.id;
  if (!заявкаId) throw new Error(`заявка без id: ${заявка.text.slice(0, 200)}`);

  const решение = await jsonRequest("POST", `/approvals/${заявкаId}/decide`, { decision: "approved", actor: "smoke" });
  if (!решение.r.ok) throw new Error(`согласование → ${решение.r.status}: ${решение.text.slice(0, 200)}`);

  const накладные = await читать("/vending/orders");
  const накладная = накладные.find((o) => o.approvalId === заявкаId);
  if (!накладная) throw new Error("одобренная заявка не породила накладную");

  const приёмка = await jsonRequest("POST", "/vending/orders/receive", { orderId: накладная.id, receivedBy: "smoke" });
  if (!приёмка.r.ok) throw new Error(`приёмка → ${приёмка.r.status}: ${приёмка.text.slice(0, 200)}`);
  if (приёмка.json?.received !== true) throw new Error(`приёмка отказала: ${приёмка.text.slice(0, 200)}`);

  const стало = await посчитать();
  if (стало !== было + 1) {
    throw new Error(`наблюдений записано ${стало - было}, ждали ровно одно (позиция без цены его не даёт)`);
  }

  const события = await читать(`/events?type=${encodeURIComponent(ТИП)}`);
  const наше = события.find((e) => e.payload?.orderId === накладная.id);
  if (!наше) throw new Error("наблюдение по нашей накладной не найдено");
  if (наше.payload.product !== С_ЦЕНОЙ) throw new Error(`product=${наше.payload.product}`);
  if (наше.payload.price !== 6500) throw new Error(`price=${наше.payload.price}`);
  if (typeof наше.payload.oldPrice !== "number") {
    throw new Error(`oldPrice не взялся из прайса (значит «было» сравнивать не с чем): ${наше.payload.oldPrice}`);
  }
}

/**
 * П5b: отсечка автоматов НЕ в строю уходит прямо в SQL (`not in (...)`).
 *
 * На засеянной базе снятых с работы автоматов нет, поэтому список исключений
 * пуст и ветка `notInArray` не исполняется вовсе — а именно этот класс
 * конструкций уже валил прод («op ANY/ALL (array) requires array on right
 * side»). Сценарий заводит карточку-склад, сбрасывает кеш аналитики записью
 * эталона (иначе следующий GET вернул бы отчёт, посчитанный ДО появления
 * склада) и заставляет Postgres выполнить запросы с непустым списком.
 */
async function проверитьОтсечкуСклада() {
  const создание = await jsonRequest("POST", "/entities", {
    domain: "vendhub",
    type: "machine",
    name: "Дымовой склад-заглушка",
    externalRef: "SMOKE-SKLAD",
  });
  if (!создание.r.ok) throw new Error(`карточка склада → ${создание.r.status}: ${создание.text.slice(0, 200)}`);
  const id = создание.json?.id;
  if (!id) throw new Error(`карточка без id: ${создание.text.slice(0, 200)}`);

  const статус = await jsonRequest("PATCH", `/entities/${id}/machine-status`, { status: "warehouse", actor: "smoke" });
  if (!статус.r.ok) throw new Error(`статус карточки → ${статус.r.status}: ${статус.text.slice(0, 200)}`);
  if (статус.json?.status !== "warehouse") throw new Error(`статус=${статус.json?.status}`);

  // Кеш отчётов живёт пять минут: без сброса GET ниже ответил бы из памяти и
  // SQL с исключениями так и не выполнился бы (ровно та дыра, ради которой
  // сценарий и написан).
  const сброс = await jsonRequest("POST", "/vending/sale-price", { product: P4_ТОВАР, price: 15000, confirmed: true });
  if (!сброс.r.ok || сброс.json?.ok !== true) throw new Error(`сброс кеша через эталон → ${сброс.text.slice(0, 200)}`);

  for (const путь of ["/vending/price-gap?days=14", "/vending/dead-stock?days=21", "/vending/price-changes?days=30"]) {
    const { r, text, json } = await jsonRequest("GET", путь);
    if (!r.ok) throw new Error(`${путь} с непустым списком исключений → ${r.status}: ${text.slice(0, 200)}`);
    if (!Array.isArray(json?.warnings)) throw new Error(`${путь}: warnings — не массив`);
  }
}

async function проверитьRateLimit() {
  for (let i = 0; i < 70; i += 1) {
    const r = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(5000) });
    if (r.status === 429) return;
    if (!r.ok) throw new Error(`/health неожиданно вернул ${r.status}`);
  }
  throw new Error("после 70 быстрых запросов Core ни разу не вернул 429");
}

async function ждатьЗдоровье(proc) {
  const дедлайн = Date.now() + СТАРТ_ТАЙМАУТ_МС;
  while (Date.now() < дедлайн) {
    if (proc.exitCode !== null) throw new Error(`Core умер на старте (код ${proc.exitCode})`);
    try {
      const r = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(2000) });
      if (r.ok) return;
    } catch {
      // ещё не поднялся — это ожидаемо
    }
    await sleep(500);
  }
  throw new Error(`Core не поднялся за ${СТАРТ_ТАЙМАУТ_МС / 1000} с`);
}

const провалы = [];

async function проверитьЧтение(шаг) {
  const path = typeof шаг === "string" ? шаг : шаг.path;
  const r = await fetch(BASE + path, { signal: AbortSignal.timeout(20_000) });
  const текст = await r.text();
  // Некоторые пути обязаны ОТКАЗАТЬ: предел выше максимума — не «поправим
  // молча», а ошибка ввода. Молчаливая поправка вернула бы 5000 там, где
  // просили миллион, и вызывающий решил бы, что видит всё.
  if (typeof шаг !== "string" && шаг.ждёмОтказ) {
    if (r.ok) провалы.push(`GET ${path} → ${r.status}, а ожидали отказ`);
    else console.log(`  ok  GET ${path} — отвергнут, как и надо`);
    return;
  }
  if (!r.ok) {
    провалы.push(`GET ${path} → ${r.status}: ${текст.slice(0, 300)}`);
    return;
  }
  if (typeof шаг !== "string" && шаг.проверить) {
    try {
      шаг.проверить(JSON.parse(текст));
    } catch (e) {
      провалы.push(`GET ${path}: ${e.message}`);
      return;
    }
  }
  console.log(`  ok  GET ${path}`);
}

/** Прочитать путь и вернуть разобранный ответ (для проверок последствий). */
async function читать(path) {
  const r = await fetch(BASE + path, { signal: AbortSignal.timeout(20_000) });
  const текст = await r.text();
  if (!r.ok) throw new Error(`GET ${path} → ${r.status}: ${текст.slice(0, 200)}`);
  return JSON.parse(текст);
}

async function проверитьЗапись(шаг) {
  const r = await fetch(BASE + шаг.path, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-service-token": TOKEN },
    body: JSON.stringify(шаг.body),
    signal: AbortSignal.timeout(20_000),
  });
  const текст = await r.text();
  // Запись, которая ОБЯЗАНА быть отвергнута на границе (мусорный ввод): 200 на
  // неё — не «сервис снисходителен», а дыра в валидации.
  if (шаг.ждёмОтказ) {
    if (r.ok) провалы.push(`POST ${шаг.path} (${шаг.имя}) → ${r.status}, а ожидали отказ`);
    else console.log(`  ok  POST ${шаг.path} — ${шаг.имя}`);
    return;
  }
  if (!r.ok) {
    провалы.push(`POST ${шаг.path} (${шаг.имя}) → ${r.status}: ${текст.slice(0, 300)}`);
    return;
  }
  if (шаг.проверить) {
    try {
      шаг.проверить(JSON.parse(текст));
    } catch (e) {
      провалы.push(`POST ${шаг.path} (${шаг.имя}): ${e.message}`);
      return;
    }
  }
  // `после` — проверка ПОСЛЕДСТВИЯ записи, а не её ответа: ответ апсерта не
  // показывает, что стало со строкой в базе, и ровно там живут ошибки вида
  // «конфликт затёр непустое поле».
  if (шаг.после) {
    try {
      await шаг.после();
    } catch (e) {
      провалы.push(`POST ${шаг.path} (${шаг.имя}) — последствие: ${e.message}`);
      return;
    }
  }
  console.log(`  ok  POST ${шаг.path} — ${шаг.имя}`);
}

// Внешние синки на дымовом прогоне гасим ЯВНО.
//
// SalesService и SupplyService включаются наличием STOCK_DATABASE_URL и
// стартуют сразу, не дожидаясь расписания. В CI переменной обычно нет, но
// «обычно нет» — не гарантия: прогон полез бы в чужую базу и стал бы зависеть
// от её доступности. Дымовой тест обязан проверять НАШ код, а не связность.
const env = {
  ...process.env,
  PORT,
  SERVICE_TOKEN: TOKEN,
  INGEST_KEY: "smoke-ingest",
  HEALTH_MIN_STORAGE_MB: "0",
  NODE_ENV: "test",
};
delete env.STOCK_DATABASE_URL;
delete env.OURVEND_ACCOUNT;
delete env.OURVEND_PASSWORD;

const core = spawn("node", ["apps/core/dist/main.js"], {
  env,
  stdio: ["ignore", "pipe", "pipe"],
});
const логи = [];
core.stdout.on("data", (d) => логи.push(String(d)));
core.stderr.on("data", (d) => логи.push(String(d)));

try {
  await ждатьЗдоровье(core);
  console.log("Core поднялся, идём по путям\n");

  for (const path of ЧТЕНИЕ) await проверитьЧтение(path);
  for (const шаг of ЗАПИСЬ) await проверитьЗапись(шаг);

  try {
    await проверитьМеста();
    console.log("  ok  сценарий: место реестра, два аппарата на нём, снятие одного");
  } catch (e) {
    провалы.push(`места: ${e.message}`);
  }

  try {
    await проверитьУзлы();
    console.log("  ok  сценарий: узел — установка, занято, мойка, возврат, история по серийнику");
  } catch (e) {
    провалы.push(`узлы: ${e.message}`);
  }

  try {
    await проверитьПродажиТовара();
    console.log("  ok  сценарий: продажи товара — имя, алиасы, несвязанные");
  } catch (e) {
    провалы.push(`продажи товара: ${e.message}`);
  }

  try {
    await проверитьСогласование();
    console.log("  ok  сценарий: согласование → исполнение → утверждённая карточка");
  } catch (e) {
    провалы.push(`согласование: ${e.message}`);
  }

  try {
    await проверитьИнкассацию();
    console.log("  ok  сценарий: инкассация → приём → защита от повтора");
  } catch (e) {
    провалы.push(`инкассация: ${e.message}`);
  }

  try {
    await проверитьФинансовыеТранзакции();
    console.log("  ok  сценарий: договор/импорт → обязательства → оплата");
  } catch (e) {
    провалы.push(`финансовые транзакции: ${e.message}`);
  }

  try {
    await проверитьПакетныйRaw();
    console.log("  ok  сценарий: пакетный raw скрыт до последней полной пачки");
  } catch (e) {
    провалы.push(`пакетный raw: ${e.message}`);
  }

  try {
    await проверитьУсушку();
    console.log("  ok  сценарий: усушка — снимки на границах суток, день без продаж пропущен с причиной");
  } catch (e) {
    провалы.push(`усушка: ${e.message}`);
  }

  try {
    await проверитьАлертыУсушки();
    console.log("  ok  сценарий: суточные алерты — событие «заканчивается», повтор дубля не даёт");
  } catch (e) {
    провалы.push(`алерты усушки: ${e.message}`);
  }

  try {
    await проверитьНаблюдениеЦен();
    console.log("  ok  сценарий: приёмка наблюдает закупочную цену позиции (без цены — наблюдения нет)");
  } catch (e) {
    провалы.push(`наблюдение цен: ${e.message}`);
  }

  try {
    await проверитьОтсечкуСклада();
    console.log("  ok  сценарий: автомат не в строю отсекается в SQL (not in), отчёты считаются заново");
  } catch (e) {
    провалы.push(`отсечка склада: ${e.message}`);
  }

  try {
    await проверитьРетенцию();
    console.log("  ok  сценарий: ретенция — строка старше 730 суток снесена, свежая цела, событие записано");
  } catch (e) {
    провалы.push(`ретенция: ${e.message}`);
  }

  try {
    await проверитьRateLimit();
    console.log("  ok  сценарий: глобальный rate limit отвечает 429");
  } catch (e) {
    провалы.push(`rate limit: ${e.message}`);
  }
} catch (e) {
  провалы.push(`старт: ${e.message}`);
} finally {
  core.kill("SIGTERM");
  await sleep(300);
  if (core.exitCode === null) core.kill("SIGKILL");
  // Своё подключение закрываем явно: postgres.js держит сокет открытым, и без
  // этого прогон висел бы после того, как всё сделано.
  await sql.end({ timeout: 5 }).catch(() => {});
}

if (провалы.length > 0) {
  console.error(`\nПРОВАЛОВ: ${провалы.length}`);
  for (const p of провалы) console.error(`  ✗ ${p}`);
  console.error("\n--- последние строки лога Core ---");
  console.error(логи.join("").split("\n").slice(-25).join("\n"));
  process.exit(1);
}

console.log(`\nВсё прошло: ${ЧТЕНИЕ.length} чтений, ${ЗАПИСЬ.length} записей, 13 сценариев.`);
