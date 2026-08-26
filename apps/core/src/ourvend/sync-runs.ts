import type { Logger } from "@nestjs/common";
import { and, asc, desc, gte, inArray, lt } from "drizzle-orm";
import { ourvendSaleSnapshot, ourvendStockSnapshot, vendingSyncRun } from "@mydon/db";
import { tashkentInstant, type OurvendSyncRun } from "@mydon/shared";
import type { Db } from "../db/db.module";
import type { SyncRunFacts } from "../vending/sync-streak";
import { readIntSetting } from "../system/settings";

/**
 * Вопросы о сборе и об учётном снапшоте, которые задают ДВОЕ и БОЛЬШЕ: отчёт о
 * здоровье (`OurvendHealthService`), сторож застоя (`SyncStaleService`),
 * счётчик серии паритета (`OurvendParityService`) и синк продаж
 * (`SalesService`) — два к журналу прогонов, один к последнему снапшоту, два к
 * арифметике давности и три к настройкам (пороги застоя сбора, катовера и
 * застоя снапшота).
 *
 * Отдельный модуль, а не метод сервиса, по двум причинам. Первая: сторож не
 * может звать `health()` — внутри отчёта весь сырой SQL паритета, и гонять его
 * каждые 30 минут ради одной даты значит платить ни за что, а падение паритета
 * погасило бы сторожа. Вторая: своя копия запроса у сторожа разошлась бы с
 * отчётом на первом же уточнении — например, на том, что успех датируется
 * ЗАВЕРШЕНИЕМ прогона, а не стартом. Тогда витрина говорила бы «последний
 * успех в 03:07», а тревога считала бы часы от 03:05.
 *
 * ШЕСТОЙ ВОПРОС — «ЧТО БЫЛО В ЭТОЙ НЕДЕЛЕ» (R-H-9). Недельное письмо
 * подписано неделей и обязано считать здоровье сбора ЗА НЕЁ, а не за момент
 * отправки. Своя копия запроса у письма разошлась бы с отчётом ровно на том же
 * уточнении, что и у сторожа: успех датируется ЗАВЕРШЕНИЕМ прогона. Поэтому
 * окно приезжает сюда параметром (`RunWindow`), а не заводит рядом второй
 * запрос к тому же журналу.
 */

/**
 * Окно прогонов — ПОЛУИНТЕРВАЛ `[from, to)`.
 *
 * `lte` по концу воскресенья втянул бы полночь понедельника в ОБЕ соседние
 * недели, и один и тот же прогон посчитался бы дважды — в письме о прошлой
 * неделе и в письме о следующей. То же правило, по которому считается вся
 * остальная работа за неделю (`WeeklyDigestService.работаЗаНеделю`).
 */
export interface RunWindow {
  from: Date;
  to: Date;
}

/**
 * Прогонов больше, чем в неделе бывает, не читаем: 8 прогонов/сут × 7 + запас.
 *
 * Потолок нужен не ради скорости, а ради предсказуемости: `?week=` пускает
 * любую неделю из двух лет, и неделя с зациклившимся кроном не имеет права
 * вытянуть в память весь журнал.
 */
export const WEEK_RUNS_LIMIT = 200;

/** Две границы окна одним местом: полуинтервал объявлен ровно один раз. */
function границы(window: RunWindow) {
  return [gte(vendingSyncRun.startedAt, window.from), lt(vendingSyncRun.startedAt, window.to)] as const;
}

/**
 * Завершение последнего прогона, который ДОНЁС ДАННЫЕ — статус `success` ИЛИ
 * `partial`. `null` — таких прогонов нет ВОВСЕ (R-FW-P4, П8a fix wave;
 * адверсариал прод-данные №4).
 *
 * ПОЧЕМУ `partial` СЧИТАЕТСЯ. Частичный сбор — это когда часть автоматов
 * ответила и слоты приехали: коллектор ЖИВ, просто не все машины откликнулись
 * за проход. Пока в счёт шёл только `success`, два `partial` подряд (каждый
 * честно закрывает прогон, но не двигает «последний успех») читались бы
 * сторожем и отчётом как 6+ часов ПОЛНОГО молчания и будили владельца «⛔ сбор
 * OurVend стоит», хотя данные шли всё это время. `failedStreak`
 * (`sync-streak.ts`) эта правка НЕ трогает: там вопрос другой — «сколько
 * подряд прогонов ЗАВЕРШИЛОСЬ ОТКАЗОМ», и `partial` там как рвал серию
 * отказов, так и рвёт (данные ведь приехали) — это уже было верно.
 *
 * Отдельным запросом, а не поиском в показанных прогонах: 200 почасовых строк
 * — это всего ~8 суток, и после недели молчания поле стало бы `null`, то есть
 * «сбор не запускался никогда». Разница между «успеха давно не было» и
 * «успехов не было вовсе» решает, чинить коллектор или заводить его впервые.
 *
 * ОКНО НЕОБЯЗАТЕЛЬНОЕ (R-H-9): без него функция ведёт себя ровно как раньше, и
 * вызывающие, которым нужен «последний успех вообще» (`OurvendHealthService`,
 * `SyncStaleService`), не правятся ни на байт. С окном отвечает на другой
 * вопрос — «последний успех ЭТОЙ недели», и `null` там значит «успехов в
 * неделе не было ВОВСЕ», а не «ноль часов назад».
 */
