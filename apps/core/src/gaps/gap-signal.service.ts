import { Inject, Injectable, Logger, type OnApplicationShutdown, type OnModuleInit } from "@nestjs/common";
import { gapReconcileRun, gapState } from "@mydon/db";
import { tashkentDay, TZ } from "@mydon/shared";
import { Cron } from "croner";
import { and, eq, isNull, lt, notInArray } from "drizzle-orm";
import { DB, type Db } from "../db/db.module";
import { GapsService, type Gap } from "./gaps.service";

/**
 * Сигнал «стало известно» (Н-2, волна 6).
 *
 * ЧЕГО НЕ ХВАТАЛО. Система умеет говорить, ЧЕГО не хватает («Пробелы»,
 * очереди), и не умеет обратного: «данных стало достаточно — вот цифра».
 * Причина не в том, что никто не написал уведомление, а в том, что сказать
 * это физически не из чего: реестр вычисляется на чтении (R-K4), и
 * закрывшийся пробел просто исчезает между двумя чтениями. Разницы «вчера /
 * сегодня» в системе не существовало.
 *
 * ЧТО ЗДЕСЬ. Раз в сутки реестр сверяется с журналом переходов `gap_state`:
 * что видим сегодня — продлеваем, чего не видим — закрываем сегодняшним днём,
 * чего раньше не было — заводим. Реестр остаётся вычисляемым: журнал ничего
 * не подставляет в его выдачу и не может её пережить.
 *
 * ОДНА СВОДКА В СУТКИ (решение владельца 10.09.2026). Сводка ЗАМЕНЯЕТ
 * поштучные сигналы, а не добавляется к ним: во «Входящих» и без того 42
 * непрочитанных, и поштучный поток убил бы чтение сводки вместе с собой.
 * Поэтому здесь нет ни одного уведомления на каждое закрытие — есть суточный
 * срез, который читают в одном месте.
 *
 * ПОЧЕМУ СВОДКА НЕ ХРАНИТСЯ ОТДЕЛЬНО. Всё, из чего она состоит, уже есть в
 * `gap_state`: закрытые сегодня, заведённые сегодня, открытые давно. Вторая
 * копия тех же слов разъехалась бы с первой — а расходиться тут нечему.
 */

/** Сколько дней пробел должен провисеть открытым, чтобы попасть в «висит давно». */
const STALE_DAYS = 14;

export interface GapDigest {
  /** Ташкентский день, за который собрана сводка. */
  day: string;
  /** Пробелы, закрывшиеся в этот день: то самое «стало известно». */
  becameKnown: { key: string; topic: string; missing: string; openDays: number }[];
  /** Пробелы, впервые увиденные в этот день. */
  appeared: { key: string; topic: string; missing: string }[];
  /** Закрытые раньше и вернувшиеся сегодня: закрытие было мнимым или данные откатились. */
  returned: { key: string; topic: string; missing: string }[];
  /** Открыто сейчас — всего и сколько из них висит дольше STALE_DAYS. */
  open: { total: number; stale: { key: string; topic: string; openDays: number }[] };
  /**
   * Сверка не запускалась в этот день (сервис стоял) — сводка НЕ означает
   * «ничего не изменилось». Отличать обязательно: молчание из-за простоя и
   * молчание из-за спокойного дня — разные новости.
   */
  reconciled: boolean;
}

function daysBetweenIso(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.max(0, Math.round((b - a) / 86_400_000));
}

