import { Inject, Injectable, Logger, type OnApplicationShutdown, type OnModuleInit } from "@nestjs/common";
import { Cron } from "croner";
import { sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn, PgTable } from "drizzle-orm/pg-core";
import { event, machineSale, productSale, slotSnapshot, vendingSyncRun } from "@mydon/db";
import { TZ } from "@mydon/shared";
import { DB, type Db } from "../db/db.module";
import { readIntSetting } from "../system/settings";

/** Порог, если `SNAPSHOT_RETENTION_DAYS` не задан. Дублирует фолбэк `config-spec.ts`. */
export const SNAPSHOT_RETENTION_DAYS_FALLBACK = 180;

/**
 * Журнал прогонов сбора живёт дольше снимков: это диагностика падений
 * коллектора, а не данные отчётов — владелец не выкручивает это число из
 * панели, поэтому константа кода, а не настройка.
 */
export const SYNC_RUN_RETENTION_DAYS = 365;

/**
 * Пачка и бюджет времени: чистка не должна держать блокировки дольше одного
 * окна крона. Пачка режется по PK через подзапрос (`delete … where id in
 * (select id … limit N)`), а не одним DELETE на десятки тысяч строк.
 */
export const RETENTION_BATCH = 5000;
export const RETENTION_BUDGET_MS = 60_000;
export const RETENTION_EVENT = "system.retention";

export interface RetentionResult {
  table: string;
  deleted: number;
  olderThanDays: number;
  /** Пачка оборвана бюджетом времени, а не концом данных — следующее воскресенье доберёт. */
  capped: boolean;
}

interface RetentionTarget {
  table: PgTable;
  name: string;
  idCol: AnyPgColumn;
  ageCol: AnyPgColumn;
  olderThanDays: number;
}

/**
 * Еженедельная ретенция истории вендинга (R-P8b-7).
 *
 * (а) ЗАЧЕМ ВООБЩЕ, ПРИ БД В 93 МБ. `slot_snapshot` растёт на ~1680 строк/сут
 * (≈230 кБ), диск хоста занят на 68% — «не горит» сегодня не значит «не
 * понадобится» через год ежедневного сбора каждые 3 часа. Ретенция закрывает
 * рост ДО того, как он станет проблемой, а не после.
 *
 * (б) ПОЧЕМУ ОКНО 180 СУТОК, А НЕ 30. Самый широкий живой потребитель истории
 * — отчёт о мёртвом стоке, `DEAD_STOCK_DAYS_MAX = 180` (`analytics.service.ts`),
 * дальше `SHRINK_DAYS_MAX = 60` (усушка) и `DETECT_DAYS_MAX = 30` (детектор
 * заливок). Окно ретенции обязано быть НЕ УЖЕ самого широкого отчёта —
 * иначе чистка тихо срезала бы данные под уже работающей витриной, и
 * `SNAPSHOT_RETENTION_DAYS` в панели зажат тем же полом (90) и той же
 * причиной, что здесь.
 *
 * (в) ПОЧЕМУ `event` И `raw_row` НЕ ТРОГАЕМ (R-P8b-7/9). Журнал событий —
 * доказательная база: из него же считается серия зелёных дней паритета (T2),
 * и ретенция по нему стирала бы собственный вход гейта катовера. `raw_row`
 * заморожен с 01.08 и остаётся сырым слоем источников — его чистит только
 * ручная операция, не крон.
 *
 * Крон — воскресенье 04:10 по Ташкенту: сбор в это время не идёт, суточный
 * бэкап (`backup_extra.sh`) уже прошёл, а до утреннего паритета (08:40)
 * четыре часа запаса.
 */
