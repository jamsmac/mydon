import { Inject, Injectable, Logger, type OnApplicationShutdown, type OnModuleInit } from "@nestjs/common";
import { Cron } from "croner";
import { and, eq, gte } from "drizzle-orm";
import { event } from "@mydon/db";
import { staleHours, tashkentDayStartOf, TZ } from "@mydon/shared";
import { DB, type Db } from "../db/db.module";
import { accountingSource } from "../sales/accounting-source";
import {
  lastRunStatus,
  lastSnapshotAt,
  lastSuccessRunAt,
  rawStaleHours,
  snapshotStaleThreshold,
  snapshotStaleVerdict,
  syncStaleThreshold,
} from "./sync-runs";

// Пороги живут в `sync-runs.ts` и реэкспортируются отсюда: их читают ДВОЕ
// (сторож и отчёт), и вторая формула уже расходилась с первой на поле в час.
export { SNAPSHOT_STALE_HOURS_FALLBACK, SYNC_STALE_HOURS_FALLBACK } from "./sync-runs";

/** Тип события сторожа — им же ключуется дедуп «раз в ташкентские сутки». */
export const SYNC_STALE_EVENT = "ourvend.sync_stale";

/** Тип события сторожа СНАПШОТА — свой дедуп, свои сутки (R-P8b-5). */
export const SNAPSHOT_STALE_EVENT = "ourvend.snapshot_stale";

/**
 * Сторож «сбор OurVend не бежит» (R-P8a-6).
 *
 * ЧЕМ ЭТО ОТЛИЧАЕТСЯ ОТ `ourvend.sync_failed_streak`. Серия отказов — это
 * «сбор идёт, но подряд падает»: её считает `finishSyncRun`, то есть коллектор
 * САМ доложил об отказе. Застой — это «сбор не бежит вовсе»: контейнер агентов
 * лёг, крон не встал, `finishSyncRun` не зовут НИКОГДА — и streak-детектор
 * физически не сработает ни разу. 24–25.08.2026 отказы хотя бы писались; сутки
 * полной тишины не заметил бы вообще никто, потому что отсутствие строк
 * выглядит как спокойствие, а не как авария.
 *
 * ПОЧЕМУ СВОЙ КРОН, А НЕ ПОЛЕ ОТЧЁТА. `GET /ourvend/health` показывает то, что
 * ОТКРЫЛИ; тревога должна прийти сама. Отчёт своё поле `staleHours` тоже
 * получил — но он про «пришёл посмотреть», а этот сервис про «никто не
 * смотрел».
 *
 * ПОЧЕМУ НЕ ЗОВЁМ `OurvendHealthService.health()`. Внутри отчёта весь сырой SQL
 * паритета — гонять его каждые 30 минут ради одной даты значит платить ни за
 * что, а падение паритета погасило бы сторожа целиком. Берём ровно два запроса
 * к журналу прогонов, ОБЩИХ с отчётом (`sync-runs.ts`): своя копия разошлась бы
 * с витриной на первом же уточнении.
 *
 * `null` ЧАСОВ — ТРЕВОЖНЕЕ БОЛЬШОГО ЧИСЛА. «Успехов не было вовсе» означает,
 * что сбор не заводили или он не доехал ни разу; молчать об этом нельзя, и
 * тревога уходит с `hoursSinceSuccess: null`, а не с нулём.
 *
 * ВТОРОЙ СТОРОЖ В ЭТОМ ЖЕ СЕРВИСЕ (`checkSnapshot`, R-P8b-5) следит за
 * СУТОЧНЫМ СНИМКОМ КАБИНЕТА — другим агентом и другой таблицей. Он живёт
 * здесь, а не отдельным сервисом, потому что делит с соседом всё, кроме
 * вопроса: тот же получасовой крон, тот же дедуп по ташкентским суткам, та же пара
 * «показ округлён / решение по сырым часам» и тот же журнал событий. Второй
 * `@Injectable` с собственным `Cron` ради одного запроса означал бы ещё один
 * таймер в `cron-shutdown` и две копии дедупа, которые разойдутся на первом же
 * уточнении.
 */