export async function lastSuccessRunAt(db: Db, window?: RunWindow): Promise<Date | null> {
  const донёсДанные = inArray(vendingSyncRun.status, ["success", "partial"]);
  const [row] = await db
    .select({ startedAt: vendingSyncRun.startedAt, finishedAt: vendingSyncRun.finishedAt })
    .from(vendingSyncRun)
    .where(window ? and(донёсДанные, ...границы(window)) : донёсДанные)
    .orderBy(desc(vendingSyncRun.startedAt))
    .limit(1);
  // Успех датируется ЗАВЕРШЕНИЕМ, а не стартом: «последний раз данные приехали
  // в 03:07», а не «мы начали пробовать в 03:05».
  return row ? (row.finishedAt ?? row.startedAt) : null;
}

/**
 * Прогоны, НАЧАТЫЕ в окне, свежие сверху (R-H-9).
 *
 * Датируются СТАРТОМ, а не завершением, — в отличие от «последнего успеха»
 * выше, и это не разнобой: прогон принадлежит той неделе, в которую его
 * запустил крон. Считай мы по `finished_at`, прогон, начатый в 23:50
 * воскресенья и закрывшийся в 00:03 понедельника, уехал бы в чужую неделю, а
 * прогон, зависший без `finished_at`, не попал бы ни в одну.
 */
export async function runsInWindow(
  db: Db,
  window: RunWindow,
  limit = WEEK_RUNS_LIMIT,
): Promise<SyncRunFacts[]> {
  const rows = await db
    .select({
      status: vendingSyncRun.status,
      startedAt: vendingSyncRun.startedAt,
      error: vendingSyncRun.error,
    })
    .from(vendingSyncRun)
    .where(and(...границы(window)))
    .orderBy(desc(vendingSyncRun.startedAt))
    .limit(limit);
  return rows.map((r) => ({ status: r.status, startedAt: r.startedAt, error: r.error }));
}

/**
 * САМЫЙ РАННИЙ прогон в журнале — начало наблюдения. `null` — журнал пуст.
 *
 * ЗАЧЕМ (R-FW-P5). `?week=` пускает 104 недели назад, а журнал на проде
 * начинается 06.08.2026: всякая неделя до этой даты честно отдаёт `runs: 0`,
 * `lastDataAt: null` — и без даты начала это читается как «сбор не
 * запускался», то есть как авария. Тот же довод, которым этот файл
 * обосновывает отдельный запрос «последнего успеха»: разница между «давно не
 * было» и «не было ВОВСЕ» решает, чинить коллектор или заводить его впервые —
 * здесь она же, только про сам журнал.
 *
 * БЕЗ ОКНА и с `asc`: вопрос не «что было в этой неделе», а «с какого момента
 * журнал вообще что-то знает». Запрос индексный (`started_at`), цена — одна
 * строка.
 */