@Injectable()
export class RetentionService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(RetentionService.name);
  private cron: Cron | null = null;

  /**
   * Заменяемо тестом. Бюджет мерится РЕАЛЬНЫМ временем выполнения — иначе
   * прогон, застрявший на блокировке, не оборвался бы никогда; `now` в
   * `sweep()` — это граница «сколько назад», а не часы стенки.
   */
  private clock: () => number = () => Date.now();

  constructor(@Inject(DB) private readonly db: Db) {}

  onModuleInit(): void {
    this.cron = new Cron("10 4 * * 0", { timezone: TZ }, () => {
      void this.sweep().catch((e: unknown) =>
        this.logger.warn(`Ретенция не отработала: ${e instanceof Error ? e.message : String(e)}`),
      );
    });
  }

  onApplicationShutdown(): void {
    this.cron?.stop();
    this.cron = null;
  }

  /** Пачка DELETE по подзапросу PK, отсортированному по колонке возраста — старейшие строки первыми. */
  private batchQuery(t: RetentionTarget, cutoff: Date): SQL {
    return sql`
      delete from ${t.table}
      where ${t.idCol} in (
        select ${t.idCol} from ${t.table}
        where ${t.ageCol} < ${cutoff}
        order by ${t.ageCol}
        limit ${sql.raw(String(RETENTION_BATCH))}
      )
    `;
  }

  /**
   * Прогон ретенции. `now` — параметр: границу «N суток назад» иначе нечем
   * проверить тестом.
   *
   * Четыре цели, каждая своей колонкой возраста: `slot_snapshot.captured_at`,
   * `product_sale.captured_at`, `machine_sale.captured_at` —
   * `SNAPSHOT_RETENTION_DAYS`; `vending_sync_run.started_at` —
   * `SYNC_RUN_RETENTION_DAYS`. Таблица попадает в результат и получает событие
   * `system.retention` ТОЛЬКО когда что-то реально удалено: «удалено 0» — не
   * новость, ни строки в журнале, ни лишнего события за 52 воскресенья в году.
   */
  async sweep(now = new Date()): Promise<RetentionResult[]> {
    const snapshotDays = Math.max(
      90,
      Math.trunc(
        await readIntSetting(this.db, "SNAPSHOT_RETENTION_DAYS", SNAPSHOT_RETENTION_DAYS_FALLBACK, this.logger),
      ),
    );

    const targets: RetentionTarget[] = [
      { table: slotSnapshot, name: "slot_snapshot", idCol: slotSnapshot.id, ageCol: slotSnapshot.capturedAt, olderThanDays: snapshotDays },
      { table: productSale, name: "product_sale", idCol: productSale.id, ageCol: productSale.capturedAt, olderThanDays: snapshotDays },
      { table: machineSale, name: "machine_sale", idCol: machineSale.id, ageCol: machineSale.capturedAt, olderThanDays: snapshotDays },
      {
        table: vendingSyncRun,
        name: "vending_sync_run",
        idCol: vendingSyncRun.id,
        ageCol: vendingSyncRun.startedAt,
        olderThanDays: SYNC_RUN_RETENTION_DAYS,
      },
    ];

    // Один общий бюджет на весь прогон, не на таблицу: цель — не держать
    // блокировки дольше одного окна крона суммарно, а не по 60 с на каждую
    // из четырёх целей.
    const deadline = this.clock() + RETENTION_BUDGET_MS;
    const results: RetentionResult[] = [];

    for (const t of targets) {
      const cutoff = new Date(now.getTime() - t.olderThanDays * 86_400_000);
      let deleted = 0;
      let capped = false;

      for (;;) {
        if (this.clock() >= deadline) {
          capped = true;
          break;
        }
        const res = await this.db.execute(this.batchQuery(t, cutoff));
        const n = Number((res as unknown as { count?: number }).count ?? 0);
        deleted += n;
        // Пачка меньше лимита (включая 0) — таблица вычищена: следующий
        // прогон вернул бы 0 и потратил запрос впустую.
        if (n < RETENTION_BATCH) break;
      }

      if (deleted > 0) {
        results.push({ table: t.name, deleted, olderThanDays: t.olderThanDays, capped });
        await this.db.insert(event).values({
          source: "system",
          type: RETENTION_EVENT,
          occurredAt: now,
          payload: { table: t.name, deleted, olderThanDays: t.olderThanDays },
        });
      } else if (capped) {
        this.logger.warn(`Ретенция ${t.name}: бюджет исчерпан до первой пачки — доберёт следующее воскресенье.`);
      }
    }

    return results;
  }
}