@Injectable()
export class GapSignalService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(GapSignalService.name);
  private cron: Cron | null = null;

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly gaps: GapsService,
  ) {}

  /**
   * Сверить сегодняшний реестр с журналом переходов. Идемпотентна: повторный
   * прогон в тот же день ничего не меняет — иначе ручной вызов после сбоя
   * «закрыл» бы то, что закрылось вчера, и сводка соврала бы датой.
   */
  async reconcile(
    today = tashkentDay(new Date()),
    gapsNow?: readonly Gap[],
  ): Promise<{ seen: number; closed: number; appeared: number; returned: number }> {
    const list = gapsNow ?? (await this.gaps.list());
    // Пробелы без устойчивого ключа в журнал не попадают: отличить их закрытие
    // от переразбиения окна нечем (см. `Gap.key`).
    const keyed = list.filter((g): g is Gap & { key: string } => g.key !== null);
    // Один ключ может прийти дважды только по ошибке детектора — берём первый
    // и не роняем сверку: журнал переходов не место для спора о дубле.
    const byKey = new Map(keyed.map((g) => [g.key, g] as const));

    const before = await this.db.select({ key: gapState.key, closedOn: gapState.closedOn }).from(gapState);
    const known = new Map(before.map((r) => [r.key, r.closedOn] as const));

    let appeared = 0;
    let returned = 0;
    for (const g of byKey.values()) {
      const was = known.get(g.key);
      const isNew = was === undefined;
      // Был закрыт и снова в реестре — это ВОЗВРАТ, а не новый пробел. День
      // первого появления при этом не переписываем: «висит с такого-то» — не
      // та правда, которую стоит терять ради удобства подсчёта.
      const isReturn = !isNew && was !== null;
      if (isNew) appeared += 1;
      if (isReturn) returned += 1;
      await this.db
        .insert(gapState)
        .values({
          key: g.key,
          topic: g.topic,
          missing: g.missing,
          firstSeenOn: today,
          lastSeenOn: today,
          closedOn: null,
          reopenedOn: null,
        })
        .onConflictDoUpdate({
          target: gapState.key,
          set: {
            topic: g.topic,
            missing: g.missing,
            lastSeenOn: today,
            closedOn: null,
            ...(isReturn ? { reopenedOn: today } : {}),
            updatedAt: new Date(),
          },
        });
    }

    const keys = [...byKey.keys()];
    // Закрываем ровно то, чего сегодня НЕ видели. Условие по `lastSeenOn`
    // делает прогон идемпотентным: повтор в тот же день не «закроет» задним
    // числом то, что закрылось вчера, и сводка не соврёт датой.
    const closedRows = await this.db
      .update(gapState)
      .set({ closedOn: today, updatedAt: new Date() })
      .where(
        keys.length === 0
          ? and(isNull(gapState.closedOn), lt(gapState.lastSeenOn, today))
          : and(isNull(gapState.closedOn), lt(gapState.lastSeenOn, today), notInArray(gapState.key, keys)),
      )
      .returning({ key: gapState.key });

    const closed = closedRows.length;
    // Отметка о прогоне: без неё «сегодня ничего не закрылось» неотличимо от
    // «сверка не запускалась».
    await this.db
      .insert(gapReconcileRun)
      .values({ day: today, gapsSeen: byKey.size, closed, appeared, returned })
      .onConflictDoUpdate({
        target: gapReconcileRun.day,
        set: { gapsSeen: byKey.size, closed, appeared, returned, ranAt: new Date() },
      });

    return { seen: byKey.size, closed, appeared, returned };
  }

  /** Сводка за день — целиком из журнала переходов, без второй копии слов. */
  async digest(day = tashkentDay(new Date())): Promise<GapDigest> {
    const [closed, appeared, returned, open, runs] = await Promise.all([
      this.db.select().from(gapState).where(eq(gapState.closedOn, day)),
      this.db.select().from(gapState).where(and(eq(gapState.firstSeenOn, day), isNull(gapState.closedOn))),
      this.db.select().from(gapState).where(and(eq(gapState.reopenedOn, day), isNull(gapState.closedOn))),
      this.db.select().from(gapState).where(isNull(gapState.closedOn)),
      this.db.select().from(gapReconcileRun).where(eq(gapReconcileRun.day, day)),
    ]);
    return {
      day,
      becameKnown: closed.map((r) => ({
        key: r.key,
        topic: r.topic,
        missing: r.missing,
        openDays: daysBetweenIso(r.firstSeenOn, day),
      })),
      appeared: appeared.map((r) => ({ key: r.key, topic: r.topic, missing: r.missing })),
      returned: returned.map((r) => ({ key: r.key, topic: r.topic, missing: r.missing })),
      open: {
        total: open.length,
        stale: open
          .map((r) => ({ key: r.key, topic: r.topic, openDays: daysBetweenIso(r.firstSeenOn, day) }))
          .filter((r) => r.openDays >= STALE_DAYS)
          .sort((a, b) => b.openDays - a.openDays),
      },
      reconciled: runs.length > 0,
    };
  }

  onModuleInit(): void {
    // 06:00 Ташкента — раньше утреннего брифинга владельца (07:30) и суточной
    // сводки агента (09:00): к моменту, когда их читают, сверка уже прошла.
    this.cron = new Cron("0 6 * * *", { timezone: TZ }, () => {
      void this.reconcile().catch((error: unknown) =>
        this.logger.warn(`Сверка пробелов не отработала: ${error instanceof Error ? error.message : String(error)}`),
      );
    });
  }

  onApplicationShutdown(): void {
    this.cron?.stop();
    this.cron = null;
  }
}
