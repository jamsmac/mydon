import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { event, ourvendSaleSnapshot, ourvendStockSnapshot, systemConfig, vendingSyncRun } from "@mydon/db";
import { resetAccountingSourceCache } from "../sales/accounting-source";
import { OurvendHealthService } from "./ourvend-health.service";
import type { OurvendParityService } from "./ourvend-parity.service";
import {
  SyncStaleService,
  SNAPSHOT_STALE_EVENT,
  SNAPSHOT_STALE_HOURS_FALLBACK,
  SYNC_STALE_EVENT,
  SYNC_STALE_HOURS_FALLBACK,
} from "./sync-stale.service";

type Прогон = { startedAt: Date; finishedAt: Date | null; status: "running" | "success" | "partial" | "failed" };
type Событие = { id: string; type: string; occurredAt: Date };

interface Мир {
  /** Момент последнего УСПЕХА (ISO). `null` — успехов в журнале нет вовсе. */
  lastSuccessAt?: string | null;
  /** Статус самого свежего прогона любого исхода. */
  lastRunStatus?: Прогон["status"] | null;
  /** Что уже лежит в журнале событий (дедуп). */
  уже?: { type: string; occurredAt: Date }[];
  настройки?: Record<string, string>;
  /**
   * Прямой список прогонов — когда сценарий не укладывается в «один успех +
   * один статус последнего» (R-FW-P4): например, серия из НЕСКОЛЬКИХ
   * `partial` без единого `success` в журнале вовсе. Задан — `lastSuccessAt`
   * и `lastRunStatus` игнорируются.
   */
  runs?: Прогон[];
  /** Момент последнего съёма снапшота ПРОДАЖ (ISO). `null`/пусто — снапшота нет вовсе. */
  снапшотAt?: string | null;
  /**
   * Момент последнего съёма снапшота ОСТАТКОВ. Не задан — тот же, что у
   * продаж: обе половины приезжают одним прогоном агента. Задавать отдельно
   * нужно ровно там, где половины разъехались (упала Lot-сессия).
   */
  остаткиAt?: string | null;
}

/** Все значения-параметры из условия drizzle: стабу надо увидеть и статус, и границу суток. */
function параметры(cond: unknown): unknown[] {
  const out: unknown[] = [];
  const walk = (n: unknown): void => {
    if (!n || typeof n !== "object") return;
    if (n instanceof Date) {
      out.push(n);
      return;
    }
    if (Array.isArray(n)) {
      for (const x of n) walk(x);
      return;
    }
    const chunks = (n as { queryChunks?: unknown[] }).queryChunks;
    if (Array.isArray(chunks)) {
      for (const c of chunks) walk(c);
      return;
    }
    const v = (n as { value?: unknown }).value;
    if (typeof v === "string" || v instanceof Date) out.push(v);
  };
  walk(cond);
  return out;
}

/**
 * Стаб БД: `where` ФИЛЬТРУЕТ, `order by … desc` сортирует, `limit` режет.
 *
 * Отдай стаб фикстуру как есть — и «последний успех» проверялся бы порядком
 * строк в тесте, а дедуп по суткам вообще ничем: заглушка сказала бы «событие
 * есть» на любой запрос (урок «заглушка врёт»).
 */