export async function firstRunAt(db: Db): Promise<Date | null> {
  const [row] = await db
    .select({ startedAt: vendingSyncRun.startedAt })
    .from(vendingSyncRun)
    .orderBy(asc(vendingSyncRun.startedAt))
    .limit(1);
  return row?.startedAt ?? null;
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

/**
 * Часов с последнего успеха, БЕЗ округления — ЧЕТВЁРТЫЙ общий вопрос сторожа
 * и отчёта, рядом с тремя выше (П8a fix wave; адверсариал прод-данные №7,
 * minor «округление порога»).
 *
 * ТОЧНОЕ ПРАВИЛО: порог сравнивается с СЫРЫМ числом (эта функция) — округление
 * `staleHours` из `@mydon/shared` (до 0.1 ч) существует ТОЛЬКО для того, что
 * видит владелец (`OurvendHealth.staleHours`, текст события сторожа,
 * `hoursSinceSuccess` в его payload). Смешивать эти два числа значит двигать
 * ГРАНИЦУ: при пороге 6 «5 ч 59 м 49 с» округляются до ровно 6.0, и сравнение
 * `6.0 < 6` ложно — сторож решил бы, что срок вышел, на 11 секунд раньше
 * настоящего порога. Авария 24.08.2026 (`adversarial-prod-data.md` №13)
 * началась ровно на этой границе.
 *
 * Функция — не альтернативная формула: та же зона (`tashkentInstant`, а не
 * часы процесса) и то же зажатие отрицательного возраста в ноль (успех «из
 * будущего» — расхождение часов агента и базы, не повод рисовать минус),
 * просто без последнего шага округления `staleHours`. Дублирует шаги
 * НАМЕРЕННО: тянуть недо-округлённое число из `staleHours` изнутри
 * `@mydon/shared` невозможно, не разойдясь с ним, а лишний импорт ради одной
 * строки арифметики того не стоит.
 */
export function rawStaleHours(lastSuccessAt: string | null, now: Date): number | null {
  if (!lastSuccessAt) return null;
  const at = tashkentInstant(lastSuccessAt);
  if (!at) return null;
  const мс = Math.max(0, now.getTime() - at.getTime());
  return мс / 3_600_000;
}

/** Порог катовера, если настройки нет: семь зелёных дней паритета (§П8 плана поглощения). */
export const CUTOVER_GREEN_DAYS_FALLBACK = 7;

/**
 * Сколько зелёных дней паритета подряд открывают переключение источника учёта.
 *
 * ЗДЕСЬ, А НЕ У СЧЁТЧИКА, ПО ТОЙ ЖЕ ПРИЧИНЕ, ЧТО И `syncStaleThreshold`.
 * Порог уезжает наружу (`OurvendHealth.cutoverThreshold`,
 * `ParityStreak.threshold`), и бот с панелью рисуют «✅ можно переключать»
 * сравнением `parityStreak >= cutoverThreshold`. Витрина обязана показывать
 * ровно то число, по которому эмитент будит владельца событием
 * `ourvend.cutover_ready`, — своя семёрка у каждого читателя разойдётся с
 * базой в тот же день, когда владелец подвинет `CUTOVER_GREEN_DAYS` в панели
 * «Система».
 *
 * ПОЛ В ОДИН ДЕНЬ. `readIntSetting` пропускает ноль как осознанное значение,
 * но «ноль зелёных дней» означает разрешение на катовер при пустом журнале —
 * то есть гейт, снятый опиской в настройке. Дробь усекается: день здесь
 * считается целым, «2.5 дня» — описка, а не пожелание.
 */
export async function cutoverThreshold(db: Db, logger?: Logger): Promise<number> {
  const настройка = await readIntSetting(db, "CUTOVER_GREEN_DAYS", CUTOVER_GREEN_DAYS_FALLBACK, logger);
  return Math.max(1, Math.trunc(настройка));
}

/** Допуск сверки остатков, если настройки нет: три штуки (R-FW-P1a). */
export const STOCK_PARITY_TOLERANCE_FALLBACK = 3;

/**
 * ДОПУСК СВЕРКИ ОСТАТКОВ, ШТУК (R-FW-P1a) — почему он вообще есть.
 *
 * Обе стороны сверки остатков — точечные чтения ОДНОГО ЖИВОГО ЭКРАНА кабинета
 * разными агентами: зеркало снимает в 07:50, наш агент — в 08:05. Пятнадцать
 * минут между ними — это рабочее утро автомата: любая продажа в этом окне
 * делала бы «расхождение» из физически верных чисел. Прод-замер: чистые сутки
 * получаются примерно в двух случаях из трёх, то есть без допуска семь зелёных
 * дней подряд не наступили бы почти никогда — и молча.
 *
 * ПОЛ — НОЛЬ, И ЭТО ЗНАЧЕНИЕ, А НЕ МУСОР: `STOCK_PARITY_TOLERANCE=0`
 * означает осознанное «сверять посимвольно», прежнее поведение до этой правки.
 * Дробь усекается: допуск считается в штуках.
 */
export async function stockParityTolerance(db: Db, logger?: Logger): Promise<number> {
  const настройка = await readIntSetting(db, "STOCK_PARITY_TOLERANCE", STOCK_PARITY_TOLERANCE_FALLBACK, logger);
  return Math.max(0, Math.trunc(настройка));
}

/** Порог застоя учётного снапшота, если настройки нет: агент снимает кабинет раз в сутки (08:05). */
export const SNAPSHOT_STALE_HOURS_FALLBACK = 36;

/**
 * Порог застоя УЧЁТНОГО СНАПШОТА, часов — одно число у сторожа и у витрины
 * (R-P8b-5), ровно по той же причине, что и `syncStaleThreshold`.
 *
 * ЭТО ДРУГОЙ ПОРОГ, А НЕ ВТОРОЕ ИМЯ ТОГО ЖЕ. `SYNC_STALE_HOURS` меряет ПРЯМОЙ
 * СБОР (слоты, раз в 3 часа), этот — СУТОЧНЫЙ СЪЁМ КАБИНЕТА агентом
 * `ourvend:accounting` (08:05). Числа расходятся на порядок: шесть часов
 * молчания коллектора — авария, шесть часов без нового снимка кабинета —
 * обычное утро. Один порог на двоих будил бы владельца каждый день до обеда.
 *
 * ПОЛ В ОДИН ЧАС — как у соседа: `readIntSetting` пропускает ноль как
 * осознанное значение, но порог «0 часов» означает тревогу в КАЖДЫЙ прогон
 * крона (48 сообщений в сутки при живом агенте).
 */
export async function snapshotStaleThreshold(db: Db, logger?: Logger): Promise<number> {
  const настройка = await readIntSetting(db, "SNAPSHOT_STALE_HOURS", SNAPSHOT_STALE_HOURS_FALLBACK, logger);
  return Math.max(1, Math.trunc(настройка));
}

/**
 * Свежесть учётного снапшота — ДВЕ ПОЛОВИНЫ ОТДЕЛЬНО (R-FW-P2).
 *
 * `null` в поле — снимков этой половины нет ВОВСЕ.
 */
export interface SnapshotFreshness {
  /** Последний `fetched_at` в `ourvend_sale_snapshot`. */
  sales: Date | null;
  /** Последний `fetched_at` в `ourvend_stock_snapshot`. */
  stock: Date | null;
}

/**
 * Момент последнего съёма учётного снапшота — ПО ОБЕИМ ТАБЛИЦАМ (R-FW-P2).
 *
 * ПОЧЕМУ НЕ ОДНА `ourvend_sale_snapshot`. Агент `ourvend:accounting` шлёт ТРИ
 * отдельных POST-а (продажи двумя пачками, остатки третьей), и половины падают
 * независимо: у Lot-сессии свой `try`. Пока сторож смотрел только на продажи,
 * упавшая Lot-сессия замораживала `machine_stock` при свежих часах — тревоги
 * не было вовсе, а в режиме `own` это остановившийся боевой учёт остатков.
 * Обратная сторона той же монеты: сутки без единой продажи у обеих машин
 * (такие в журнале есть) не двигают `fetched_at` продаж, и один взгляд на
 * продажи дал бы ЛОЖНУЮ тревогу через 36 ч.
 *
 * Двумя запросами «последняя строка», а не `greatest(max(), max())`: и то и
 * другое идёт по индексу, но строку видно целиком, заглушка юнит-теста
 * исполняет ровно тот же путь, что и Postgres (то же правило, что у трёх лагов
 * в отчёте о здоровье), а главное — вердикту нужны обе даты ПО ОТДЕЛЬНОСТИ:
 * тревога обязана назвать, какая именно половина встала.
 */
export async function lastSnapshotAt(db: Db): Promise<SnapshotFreshness> {
  const [продажи] = await db
    .select({ at: ourvendSaleSnapshot.fetchedAt })
    .from(ourvendSaleSnapshot)
    .orderBy(desc(ourvendSaleSnapshot.fetchedAt))
    .limit(1);
  const [остатки] = await db
    .select({ at: ourvendStockSnapshot.fetchedAt })
    .from(ourvendStockSnapshot)
    .orderBy(desc(ourvendStockSnapshot.fetchedAt))
    .limit(1);
  return { sales: продажи?.at ?? null, stock: остатки?.at ?? null };
}

/**
 * ВЕРДИКТ «учётный снапшот встал» — ОДНА функция на трёх читателей: сторож
 * (`SyncStaleService.checkSnapshot`), отчёт (`OurvendHealth.snapshotStale`) и
 * флаг «источник читаем» (`SalesService.summary().configured`).
 *
 * Считает по СЫРЫМ часам (`rawStaleHours`), а не по округлённому `salesLagH`:
 * «35 ч 59 м 49 с» округляются до ровно 36.0, и сравнение по показанному
 * числу сдвинуло бы границу на 11 секунд раньше настоящей — авария 24.08.2026
 * началась ровно на таком сдвиге у соседнего порога.
 *
 * `null` (снимков нет вовсе) — ЗАСТОЙ, а не «ноль часов»: пустая таблица
 * означает, что агент не доехал ни разу, и после флипа учёт стоял бы с нуля.
 */
export function snapshotIsStale(lastFetchedAt: Date | string | null | undefined, now: Date, threshold: number): boolean {
  const at = lastFetchedAt instanceof Date ? lastFetchedAt.toISOString() : (lastFetchedAt ?? null);
  const сырые = rawStaleHours(at, now);
  return сырые === null || сырые >= threshold;
}

/** Как назвать половину снапшота в тексте тревоги и правила. */
export const SNAPSHOT_SIDE_SALES = "продаж";
export const SNAPSHOT_SIDE_STOCK = "остатков";

/**
 * ВЕРДИКТ ПО ОБЕИМ ПОЛОВИНАМ СНАПШОТА (R-FW-P2) — одна функция на трёх
 * читателей: сторож (`SyncStaleService.checkSnapshot`), отчёт
 * (`OurvendHealth.snapshotStale`) и флаг «источник читаем»
 * (`SalesService.summary().configured`).
 *
 * ЗАСТОЙ, ЕСЛИ ВСТАЛА ЛЮБАЯ ИЗ ДВУХ. В режиме `own` продажи кормят `sale`, а
 * остатки — `machine_stock`; молчание любой половины дольше трёх суток
 * останавливает свою таблицу молча, без ошибки и без события. Поэтому «или», а
 * не «и», а `which` называет виновную половину словами: «снапшот не
 * обновлялся» без имени таблицы владелец прочитал бы как поломку служебной
 * записи, а чинить надо конкретного агента.
 *
 * `hours` — возраст ХУДШЕЙ (самой старой) половины, считается по СЫРЫМ часам
 * той же функцией `snapshotIsStale`. `null` — снимков этой половины нет вовсе,
 * и это не ноль часов.
 */
export function snapshotStaleVerdict(
  freshness: SnapshotFreshness,
  now: Date,
  threshold: number,
): {
  stale: boolean;
  /** «продаж», «остатков» или «продаж и остатков». `null` — застоя нет. */
  which: string | null;
  /** Часы худшей (самой старой) половины. `null` — её снимков не было вовсе. */
  hours: number | null;
  /** Момент худшей половины (ISO). `null` — снимков не было вовсе. */
  lastFetchedAt: string | null;
  salesHours: number | null;
  stockHours: number | null;
} {
  const iso = (d: Date | null) => (d ? d.toISOString() : null);
  const продажиСтоят = snapshotIsStale(freshness.sales, now, threshold);
  const остаткиСтоят = snapshotIsStale(freshness.stock, now, threshold);
  const salesHours = rawStaleHours(iso(freshness.sales), now);
  const stockHours = rawStaleHours(iso(freshness.stock), now);

  const which =
    продажиСтоят && остаткиСтоят
      ? `${SNAPSHOT_SIDE_SALES} и ${SNAPSHOT_SIDE_STOCK}`
      : продажиСтоят
        ? SNAPSHOT_SIDE_SALES
        : остаткиСтоят
          ? SNAPSHOT_SIDE_STOCK
          : null;

  // Худшая половина — та, что старше; `null` (снимков не было вовсе) хуже
  // любого числа. Считается ВСЕГДА, а не только при застое: `hours` — это поле
  // ПОКАЗА («сколько уже не приходило»), и обнулять его в тишину значило бы
  // отдавать витрине `null` там, где снимки просто свежие.
  const кандидаты: { hours: number | null; at: string | null }[] = [
    { hours: salesHours, at: iso(freshness.sales) },
    { hours: stockHours, at: iso(freshness.stock) },
  ];
  const худшая =
    кандидаты.find((k) => k.hours === null) ?? [...кандидаты].sort((a, b) => (b.hours ?? 0) - (a.hours ?? 0))[0];

  return {
    stale: which !== null,
    which,
    hours: худшая ? худшая.hours : null,
    lastFetchedAt: худшая ? худшая.at : null,
    salesHours,
    stockHours,
  };
}
