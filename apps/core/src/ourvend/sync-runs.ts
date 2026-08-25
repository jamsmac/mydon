import type { Logger } from "@nestjs/common";
import { desc, eq } from "drizzle-orm";
import { vendingSyncRun } from "@mydon/db";
import type { OurvendSyncRun } from "@mydon/shared";
import type { Db } from "../db/db.module";
import { readIntSetting } from "../system/settings";

/**
 * Три вопроса о сборе, которые задают ДВОЕ: отчёт о здоровье
 * (`OurvendHealthService`) и сторож застоя (`SyncStaleService`) — два к журналу
 * прогонов и один к настройкам.
 *
 * Отдельный модуль, а не метод сервиса, по двум причинам. Первая: сторож не
 * может звать `health()` — внутри отчёта весь сырой SQL паритета, и гонять его
 * каждые 30 минут ради одной даты значит платить ни за что, а падение паритета
 * погасило бы сторожа. Вторая: своя копия запроса у сторожа разошлась бы с
 * отчётом на первом же уточнении — например, на том, что успех датируется
 * ЗАВЕРШЕНИЕМ прогона, а не стартом. Тогда витрина говорила бы «последний
 * успех в 03:07», а тревога считала бы часы от 03:05.
 */

/**
 * Завершение последнего УСПЕШНОГО прогона. `null` — успехов нет ВОВСЕ.
 *
 * Отдельным запросом, а не поиском в показанных прогонах: 200 почасовых строк
 * — это всего ~8 суток, и после недели молчания поле стало бы `null`, то есть
 * «сбор не запускался никогда». Разница между «успеха давно не было» и
 * «успехов не было вовсе» решает, чинить коллектор или заводить его впервые.
 */
export async function lastSuccessRunAt(db: Db): Promise<Date | null> {
  const [row] = await db
    .select({ startedAt: vendingSyncRun.startedAt, finishedAt: vendingSyncRun.finishedAt })
    .from(vendingSyncRun)
    .where(eq(vendingSyncRun.status, "success"))
    .orderBy(desc(vendingSyncRun.startedAt))
    .limit(1);
  // Успех датируется ЗАВЕРШЕНИЕМ, а не стартом: «последний раз данные приехали
  // в 03:07», а не «мы начали пробовать в 03:05».
  return row ? (row.finishedAt ?? row.startedAt) : null;
}

/**
 * Статус САМОГО СВЕЖЕГО прогона любого исхода. `null` — журнал пуст.
 *
 * Тревоге о застое он нужен, чтобы владелец сразу понял, ЧТО чинить: «стоит
 * 7 ч, последний прогон failed» — это коллектор падает, а «стоит 7 ч,
 * прогонов нет» — это коллектор не запускается вовсе.
 */
export async function lastRunStatus(db: Db): Promise<OurvendSyncRun["status"] | null> {
  const [row] = await db
    .select({ status: vendingSyncRun.status })
    .from(vendingSyncRun)
    .orderBy(desc(vendingSyncRun.startedAt))
    .limit(1);
  return row?.status ?? null;
}

/** Порог застоя, если настройки нет: сбор ходит раз в 3 ч, 6 ч = два пропуска подряд. */
export const SYNC_STALE_HOURS_FALLBACK = 6;

/**
 * Порог застоя сбора, часов — ОДНО число для сторожа и для витрины.
 *
 * ПОЧЕМУ ЗДЕСЬ, А НЕ ДВУМЯ ФОРМУЛАМИ. Отчёт отдаёт порог наружу
 * (`OurvendHealth.staleThresholdH`), и бот с панелью рисуют «⛔ сбор стоит»
 * сравнением `staleHours >= staleThresholdH`. Пока пол в один час стоял только
 * у сторожа, `SYNC_STALE_HOURS=0` из env (панель такое отобьёт валидатором,
 * env — нет) давал вечный бейдж «сбор стоит» при молчащем стороже, а `2.5` —
 * бейдж по 2.5 ч против тревоги по 2 ч. Витрина обязана показывать ровно то
 * число, по которому будят владельца.
 *
 * ПОЛ В ОДИН ЧАС. `readIntSetting` пропускает ноль как осознанное значение (для
 * порогов-сумм это «тревожить на любую потерю»), но порог «0 часов» означает
 * тревогу в КАЖДЫЙ прогон крона — 48 сообщений в сутки при живом сборе.
 * Дробь усекается: часы здесь считаются целыми, а «2.5» в настройке — это
 * описка, а не пожелание получать тревогу на середине часа.
 */
export async function syncStaleThreshold(db: Db, logger?: Logger): Promise<number> {
  const настройка = await readIntSetting(db, "SYNC_STALE_HOURS", SYNC_STALE_HOURS_FALLBACK, logger);
  return Math.max(1, Math.trunc(настройка));
}
