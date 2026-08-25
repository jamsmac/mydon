import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { event, systemConfig, vendingSyncRun } from "@mydon/db";
import { SyncStaleService, SYNC_STALE_EVENT, SYNC_STALE_HOURS_FALLBACK } from "./sync-stale.service";

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
  const прогоны: Прогон[] = [];
  if (м.lastSuccessAt) {
    const at = new Date(м.lastSuccessAt);
    прогоны.push({ startedAt: at, finishedAt: at, status: "success" });
  }
  // Прогон ПОЗЖЕ успеха задаётся явно: без него «последний прогон» — это сам
  // успех, и статус в событии будет «success».
  if (м.lastRunStatus) {
    прогоны.push({ startedAt: МОМЕНТ_ПОСЛЕДНЕГО, finishedAt: МОМЕНТ_ПОСЛЕДНЕГО, status: м.lastRunStatus });
  }

  const события: Событие[] = (м.уже ?? []).map((e, i) => ({ id: `e${i}`, type: e.type, occurredAt: e.occurredAt }));
  const записано: { source: string; type: string; payload: Record<string, unknown>; occurredAt: Date }[] = [];
  const настройки = Object.entries(м.настройки ?? {}).map(([key, value]) => ({ key, value }));

  const db = {
    select: () => ({
      from: (t: unknown) => {
        let текущие: unknown[] =
          t === vendingSyncRun ? [...прогоны] : t === event ? [...события] : t === systemConfig ? настройки : [];
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
          текущие = [...(текущие as Прогон[])].sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());
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

  return { svc: new SyncStaleService(db), события: записано, журнал: события };
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
});
