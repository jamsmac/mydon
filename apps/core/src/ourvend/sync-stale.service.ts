import { Inject, Injectable, Logger, type OnApplicationShutdown, type OnModuleInit } from "@nestjs/common";
import { Cron } from "croner";
import { and, eq, gte } from "drizzle-orm";
import { event } from "@mydon/db";
import { staleHours, tashkentDayStartOf, TZ } from "@mydon/shared";
import { DB, type Db } from "../db/db.module";
import { lastRunStatus, lastSuccessRunAt, syncStaleThreshold } from "./sync-runs";

// Порог живёт в `sync-runs.ts` и реэкспортируется отсюда: его читают ДВОЕ
// (сторож и отчёт), и вторая формула уже расходилась с первой на поле в час.
export { SYNC_STALE_HOURS_FALLBACK } from "./sync-runs";

/** Тип события сторожа — им же ключуется дедуп «раз в ташкентские сутки». */
export const SYNC_STALE_EVENT = "ourvend.sync_stale";

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
      void this.check().catch((e: unknown) =>
        this.logger.warn(`Сторож застоя сбора не отработал: ${e instanceof Error ? e.message : String(e)}`),
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
    const часы = staleHours(успехAt, now);

    // `null` — успехов не было вовсе, и это тревожнее, чем «успех был давно».
    if (часы !== null && часы < threshold) return { staleHours: часы, threshold, emitted: false };

    // Дедуп — раз в ташкентские сутки, тем же приёмом, что у серии отказов
    // (`vending.service.сериюОтказовВСобытие`): крон ходит каждые 30 минут, и
    // без дедупа сутки застоя дали бы 48 одинаковых сообщений подряд.
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
}