@Injectable()
export class SyncStaleService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(SyncStaleService.name);
  private cron: Cron | null = null;

  constructor(@Inject(DB) private readonly db: Db) {}

  /**
   * Каждые полчаса по Ташкенту: порог считается часами, и получасовой шаг даёт
   * тревогу не позже чем через 30 минут после его пересечения. Чаще незачем —
   * сбор ходит раз в три часа.
   */
  onModuleInit(): void {
    this.cron = new Cron("*/30 * * * *", { timezone: TZ }, () => {
      // Две проверки одним тиком, но КАЖДАЯ ПОД СВОИМ `catch`: они спрашивают
      // разные таблицы и разных агентов, и падение одной (например, `select`
      // по журналу прогонов на перезапуске базы) не должно гасить вторую.
      // Общий `catch` на обе означал бы, что сбой сбора заодно ослепляет
      // сторожа учёта — ровно в тот момент, когда учёт важнее всего.
      void this.check().catch((e: unknown) =>
        this.logger.warn(`Сторож застоя сбора не отработал: ${e instanceof Error ? e.message : String(e)}`),
      );
      void this.checkSnapshot().catch((e: unknown) =>
        this.logger.warn(`Сторож свежести снапшота не отработал: ${e instanceof Error ? e.message : String(e)}`),
      );
    });
  }

  onApplicationShutdown(): void {
    this.cron?.stop();
    this.cron = null;
  }

  /**
   * Проверить давность успеха и, если пора, записать событие.
   *
   * `now` — параметр, а не `Date.now()` внутри: «семь часов назад» иначе нечем
   * проверить тестом, и дедуп по ташкентским суткам проверялся бы датой
   * прогона тестов.
   */
  async check(now = new Date()): Promise<{ staleHours: number | null; threshold: number; emitted: boolean }> {
    const [успех, статус, threshold] = await Promise.all([
      lastSuccessRunAt(this.db),
      lastRunStatus(this.db),
      // Тот же расчёт порога, что отдаёт наружу отчёт о здоровье: витрина
      // сравнивает с числом, по которому будят владельца, а не со своим.
      syncStaleThreshold(this.db, this.logger),
    ]);

    const успехAt = успех ? успех.toISOString() : null;
    // ПОКАЗ и РЕШЕНИЕ считаются РАЗНЫМИ числами (П8a fix wave; адверсариал
    // прод-данные №7, minor «округление порога»). `часы` — округлённое до
    // 0.1 ч (`staleHours` из `@mydon/shared`) и уходит только в ответ/событие
    // как то, что видит владелец. Порог сравнивается с `сырыеЧасы` —
    // `rawStaleHours` из `sync-runs.ts`, БЕЗ округления: «5 ч 59 м 49 с»
    // округляются до ровно 6.0, и сравнение по округлённому числу решило бы,
    // что порог 6 пройден, на 11 секунд раньше настоящей границы — авария
    // 24.08.2026 началась ровно на ней.
    const часы = staleHours(успехAt, now);
    const сырыеЧасы = rawStaleHours(успехAt, now);

    // `null` — успехов не было вовсе, и это тревожнее, чем «успех был давно».
    if (сырыеЧасы !== null && сырыеЧасы < threshold) return { staleHours: часы, threshold, emitted: false };

    // Дедуп — раз в ташкентские сутки, тем же приёмом, что у серии отказов
    // (`vending.service.сериюОтказовВСобытие`): крон ходит каждые 30 минут, и
    // без дедупа сутки застоя дали бы 48 одинаковых сообщений подряд.
    //
    // ПРИНЯТАЯ ГОНКА (R-FW-S7, П8a fix wave; адверсариал безопасность №7, не
    // фикс). Дедуп ниже — это select→insert БЕЗ уникального индекса на
    // `(type, occurredAt::date)`: если бы Core крутился в двух репликах,
    // синхронный тик `*/30 * * * *` у обеих дал бы «было = false» на одном и
    // том же прогоне и записал бы два одинаковых события за сутки. Порог
    // безопасен, потому что владелец держит ОДНУ реплику Core — вторая
    // появится только с горизонтальным масштабированием, и решать эту гонку
    // раньше него смысла нет. Цена закрытия — частичный UNIQUE-индекс по
    // ташкентским суткам либо `select … for update`; см. также аналогичное
    // принятое окно у `известныйСотрудник` (`vending.service.ts`).
    const сутки = tashkentDayStartOf(now);
    const [было] = await this.db
      .select({ id: event.id })
      .from(event)
      .where(and(eq(event.type, SYNC_STALE_EVENT), gte(event.occurredAt, сутки)))
      .limit(1);
    if (было) return { staleHours: часы, threshold, emitted: false };

    await this.db.insert(event).values({
      source: "system",
      type: SYNC_STALE_EVENT,
      // Момент проверки, а не `now()` базы: дедуп сравнивает с ТЕМ ЖЕ `now`, и
      // расхождение часов процесса с базой иначе давало бы два события на
      // границе суток либо ни одного.
      occurredAt: now,
      payload: { hoursSinceSuccess: часы, lastSuccessAt: успехAt, lastRunStatus: статус },
    });
    return { staleHours: часы, threshold, emitted: true };
  }

  /**
   * Свежесть УЧЁТНОГО СНАПШОТА в режиме `own` (R-P8b-5).
   *
   * ЧЕМ ЭТО ОТЛИЧАЕТСЯ ОТ ДВУХ СОСЕДЕЙ. `ourvend.sync_failed_streak` — «прямой
   * сбор ПАДАЕТ» (коллектор сам доложил об отказе). `ourvend.sync_stale` —
   * «прямой сбор НЕ БЕЖИТ» (никто не докладывает вовсе). Этот сторож про
   * ТРЕТЬЕГО агента: `ourvend:accounting` не приносит СУТОЧНЫЙ снимок
   * кабинета. В режиме `own` это молча останавливает `sale` и `machine_stock`,
   * потому что синк читает снапшот с фильтром `fetched_at > now() - interval
   * '3 days'` (`sales.service.ts`, `supply.service.ts`): на четвёртые сутки
   * молчания агента выборка становится пустой — БЕЗ ошибки, БЕЗ события, с
   * честным `{ upserted: 0 }`. Ни один из двух соседей этого не увидит: слоты
   * при этом продолжают идти, прогоны закрываются успехом, и здоровье сбора
   * зелёное.
   *
   * ПОЧЕМУ В РЕЖИМЕ `stock` НЕ ПРОВЕРЯЕМ НИЧЕГО. Там снапшот теневой: продажи
   * и остатки едут зеркалом mydon-stock, а `ourvend_sale_snapshot` копится
   * только ради паритета. Тревожить о нём — значит будить владельца о таблице,
   * которая ни на что не влияет; а на проде до катовера это КАЖДЫЙ день.
   *
   * `now` — параметр по той же причине, что у соседа: иначе «37 часов назад»
   * нечем проверить тестом, а дедуп сверялся бы датой прогона тестов.
   */
  async checkSnapshot(now = new Date()): Promise<{
    hours: number | null;
    threshold: number;
    stale: boolean;
    emitted: boolean;
    /** Какая половина встала: «продаж», «остатков», «продаж и остатков». `null` — обе живы. */
    which: string | null;
  }> {
    const [источник, threshold] = await Promise.all([
      // `now` ПРОБРАСЫВАЕТСЯ: кеш источника ключуется временем, и вызов без
      // момента считал бы срок жизни кеша по стенным часам там, где весь
      // остальной метод считается параметром.
      accountingSource(this.db, now),
      snapshotStaleThreshold(this.db, this.logger),
    ]);
    // Порог отдаём и здесь: вызывающий (тест, ручной прогон) должен видеть, по
    // какому числу СТОРОЖ БЫ судил, даже когда судить в этом режиме не о чем.
    if (источник !== "own") return { hours: null, threshold, stale: false, emitted: false, which: null };

    // ОБЕ ПОЛОВИНЫ СНАПШОТА, РАЗДЕЛЬНО (R-FW-P2). Агент шлёт три отдельных
    // POST-а, у Lot-сессии свой `try`: упавшие остатки замораживают
    // `machine_stock` при свежих часах продаж, а сутки без единой продажи не
    // двигают `fetched_at` продаж вовсе — один взгляд на продажи давал бы и
    // пропущенную аварию, и ложную тревогу.
    const свежесть = await lastSnapshotAt(this.db);
    // ПОКАЗ и РЕШЕНИЕ — разные числа, как у соседа: `hours` округлено до 0.1 ч
    // и едет владельцу, а порог сравнивается с сырыми часами внутри
    // `snapshotStaleVerdict` (той же функцией считает вердикт витрина).
    const вердикт = snapshotStaleVerdict(свежесть, now, threshold);
    const снимокAt = вердикт.lastFetchedAt;
    const hours = staleHours(снимокAt, now);
    const stale = вердикт.stale;
    if (!stale) return { hours, threshold, stale, emitted: false, which: null };

    // Дедуп — раз в ташкентские сутки и по СВОЕМУ типу события: у застоя сбора
    // свой, и один ключ на двоих проглатывал бы вторую тревогу в те сутки,
    // когда встало и то и другое (а встают они обычно вместе — от одного
    // упавшего контейнера агентов). Принятая гонка select→insert — та же, что
    // у соседа (одна реплика Core), см. его комментарий.
    const сутки = tashkentDayStartOf(now);
    const [было] = await this.db
      .select({ id: event.id })
      .from(event)
      .where(and(eq(event.type, SNAPSHOT_STALE_EVENT), gte(event.occurredAt, сутки)))
      .limit(1);
    if (было) return { hours, threshold, stale, emitted: false, which: вердикт.which };

    await this.db.insert(event).values({
      source: "system",
      type: SNAPSHOT_STALE_EVENT,
      occurredAt: now,
      payload: {
        hours,
        lastFetchedAt: снимокAt,
        // КАКАЯ ПОЛОВИНА ВСТАЛА — словами: «снапшот не обновляется» отправляет
        // чинить всё сразу, а встать могла одна Lot-сессия.
        таблица: вердикт.which,
        часы_продаж: вердикт.salesHours === null ? null : Math.round(вердикт.salesHours * 10) / 10,
        часы_остатков: вердикт.stockHours === null ? null : Math.round(вердикт.stockHours * 10) / 10,
      },
    });
    return { hours, threshold, stale, emitted: true, which: вердикт.which };
  }
}
