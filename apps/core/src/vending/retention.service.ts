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
  /** Цикл оборван ОШИБКОЙ: `deleted` — то, что успели снести, список неполон. */
  aborted: boolean;
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
 * `SNAPSHOT_RETENTION_DAYS` в панели зажат тем же полом (180) и той же
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
    // `protect: true` — пересечение прогонов невозможно по построению (бюджет
    // 60 с при окне в неделю), но одно слово закрывает вопрос навсегда: если
    // `sweep()` когда-нибудь позовут ещё откуда-то или бюджет вырастет, два
    // одновременных цикла DELETE по одним и тем же таблицам стоили бы
    // блокировок ровно там, где мы их и обещали не держать.
    this.cron = new Cron("10 4 * * 0", { timezone: TZ, protect: true }, () => {
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
   * `system.retention`, когда что-то реально удалено ИЛИ когда чистка
   * оборвалась ошибкой: «удалено 0» — не новость (ни строки в журнале, ни
   * лишнего события за 52 воскресенья в году), а «не смогли удалить» —
   * новость, даже если снести не успели ни строки.
   */
  async sweep(now = new Date()): Promise<RetentionResult[]> {
    const snapshotDays = Math.max(
      // ПОЛ 180, А НЕ 90 (R-FW-S8). Самый широкий живой потребитель истории —
      // отчёт о мёртвом стоке (`DEAD_STOCK_DAYS_MAX = 180`), и окно ретенции
      // уже него молча режет данные ПОД уже работающей витриной. Признание
      // footgun'а в тексте `help` (как было при поле 90) — не защита: вернуть
      // срезанную историю нечем.
      180,
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
      let aborted = false;

      // СОБЫТИЕ — В `finally`, А НЕ ПОСЛЕ ЦИКЛА (R-FW-S3). Пачки коммитятся
      // сами по себе, а `event` вставлялся после всех: падение на третьей
      // пачке означало снесённые безвозвратно строки и НИ СЛЕДА в журнале —
      // хотя эта запись и есть единственное свидетельство чистки. Теперь в
      // журнал уходит ФАКТИЧЕСКИ удалённое число, а `aborted: true` говорит,
      // что список неполон.
      try {
        for (;;) {
          if (this.clock() >= deadline) {
            capped = true;
            break;
          }
          const res = await this.db.execute(this.batchQuery(t, cutoff));
          const n = Number((res as unknown as { count?: number }).count ?? 0);
          deleted += n;
          // Лог НА КАЖДУЮ ПАЧКУ: чистка идёт часами при первом непустом
          // прогоне (окно 180 суток копится полгода), и одна строка в конце не
          // отличает «работает» от «повисло на блокировке».
          if (n > 0) this.logger.log(`Ретенция ${t.name}: удалено ${n} строк (всего ${deleted}).`);
          // Пачка меньше лимита (включая 0) — таблица вычищена: следующий
          // прогон вернул бы 0 и потратил запрос впустую.
          if (n < RETENTION_BATCH) break;
        }
      } catch (e: unknown) {
        aborted = true;
        this.logger.warn(
          `Ретенция ${t.name} оборвана после ${deleted} удалённых строк: ` +
            `${e instanceof Error ? e.message : String(e)}`,
        );
      } finally {
        // «УДАЛЕНО 0» — НЕ НОВОСТЬ, «НЕ СМОГЛИ УДАЛИТЬ» — НОВОСТЬ. Молчание при
        // пустой таблице бережёт журнал от 52 записей ни о чём в году, но тот
        // же порог `deleted > 0` съедал единственный отказ, о котором в журнале
        // не оставалось ни строки: обрыв на ПЕРВОЙ пачке (блокировка, обрыв
        // соединения) давал `aborted`, ноль удалённых — и только `warn` в логе.
        if (deleted > 0 || aborted) {
          results.push({ table: t.name, deleted, olderThanDays: t.olderThanDays, capped, aborted });
          try {
            await this.db.insert(event).values({
              source: "system",
              type: RETENTION_EVENT,
              occurredAt: now,
              payload: { table: t.name, deleted, olderThanDays: t.olderThanDays, aborted },
            });
          } catch (e: unknown) {
            // Отказ ЗАПИСИ О ЧИСТКЕ не должен выглядеть как отказ чистки:
            // строки уже удалены, и молчание тут хуже лишней строки лога.
            this.logger.warn(
              `Ретенция ${t.name}: событие ${RETENTION_EVENT} не записалось (${deleted} строк уже удалено): ` +
                `${e instanceof Error ? e.message : String(e)}`,
            );
          }
        } else if (capped) {
          this.logger.warn(`Ретенция ${t.name}: бюджет исчерпан до первой пачки — доберёт следующее воскресенье.`);
        }
      }
      // Обрыв одной цели не должен уносить остальные: у каждой свой запрос и
      // своя таблица, и «не удалось почистить снимки» — не повод не чистить
      // журнал прогонов.
    }

    return results;
  }
}