function стенд(м: Мир) {
  const МОМЕНТ_ПОСЛЕДНЕГО = new Date("2026-08-25T12:00:00+05:00");
  const прогоны: Прогон[] = м.runs ? [...м.runs] : [];
  if (!м.runs) {
    if (м.lastSuccessAt) {
      const at = new Date(м.lastSuccessAt);
      прогоны.push({ startedAt: at, finishedAt: at, status: "success" });
    }
    // Прогон ПОЗЖЕ успеха задаётся явно: без него «последний прогон» — это сам
    // успех, и статус в событии будет «success».
    if (м.lastRunStatus) {
      прогоны.push({ startedAt: МОМЕНТ_ПОСЛЕДНЕГО, finishedAt: МОМЕНТ_ПОСЛЕДНЕГО, status: м.lastRunStatus });
    }
  }

  // Снапшот учёта — одна строка «последний съём»: сторож берёт её тем же
  // запросом «последняя строка», что и отчёт о здоровье.
  const снимки: { at: Date }[] = м.снапшотAt ? [{ at: new Date(м.снапшотAt) }] : [];
  const остатки: { at: Date }[] =
    м.остаткиAt === undefined ? снимки : м.остаткиAt ? [{ at: new Date(м.остаткиAt) }] : [];

  const события: Событие[] = (м.уже ?? []).map((e, i) => ({ id: `e${i}`, type: e.type, occurredAt: e.occurredAt }));
  const записано: { source: string; type: string; payload: Record<string, unknown>; occurredAt: Date }[] = [];
  const настройки = Object.entries(м.настройки ?? {}).map(([key, value]) => ({ key, value }));

  const db = {
    select: () => ({
      from: (t: unknown) => {
        let текущие: unknown[] =
          t === vendingSyncRun
            ? [...прогоны]
            : t === event
              ? [...события]
              : t === ourvendSaleSnapshot
                ? [...снимки]
                : t === ourvendStockSnapshot
                  ? [...остатки]
                  : t === systemConfig
                  ? настройки
                  : [];
        const chain: Record<string, unknown> = {};
        chain.where = (cond?: unknown) => {
          const п = параметры(cond);
          const строки = п.filter((v): v is string => typeof v === "string");
          const даты = п.filter((v): v is Date => v instanceof Date);
          if (t === vendingSyncRun && строки.length > 0) {
            текущие = (текущие as Прогон[]).filter((r) => строки.includes(r.status));
          }
          if (t === event) {
            текущие = (текущие as Событие[]).filter(
              (e) =>
                (строки.length === 0 || строки.includes(e.type)) &&
                (даты.length === 0 || e.occurredAt.getTime() >= даты[0]!.getTime()),
            );
          }
          return chain;
        };
        chain.orderBy = () => {
          // Сортировка по ВРЕМЕНИ строки, каким бы оно ни называлось: у прогонов
          // это `startedAt`, у снимков — `at`. Своя «сортировка прогонов» на
          // снимках уронила бы стаб, а не тест.
          const время = (r: unknown): number =>
            t === ourvendSaleSnapshot ? (r as { at: Date }).at.getTime() : (r as Прогон).startedAt.getTime();
          текущие = [...текущие].sort((a, b) => время(b) - время(a));
          return chain;
        };
        chain.limit = async (n: number) => текущие.slice(0, n);
        chain.then = (res: (v: unknown) => unknown) => Promise.resolve(текущие).then(res);
        return chain;
      },
    }),
    insert: () => ({
      values: async (v: { source: string; type: string; payload: Record<string, unknown>; occurredAt: Date }) => {
        записано.push(v);
        // Событие немедленно видно дедупу — как в настоящей базе. Дата берётся
        // из самой строки: датируй стаб реальным «сейчас» — и проверка
        // «следующие сутки — снова событие» зависела бы от дня прогона тестов.
        события.push({ id: `w${записано.length}`, type: v.type, occurredAt: v.occurredAt });
      },
    }),
  } as never;

  // Источник учёта кешируется на минуту МОДУЛЕМ, а не сервисом: без сброса
  // второй тест с тем же `now` получил бы режим первого.
  resetAccountingSourceCache();

  return { svc: new SyncStaleService(db), db, события: записано, журнал: события };
}

const СЕЙЧАС = new Date("2026-08-25T13:00:00+05:00");

describe("Сторож «нет успешного прогона» (R-P8a-6)", () => {
  it("5 часов при пороге 6 — тишина", async () => {
    const { svc, события } = стенд({ lastSuccessAt: "2026-08-25T08:00:00+05:00" });
    const итог = await svc.check(СЕЙЧАС);
    assert.deepEqual([итог.emitted, итог.staleHours, итог.threshold], [false, 5, SYNC_STALE_HOURS_FALLBACK]);
    assert.equal(события.length, 0);
  });

  it("7 часов — событие с давностью, моментом и статусом последнего прогона", async () => {
    const { svc, события } = стенд({ lastSuccessAt: "2026-08-25T06:00:00+05:00", lastRunStatus: "failed" });
    assert.equal((await svc.check(СЕЙЧАС)).emitted, true);
    assert.equal(события[0]!.type, SYNC_STALE_EVENT);
    assert.deepEqual(события[0]!.payload, {
      hoursSinceSuccess: 7,
      lastSuccessAt: "2026-08-25T01:00:00.000Z",
      lastRunStatus: "failed",
    });
  });

  it("успехов не было вовсе — тревога, а не «ноль часов, всё хорошо»", async () => {
    // Пустой журнал прогонов означает «сбор не заводили» — самый тревожный
    // случай, а не самый спокойный: streak-детектор здесь не сработает НИКОГДА,
    // потому что `finishSyncRun` никто не зовёт.
    const { svc, события } = стенд({ lastSuccessAt: null, lastRunStatus: null });
    assert.equal((await svc.check(СЕЙЧАС)).emitted, true);
    assert.deepEqual(события[0]!.payload, {
      hoursSinceSuccess: null,
      lastSuccessAt: null,
      lastRunStatus: null,
    });
  });

  it("прогоны идут, но все падают — сторож тоже молчать не должен", async () => {
    const { svc, события } = стенд({ lastSuccessAt: null, lastRunStatus: "failed" });
    assert.equal((await svc.check(СЕЙЧАС)).emitted, true);
    assert.equal(события[0]!.payload.lastRunStatus, "failed");
  });

  it("повтор в те же ташкентские сутки — молчание, следующие сутки — снова событие", async () => {
    const { svc, события } = стенд({
      lastSuccessAt: "2026-08-25T06:00:00+05:00",
      уже: [{ type: SYNC_STALE_EVENT, occurredAt: new Date("2026-08-25T09:00:00+05:00") }],
    });
    assert.equal((await svc.check(СЕЙЧАС)).emitted, false);
    assert.equal((await svc.check(new Date("2026-08-26T13:00:00+05:00"))).emitted, true);
    assert.equal(события.length, 1, "крон ходит каждые 30 минут — без дедупа это 48 сообщений в сутки");
  });

  it("событие в 02:00 Ташкента дедуп ВИДИТ, хотя по UTC это прошлые сутки", async () => {
    // 02:00+05 = 21:00Z ПРЕДЫДУЩЕГО дня. Возьми сторож границу UTC-суток — и
    // владелец получил бы второе сообщение о том же застое тем же утром.
    const { svc, события } = стенд({
      lastSuccessAt: "2026-08-25T06:00:00+05:00",
      уже: [{ type: SYNC_STALE_EVENT, occurredAt: new Date("2026-08-25T02:00:00+05:00") }],
    });
    assert.equal((await svc.check(СЕЙЧАС)).emitted, false);
    assert.equal(события.length, 0);
  });

  it("событие в 23:30 ПРОШЛЫХ ташкентских суток дедупом не считается", async () => {
    // 23:30+05 24-го = 18:30Z — по UTC это «сегодня», по Ташкенту вчера.
    // Застой длится вторые сутки, и сказать об этом надо ещё раз.
    const { svc, события } = стенд({
      lastSuccessAt: "2026-08-25T06:00:00+05:00",
      уже: [{ type: SYNC_STALE_EVENT, occurredAt: new Date("2026-08-24T23:30:00+05:00") }],
    });
    assert.equal((await svc.check(СЕЙЧАС)).emitted, true);
    assert.equal(события.length, 1);
  });

  it("чужое событие тех же суток дедупом не считается", async () => {
    const { svc, события } = стенд({
      lastSuccessAt: "2026-08-25T06:00:00+05:00",
      уже: [{ type: "ourvend.sync_failed_streak", occurredAt: new Date("2026-08-25T09:00:00+05:00") }],
    });
    assert.equal((await svc.check(СЕЙЧАС)).emitted, true);
    assert.equal(события.length, 1);
  });

  it("порог берётся из настройки, а не из константы", async () => {
    const { svc } = стенд({ lastSuccessAt: "2026-08-25T08:00:00+05:00", настройки: { SYNC_STALE_HOURS: "4" } });
    const итог = await svc.check(СЕЙЧАС);
    assert.deepEqual([итог.emitted, итог.threshold], [true, 4]);
  });

  it("порог ниже часа не превращает сторожа в спамер: пол считается по единице", async () => {
    // `readIntSetting` пропускает ноль как значение (владелец мог вписать его
    // осознанно для порогов-сумм), но «стоит 0 часов» — это КАЖДЫЙ прогон.
    const { svc } = стенд({ lastSuccessAt: "2026-08-25T12:30:00+05:00", настройки: { SYNC_STALE_HOURS: "0" } });
    const итог = await svc.check(СЕЙЧАС);
    assert.equal(итог.threshold, 1);
    assert.equal(итог.emitted, false, "полчаса застоя при поле в час — ещё не тревога");
  });

  it("R-FW-P4: два partial подряд, ни одного success в журнале — застоя нет: коллектор жив, слоты приходят", async () => {
    // Без фикса `lastSuccessRunAt` видела бы только `status='success'` —
    // журнал ниже вообще без успехов означал бы `staleHours: null`, а это
    // тревожнее большого числа (см. шапку сервиса) → немедленная тревога,
    // хотя данные шли всё это время.
    const partial = (at: string): Прогон => ({ startedAt: new Date(at), finishedAt: new Date(at), status: "partial" });
    const { svc, события } = стенд({
      runs: [partial("2026-08-25T10:00:00+05:00"), partial("2026-08-25T07:00:00+05:00")],
    });
    const итог = await svc.check(СЕЙЧАС);
    assert.deepEqual([итог.emitted, итог.staleHours], [false, 3], "последний partial (10:00) считается «успехом» для давности");
    assert.equal(события.length, 0);
  });

  it("R-FW-P4 minor: порог сравнивается с СЫРЫМ часом, не с округлённым — 5 ч 59 м 49 с ещё не 6 (адверсариал прод-данные №7)", async () => {
    // Округление `staleHours` (0.1 ч) даёт РОВНО 6.0 на этой отметке:
    // сравнение по округлённому числу решило бы, что порог 6 пройден, на
    // 11 секунд раньше настоящей границы — авария 24.08.2026 началась ровно
    // на ней.
    const { svc, события } = стенд({ lastSuccessAt: "2026-08-25T07:00:11+05:00" });
    const итог = await svc.check(СЕЙЧАС);
    assert.equal(итог.emitted, false, "округлённые 6.0 не должны срабатывать раньше настоящих 6 часов");
    assert.equal(итог.staleHours, 6, "витрина всё равно показывает округлённое число");
    assert.equal(события.length, 0);
  });
});

/** Паритет отчёту нужен, но к порогу отношения не имеет — отдаём «всё сошлось». */
const ПАРИТЕТ = {
  days: 7,
  checked: 0,
  ok: true,
  mismatches: [],
  ownRows: 0,
  note: null,
  stock: { days: 7, checked: 0, ok: true, mismatches: [], note: null },
};

/** Серия паритета «журнал пуст»: ноль зелёных дней при обычном пороге. */
const СЕРИЯ_ПУСТО = { greenDays: 0, threshold: 7, readyForCutover: false, days: [], lastRed: null, since: null };

describe("Порог застоя — ОДНО число у сторожа и у витрины (R-P8a-6)", () => {
  // Витрина рисует «⛔ сбор стоит» сравнением `staleHours >= staleThresholdH`.
  // Пока пол в час стоял только у сторожа, `SYNC_STALE_HOURS=0` из env давал
  // вечный бейдж при молчащем стороже, а «2.5» — бейдж по 2.5 ч против тревоги
  // по 2 ч. Считаем оба числа ОДНИМ прогоном и сравниваем.
  const случаи: [string, Record<string, string> | undefined, number][] = [
    ["ноль в настройке — пол в один час", { SYNC_STALE_HOURS: "0" }, 1],
    ["дробь усекается", { SYNC_STALE_HOURS: "2.5" }, 2],
    ["настройки нет — фолбэк", undefined, SYNC_STALE_HOURS_FALLBACK],
    ["мусор — фолбэк", { SYNC_STALE_HOURS: "шесть" }, SYNC_STALE_HOURS_FALLBACK],
  ];

  for (const [имя, настройки, ожидание] of случаи) {
    it(`${имя}: сторож и отчёт называют ${ожидание}`, async () => {
      const мир = { lastSuccessAt: "2026-08-25T06:00:00+05:00", ...(настройки ? { настройки } : {}) };
      const { svc, db } = стенд(мир);
      const отчёт = new OurvendHealthService(db, {
        parity: async () => ПАРИТЕТ,
        // Серия зелёных дней (П8b) к порогу застоя отношения не имеет — этот
        // набор про ОДНО число у сторожа и у витрины; отдаём пустую.
        streak: async () => СЕРИЯ_ПУСТО,
      } as unknown as OurvendParityService);

      const сторож = await svc.check(СЕЙЧАС);
      const здоровье = await отчёт.health(20, СЕЙЧАС);

      assert.equal(сторож.threshold, ожидание);
      assert.equal(здоровье.staleThresholdH, ожидание, "витрина обязана показывать порог, по которому будят");
      assert.equal(здоровье.staleThresholdH, сторож.threshold);
      // И сравнение у витрины даёт тот же ответ, что и решение сторожа.
      assert.equal((здоровье.staleHours ?? Infinity) >= здоровье.staleThresholdH, сторож.emitted);
    });
  }
});

// ── Сторож свежести учётного снапшота (R-P8b-5) ─────────────────────────────

describe("Сторож свежести учётного снапшота (R-P8b-5)", () => {
  // Зеркало «живо» на весь набор. Без `STOCK_DATABASE_URL` резолвер источника
  // отвечает `own` независимо от настройки (другого источника физически нет),
  // и случай «в режиме stock не проверяем» сверялся бы сам с собой.
  const былоURL = process.env.STOCK_DATABASE_URL;
  before(() => {
    process.env.STOCK_DATABASE_URL = "postgres://ro@stock/mydon";
  });
  after(() => {
    if (былоURL === undefined) delete process.env.STOCK_DATABASE_URL;
    else process.env.STOCK_DATABASE_URL = былоURL;
    resetAccountingSourceCache();
  });

  const снапшотныйСтенд = (м: Мир & { источник: "own" | "stock" }) =>
    стенд({ ...м, настройки: { OURVEND_ACCOUNTING_SOURCE: м.источник, ...(м.настройки ?? {}) } });

  const сейчас = new Date("2026-09-05T13:00:00+05:00");

  it("35 ч при пороге 36 — тишина", async () => {
    const { svc, события } = снапшотныйСтенд({ источник: "own", снапшотAt: "2026-09-04T02:00:00+05:00" });
    const r = await svc.checkSnapshot(сейчас);
    assert.deepEqual([r.stale, r.emitted, r.threshold], [false, false, SNAPSHOT_STALE_HOURS_FALLBACK]);
    assert.equal(события.length, 0);
  });

  it("37 ч — событие с часами и моментом последнего съёма", async () => {
    const { svc, события } = снапшотныйСтенд({ источник: "own", снапшотAt: "2026-09-04T00:00:00+05:00" });
    assert.equal((await svc.checkSnapshot(сейчас)).emitted, true);
    assert.equal(события[0]!.type, SNAPSHOT_STALE_EVENT);
    assert.deepEqual(события[0]!.payload, {
      hours: 37,
      lastFetchedAt: "2026-09-03T19:00:00.000Z",
      // ОБЕ половины встали (стенд по умолчанию датирует их одинаково) — и
      // текст обязан назвать обе: чинить придётся весь прогон агента.
      таблица: "продаж и остатков",
      часы_продаж: 37,
      часы_остатков: 37,
    });
  });

  it("повтор в те же ташкентские сутки — молчание, следующие сутки — снова событие", async () => {
    const { svc, события } = снапшотныйСтенд({
      источник: "own",
      снапшотAt: "2026-09-04T00:00:00+05:00",
      уже: [{ type: SNAPSHOT_STALE_EVENT, occurredAt: new Date("2026-09-05T09:00:00+05:00") }],
    });
    assert.equal((await svc.checkSnapshot(сейчас)).emitted, false);
    assert.equal(события.length, 0);
    assert.equal((await svc.checkSnapshot(new Date("2026-09-06T13:00:00+05:00"))).emitted, true);
  });

  it("в режиме stock сторож работает так же: 37 ч → событие (R-G-3)", async () => {
    // Раньше здесь стояло «в режиме stock не проверяет ничего: снапшот там
    // теневой». Теневой он ДЛЯ УЧЁТА, но это единственный вход в паритет, а
    // паритет — гейт катовера: вставший агент даёт «зелёную» серию из нулей.
    // Прод 26.08: режим `stock`, снимки приходят ежедневно в 08:05 обе
    // половины, лаг ≈ 5,8 ч при пороге 36 — ложных тревог не будет.
    const { svc, события } = снапшотныйСтенд({ источник: "stock", снапшотAt: "2026-09-04T00:00:00+05:00" });
    const r = await svc.checkSnapshot(сейчас);
    assert.deepEqual([r.stale, r.emitted], [true, true]);
    assert.equal(события[0]!.type, SNAPSHOT_STALE_EVENT);
    assert.equal(события[0]!.payload.часы_продаж, 37);
  });

  it("в режиме stock порог тот же: 35 ч при пороге 36 — тишина", async () => {
    // Порог не имеет права «съехать» вместе с режимом: 36 ч — это два
    // пропущенных суточных съёма, независимо от того, кто читает снапшот.
    const { svc, события } = снапшотныйСтенд({ источник: "stock", снапшотAt: "2026-09-04T02:00:00+05:00" });
    const r = await svc.checkSnapshot(сейчас);
    assert.deepEqual([r.stale, r.emitted, r.threshold], [false, false, SNAPSHOT_STALE_HOURS_FALLBACK]);
    assert.equal(события.length, 0);
  });

  it("дедуп по ташкентским суткам действует и в stock", async () => {
    // Крон ходит каждые полчаса: без дедупа сутки застоя дали бы 48 сообщений.
    const { svc, события } = снапшотныйСтенд({
      источник: "stock",
      снапшотAt: "2026-09-04T00:00:00+05:00",
      уже: [{ type: SNAPSHOT_STALE_EVENT, occurredAt: new Date("2026-09-05T09:00:00+05:00") }],
    });
    assert.equal((await svc.checkSnapshot(сейчас)).emitted, false);
    assert.equal(события.length, 0);
    assert.equal((await svc.checkSnapshot(new Date("2026-09-06T13:00:00+05:00"))).emitted, true);
  });

  it("сторож и витрина отвечают на РАЗНЫЕ вопросы: в stock он тревожит, а snapshotStale остаётся false", async () => {
    // Якорь различия (R-G-3). Сторож — про АГЕНТА: приносит ли
    // `ourvend:accounting` суточный снимок. Поле витрины — про УЧЁТ:
    // остановился ли он от этого. В режиме `stock` не остановился — продажи и
    // остатки едут зеркалом mydon-stock. Расклеить эти две половины молча
    // нельзя: «⛔ учёт стоит» каждый день до катовера — ровно тот дефект,
    // из-за которого гейт когда-то и поставили сразу в двух местах.
    const { svc, db, события } = снапшотныйСтенд({
      источник: "stock",
      снапшотAt: "2026-09-04T00:00:00+05:00",
      lastSuccessAt: "2026-09-05T12:00:00+05:00",
    });
    // Источник учёта кеширует МОДУЛЬ (`accounting-source.ts`, 60 с по
    // переданному `now`), а не сервис: без сброса отчёт получил бы режим
    // предыдущего теста набора — `own`, — и `snapshotStale` стал бы `true` по
    // причине, к правке отношения не имеющей. Тот же приём, что в стенде
    // `сервис()` теста здоровья.
    resetAccountingSourceCache();
    const отчёт = new OurvendHealthService(db, {
      parity: async () => ПАРИТЕТ,
      streak: async () => СЕРИЯ_ПУСТО,
    } as unknown as OurvendParityService);

    assert.equal((await svc.checkSnapshot(сейчас)).emitted, true, "сторож обязан тревожить и в stock");
    assert.equal(события.length, 1);
    assert.equal((await отчёт.health(20, сейчас)).snapshotStale, false, "витрина в stock молчит намеренно");
  });

  it("снапшота нет вовсе — тревога, и часы null, а не ноль", async () => {
    // Ноль читался бы как «сняли только что» — ровно наоборот тому, что значит
    // пустая таблица снимков (то же правило, что у застоя сбора).
    const { svc, события } = снапшотныйСтенд({ источник: "own", снапшотAt: null });
    assert.equal((await svc.checkSnapshot(сейчас)).emitted, true);
    assert.equal(события[0]!.payload.hours, null);
    assert.equal(события[0]!.payload.lastFetchedAt, null);
  });

  it("порог берётся из настройки, а не из константы", async () => {
    const { svc } = снапшотныйСтенд({
      источник: "own",
      снапшотAt: "2026-09-04T02:00:00+05:00",
      настройки: { SNAPSHOT_STALE_HOURS: "24" },
    });
    const r = await svc.checkSnapshot(сейчас);
    assert.deepEqual([r.threshold, r.emitted], [24, true]);
  });

  it("порог сравнивается с СЫРЫМИ часами, а не с округлённым показом", async () => {
    // 35 ч 59 м 49 с округляются до ровно 36.0 — сравнение по показанному
    // числу тревожило бы на 11 секунд раньше настоящей границы (та же ошибка,
    // что у застоя сбора 24.08.2026).
    const { svc, события } = снапшотныйСтенд({ источник: "own", снапшотAt: "2026-09-04T01:00:11+05:00" });
    const r = await svc.checkSnapshot(сейчас);
    assert.equal(r.emitted, false);
    assert.equal(r.hours, 36, "витрина всё равно показывает округлённое число");
    assert.equal(события.length, 0);
  });

  it("ВСТАЛА ОДНА ПОЛОВИНА — тревога есть, и она называет какая (R-FW-P2)", async () => {
    // Агент шлёт три POST-а, у Lot-сессии свой `try`: остатки могут встать при
    // свежих продажах. Пока сторож смотрел только на продажи, замороженный
    // `machine_stock` не видел никто.
    const { svc, события } = снапшотныйСтенд({
      источник: "own",
      снапшотAt: "2026-09-05T09:00:00+05:00",
      остаткиAt: "2026-09-04T00:00:00+05:00",
    });
    assert.equal((await svc.checkSnapshot(сейчас)).emitted, true);
    assert.equal(события[0]!.payload.таблица, "остатков");
    assert.equal(события[0]!.payload.часы_продаж, 4, "живая половина показана честно");
    assert.equal(события[0]!.payload.hours, 37, "часы — по ВСТАВШЕЙ половине");
  });

  it("сутки без продаж не поднимают ложной тревоги, пока идут остатки", async () => {
    // Дни без единой продажи у обеих машин в журнале есть: `fetched_at` продаж
    // не двигается, потому что писать нечего. Снимок остатков при этом
    // приезжает безусловно — значит агент жив.
    const { svc, события } = снапшотныйСтенд({
      источник: "own",
      снапшотAt: "2026-09-05T09:00:00+05:00",
      остаткиAt: "2026-09-05T09:00:00+05:00",
    });
    assert.deepEqual([(await svc.checkSnapshot(сейчас)).stale, события.length], [false, 0]);
  });

  it("нет снимков ОСТАТКОВ вовсе — застой, хотя продажи свежие", async () => {
    const { svc } = снапшотныйСтенд({
      источник: "own",
      снапшотAt: "2026-09-05T09:00:00+05:00",
      остаткиAt: null,
    });
    const r = await svc.checkSnapshot(сейчас);
    assert.deepEqual([r.stale, r.which], [true, "остатков"]);
  });

  it("чужое событие тех же суток дедупом не считается", async () => {
    const { svc, события } = снапшотныйСтенд({
      источник: "own",
      снапшотAt: "2026-09-04T00:00:00+05:00",
      уже: [{ type: SYNC_STALE_EVENT, occurredAt: new Date("2026-09-05T09:00:00+05:00") }],
    });
    assert.equal((await svc.checkSnapshot(сейчас)).emitted, true);
    assert.equal(события.length, 1);
  });

  it("застой СБОРА и застой СНАПШОТА — две независимые тревоги за одни сутки", async () => {
    // Сбор слотов (каждые 3 ч) и суточный съём кабинета (08:05) делают разные
    // агенты: живой сбор ничего не говорит о свежести учёта, и один дедуп на
    // двоих проглотил бы вторую тревогу.
    const { svc, события } = снапшотныйСтенд({
      источник: "own",
      снапшотAt: "2026-09-04T00:00:00+05:00",
      lastSuccessAt: null,
      lastRunStatus: null,
    });
    assert.equal((await svc.check(сейчас)).emitted, true);
    assert.equal((await svc.checkSnapshot(сейчас)).emitted, true);
    assert.deepEqual(события.map((e) => e.type), [SYNC_STALE_EVENT, SNAPSHOT_STALE_EVENT]);
  });
});
