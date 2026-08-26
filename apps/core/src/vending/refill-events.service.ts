import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, desc, eq, gte, isNull, lte } from "drizzle-orm";
import { event, slotSnapshot, vendingRefill, vendingRefillEvent } from "@mydon/db";
import {
  deadMachine,
  detectRefills,
  matchRefill,
  normalizeMachineSerial,
  planogramStatus,
  type HumanRefill,
  type MachineSnapshot,
  type RefillEvent,
} from "@mydon/shared";
import { DB, type Db } from "../db/db.module";
import { readIntSetting } from "../system/settings";
import { VendingService } from "./vending.service";

/** Окно прогона по умолчанию: крон бежит после каждого сбора слотов (раз в 3 ч). */
export const DETECT_DAYS_DEFAULT = 2;
/** Потолок окна: 30 дней снимков — это уже отчёт, а не детектор. */
export const DETECT_DAYS_MAX = 30;
/** Окно журнала по умолчанию. */
export const LIST_DAYS_DEFAULT = 14;
/**
 * Потолок ЧТЕНИЯ журнала — СВОЙ, а не `DETECT_DAYS_MAX`.
 *
 * У детектора 30 суток — это потолок СКАНА СНИМКОВ: четверть миллиона строк в
 * память разом (комментарий внутри `detect`). Чтение журнала — `limit(LIST_LIMIT)`
 * по индексированной `window_to`, и держать его на чужом потолке значит
 * показывать владельцу тридцать суток под кнопкой «90 дн».
 */
export const LIST_DAYS_MAX = 90;
/** Потолок выборки журнала: 6 автоматов × 14 дней дают десятки строк, не тысячи. */
export const LIST_LIMIT = 500;
/** Порог детектора, если настройки нет (донор mydon-stock). */
export const MIN_UNITS_FALLBACK = 10;
/**
 * Допуск сопоставления с записью оператора: снимки идут раз в 3 ч, и человек
 * пишет боту либо перед выездом, либо после — но в пределах того же выезда.
 */
export const MATCH_PAD_MS = 3 * 3_600_000;
/** Событие ленты о заливке без записи оператора (правило брифинга). */
export const REFILL_DETECTED_EVENT = "vending.refill_detected";

/**
 * Почему детектор молчит об автомате. Значения без «прочего»:
 * `dead` — источник отдаёт ёмкости вне диапазона (РЕЗЕРВ: на текущем проде ни
 *   один снимок за всю историю под это не подходит — заглушки SKLAD 5S/6S
 *   отдают пустое имя товара и отсеиваются как `no_slots`, SKLAD 4S — как
 *   `uncalibrated`; ветка ждёт источник, который отдаст товар с мусорной
 *   ёмкостью);
 * `uncalibrated` — ёмкости не откалиброваны, но не поголовно;
 * `no_slots` — в автомате нет назначенных слотов;
 * `not_in_service` — автомат не в строю по реестру (склад, ремонт).
 * Чинятся они в разных местах, поэтому строкой-катчоллом их сводить нельзя.
 */
export type SkipReason = "dead" | "uncalibrated" | "no_slots" | "not_in_service";

export interface DetectResult {
  /** Автоматы, по которым снимки что-то говорят (без пропущенных). */
  machines: number;
  /** Новых событий записано (повтор прогона даёт 0). */
  events: number;
  /** Сопоставлено с записью оператора в этом прогоне: новые + доклеенные к старым. */
  matched: number;
  /** Автоматы, по которым детектор молчит, и почему (R-P4-4). */
  skipped: { serial: string; reason: SkipReason }[];
}

export interface RefillEventRow {
  id: string;
  serial: string;
  name: string;
  windowFrom: string;
  windowTo: string;
  units: number;
  slots: { coilId: string; product: string; before: number; after: number; delta: number }[];
  matchedRefillId: string | null;
}

/** Ключ идемпотентности события: тот же, что уникальный индекс в базе. */
const ключ = (serial: string, windowTo: Date): string => `${normalizeMachineSerial(serial)}|${windowTo.getTime()}`;

/**
 * Детектор заливок по снимкам слотов (П4, R-P4-2).
 *
 * ЗАЧЕМ. `vending_refill` — 0 строк за всю историю: мастер «Заполнил автомат»
 * в боте люди просто не открывают. При этом `slot_snapshot` пишется каждые 3 ч
 * без пропусков, и «Σ положительных дельт ≥ порога» ловит приход чисто (6
 * событий / 430 ед. за 14 дней на живых данных, вне событий — ровно 0).
 * Поэтому здесь ЗАЛИВКА — ЭТО ФАКТ СНИМКА, а запись оператора — уточнение
 * (`matched_refill_id`), а не источник.
 *
 * ЧЕГО ЭТОТ СЕРВИС НЕ ДЕЛАЕТ: не трогает склад. Детектор видит, что товар
 * появился в автомате, но не знает, откуда он приехал — из закупа или со
 * склада, — и списание по догадке разошлось бы с остатком навсегда. Склад
 * списывает только человеческая запись (`RefillService.create`).
 *
 * Отдельный сервис, а не метод `VendingService`: тот отвечает за зеркало
 * Ourvend и закуп, здесь же — вывод из истории зеркала.
 */
@Injectable()
export class RefillEventsService {
  private readonly logger = new Logger(RefillEventsService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly vending: VendingService,
  ) {}

  /**
   * Прогон детектора по снимкам за `days` суток.
   *
   * ИДЕМПОТЕНТЕН по (серийник, конец окна): крон бежит по ПЕРЕКРЫВАЮЩЕМУСЯ
   * окну (2 дня каждые 3 ч), и без уникального ключа каждая заливка попала бы
   * в журнал шестнадцать раз. Единственное, что повторный прогон меняет у уже
   * записанного события, — доклеивает запись оператора, если она появилась
   * после первого прохода (человек дошёл до бота через час).
   */
  async detect(days = DETECT_DAYS_DEFAULT): Promise<DetectResult> {
    const окно = зажать(days, DETECT_DAYS_DEFAULT, DETECT_DAYS_MAX);
    const сейчас = new Date();
    const от = new Date(сейчас.getTime() - окно * 86_400_000);

    const [серии, canonOf, minUnits, реестрМашин] = await Promise.all([
      // Сначала — только СПИСОК автоматов, попавших в окно. Одним запросом на
      // весь парк снимки читать нельзя: при потолке окна в 30 суток это
      // четверть миллиона строк в память разом. Индекс
      // `slot_snapshot_machine_captured_idx` (machine_serial, captured_at)
      // обслуживает и эту выборку, и разбор по автомату ниже.
      this.db
        .select({ serial: slotSnapshot.machineSerial })
        .from(slotSnapshot)
        .where(gte(slotSnapshot.capturedAt, от))
        .groupBy(slotSnapshot.machineSerial),
      // Карта алиасов читается ОДИН раз на прогон: имён в снимках тысячи, и
      // поход в базу на каждое превратил бы детектор в N+1.
      this.vending.canonResolver(),
      this.minUnits(),
      this.vending.machineRegistry(),
    ]);

    // Серийники сводим к канону ДО чтения снимков — тот же приём, что в отчёте
    // об усушке: «c2508160376» и «2508160376» это один автомат, и раньше две
    // формы дали бы два независимых разбора и два события на одно окно
    // (уникальный индекс стоит на КОЛОНКЕ, а ключ идемпотентности считался по
    // канону — база их не схлопнула бы).
    const формыКанона = new Map<string, string[]>();
    for (const { serial } of серии) {
      const canon = normalizeMachineSerial(serial);
      формыКанона.set(canon, [...(формыКанона.get(canon) ?? []), serial]);
    }

    // Дальше — автомат за автоматом, ОДИН ЗАПРОС НА ФОРМУ СЕРИЙНИКА. Это
    // осознанный N+1: при парке ≤ ~30 машин (сегодня 26) три десятка индексных
    // выборок дешевле, чем пик памяти от четверти миллиона строк одним
    // ответом. Когда машин станут сотни — переходить на батчи по 10–20
    // серийников через `inArray`, а не обратно на «весь парк разом».
    const skipped: DetectResult["skipped"] = [];
    const события: RefillEvent[] = [];
    let machines = 0;

    for (const [canon, формы] of формыКанона) {
      // Автомат не в строю детектору не интересен: у склада-«автомата» и
      // машины в ремонте приход по снимкам — не заливка маршрута, а разбор
      // склада, и каждые три часа он писал бы владельцу «причины» про SKLAD.
      if (реестрМашин.notInService.has(canon)) {
        skipped.push({ serial: canon, reason: "not_in_service" });
        continue;
      }

      const поМоменту = new Map<number, MachineSnapshot>();
      for (const форма of формы) {
        const строки = await this.db
          .select({
            coilId: slotSnapshot.coilId,
            productName: slotSnapshot.productName,
            capacity: slotSnapshot.capacity,
            quantity: slotSnapshot.quantity,
            capturedAt: slotSnapshot.capturedAt,
          })
          .from(slotSnapshot)
          .where(and(eq(slotSnapshot.machineSerial, форма), gte(slotSnapshot.capturedAt, от)));

        // Снимок = момент съёма: строки `slot_snapshot` лежат по слоту.
        for (const r of строки) {
          const t = r.capturedAt.getTime();
          let snap = поМоменту.get(t);
          if (!snap) {
            snap = { serial: canon, capturedAt: r.capturedAt, slots: [] };
            поМоменту.set(t, snap);
          }
          const имя = r.productName?.trim();
          snap.slots.push({
            coilId: r.coilId,
            // Канон ДО сравнения: один и тот же товар приезжает из Ourvend под
            // разными именами, и без канона смена написания выглядела бы как
            // смена товара в слоте — дельта потерялась бы целиком.
            product: имя ? canonOf(имя) : null,
            capacity: r.capacity,
            quantity: r.quantity,
          });
        }
      }
      const список = [...поМоменту.values()];
      if (список.length === 0) continue;

      // Нечитаемые — вон до расчёта (R-P4-4). Автомат-заглушка и автомат с
      // нечитаемой планограммой одинаково не дают детектору сказать ничего, но
      // причины разные, и владельцу нужна именно причина: «источник врёт» и
      // «слоты не откалиброваны» чинятся в разных местах. На текущем проде
      // срабатывают `no_slots` и `uncalibrated`; `dead` — резерв, см. `SkipReason`.
      const причина = skipReasonOf(список);
      if (причина) {
        skipped.push({ serial: canon, reason: причина });
        continue;
      }
      machines += 1;
      события.push(...detectRefills(список, minUnits));
    }
    skipped.sort((a, b) => a.serial.localeCompare(b.serial, "ru"));

    const итог = await this.записать(события, от, machines, skipped);
    // Лента — ОТДЕЛЬНЫМ проходом и по всему окну, а не по событиям этого
    // прогона (см. `опубликоватьНесопоставленные`).
    await this.опубликоватьНесопоставленные(от, сейчас, реестрМашин.nameBySerial);
    return итог;
  }

  /**
   * Запись событий детектора в журнал: новые вставляются, к старым доклеивается
   * запись оператора, если она появилась после первого прохода.
   */
  private async записать(
    события: RefillEvent[],
    от: Date,
    machines: number,
    skipped: DetectResult["skipped"],
  ): Promise<DetectResult> {
    if (события.length === 0) return { machines, events: 0, matched: 0, skipped };

    const [записи, ужеЕсть, реестр] = await Promise.all([
      this.db
        .select({ id: vendingRefill.id, machineSerial: vendingRefill.machineSerial, performedAt: vendingRefill.performedAt, qty: vendingRefill.qty })
        .from(vendingRefill)
        // Запись могла быть сделана до начала окна снимков — на ширину допуска.
        .where(gte(vendingRefill.performedAt, new Date(от.getTime() - MATCH_PAD_MS))),
      // Шире окна снимков РОВНО на допуск сопоставления: запись оператора
      // ищется с `от − 3ч`, и событие чуть старше `от`, к которому она уже
      // приклеена, обязано попасть в «занятые». Иначе та же запись подтвердит
      // второе, новое окно — двойная отметка в отчёте.
      this.db.select().from(vendingRefillEvent).where(gte(vendingRefillEvent.windowTo, new Date(от.getTime() - MATCH_PAD_MS))),
      this.vending.machineIndex(),
    ]);

    // Серийники с обеих сторон — в канон: бот пишет «c2508160376», Ourvend
    // присылает «2508160376», и сравнение как есть не сопоставило бы НИЧЕГО.
    const люди: HumanRefill[] = записи.map((r) => ({
      id: r.id,
      serial: normalizeMachineSerial(r.machineSerial),
      performedAt: r.performedAt,
      qty: r.qty,
    }));
    const старые = new Map(ужеЕсть.map((r) => [ключ(r.machineSerial, r.windowTo), r]));
    // Одна запись оператора — одно событие. Заливка на границе снимков попадает
    // в ДВА соседних окна (докладывал в 03:50, снимки в 04:00 и 07:00), и без
    // этого множества обе строки отчёта показали бы «подтверждено» по одному и
    // тому же выезду. Занятые прошлыми прогонами берём из журнала.
    const занятые = new Set(ужеЕсть.map((r) => r.matchedRefillId).filter((id): id is string => id !== null));
    const свободные = (): HumanRefill[] => люди.filter((r) => !занятые.has(r.id));

    let записано = 0;
    let matched = 0;
    await this.db.transaction(async (tx) => {
      for (const ev of события) {
        const canon = normalizeMachineSerial(ev.serial);
        const человек = matchRefill({ ...ev, serial: canon }, свободные(), MATCH_PAD_MS);
        const было = старые.get(ключ(ev.serial, ev.windowTo));

        if (было) {
          // Событие уже в журнале. Переписывать дельты нечем — снимки те же;
          // измениться могло только одно: появилась запись оператора.
          if (было.matchedRefillId === null && человек) {
            await tx
              .update(vendingRefillEvent)
              .set({ matchedRefillId: человек.id })
              .where(eq(vendingRefillEvent.id, было.id));
            занятые.add(человек.id);
            matched += 1;
          }
          continue;
        }

        const [созданное] = await tx
          .insert(vendingRefillEvent)
          .values({
            // Серийник в журнале — КАНОН. Уникальный индекс стоит на колонке,
            // а ключ идемпотентности здесь считается по канону: запиши мы
            // сырую форму, «c2508160376» и «2508160376» дали бы две строки на
            // одно окно, и база бы их не поймала.
            machineSerial: canon,
            machineId: реестр.idBySerial.get(canon) ?? null,
            windowFrom: ev.windowFrom,
            windowTo: ev.windowTo,
            units: ev.units,
            slots: ev.slots,
            matchedRefillId: человек?.id ?? null,
          })
          // Гонка двух прогонов (крон и ручной запуск) ловится уникальным
          // индексом, а не предварительным SELECT: между чтением `старые` и
          // вставкой успевает пройти второй прогон.
          .onConflictDoNothing({ target: [vendingRefillEvent.machineSerial, vendingRefillEvent.windowTo] })
          .returning();
        if (!созданное) continue;

        записано += 1;
        if (человек) {
          занятые.add(человек.id);
          matched += 1;
        }
      }
    });

    return { machines, events: записано, matched, skipped };
  }

  /**
   * Лента `vending.refill_detected` — ОТДЕЛЬНЫМ проходом по несопоставленным
   * окнам старше допуска сопоставления (R-FW-9).
   *
   * ЗАЧЕМ ТАК. Правило брифинга по этому событию говорит «заливка без записи —
   * оформи в боте», а ack брифинга необратим. Детектор бежит после каждого
   * сбора слотов (раз в 3 ч), и техник, дописывающий позицию в подвале уже
   * после прогона, будил владельца зря: `matched_refill_id` доклеивался к
   * событию журнала, а строка ленты с `recorded:false` оставалась навсегда.
   * Публикуя окна старше `MATCH_PAD_MS`, мы утверждаем ФАКТ («записи так и не
   * появилось»), а не результат гонки.
   *
   * Дедуп — по `payload.eventId` (это `vending_refill_event.id`): второй
   * прогон по тому же окну не должен дать вторую строку ленты. Пара
   * `(serial, windowTo)` держится как запасной ключ для событий, написанных до
   * появления `eventId`.
   */
  private async опубликоватьНесопоставленные(от: Date, сейчас: Date, имена: Map<string, string>): Promise<number> {
    const порог = new Date(сейчас.getTime() - MATCH_PAD_MS);
    const кандидаты = await this.db
      .select()
      .from(vendingRefillEvent)
      .where(
        and(
          gte(vendingRefillEvent.windowTo, от),
          lte(vendingRefillEvent.windowTo, порог),
          isNull(vendingRefillEvent.matchedRefillId),
        ),
      );
    if (кандидаты.length === 0) return 0;

    // Лента пишется НЕ РАНЬШЕ конца окна, поэтому за границу `от` заглядывать
    // незачем: событие про окно из этого диапазона не могло быть написано до него.
    const написанные = await this.db
      .select({ payload: event.payload })
      .from(event)
      .where(and(eq(event.type, REFILL_DETECTED_EVENT), gte(event.occurredAt, от)));
    const занято = new Set<string>();
    for (const e of написанные) {
      const p = (e.payload ?? {}) as Record<string, unknown>;
      if (p.eventId !== undefined) занято.add(String(p.eventId));
      if (p.serial !== undefined && p.windowTo !== undefined) занято.add(`${String(p.serial)}|${String(p.windowTo)}`);
    }

    const строки = кандидаты
      .filter((r) => {
        const canon = normalizeMachineSerial(r.machineSerial);
        return !занято.has(r.id) && !занято.has(`${canon}|${r.windowTo.toISOString()}`);
      })
      .map((r) => {
        const canon = normalizeMachineSerial(r.machineSerial);
        return {
          source: "system",
          type: REFILL_DETECTED_EVENT,
          payload: {
            eventId: r.id,
            serial: canon,
            name: имена.get(canon) ?? canon,
            units: r.units,
            windowTo: r.windowTo.toISOString(),
            // `recorded:false` — заливка, которую видел детектор, а мастер так
            // и не отчитался за отведённые три часа. Это строка отчёта, а не
            // алерт: факт мы всё равно знаем.
            recorded: false,
          },
        };
      });
    if (строки.length === 0) return 0;
    await this.db.insert(event).values(строки);
    return строки.length;
  }

  /**
   * Журнал событий детектора за `days` суток, свежие сверху.
   *
   * `now` — параметр, а не `Date.now()` внутри: тест границы окна обязан
   * задавать момент явно, иначе «90 суток назад от когда» плавает вместе с
   * временем прогона теста.
   */
  async list(days = LIST_DAYS_DEFAULT, now = new Date()): Promise<RefillEventRow[]> {
    const окно = зажать(days, LIST_DAYS_DEFAULT, LIST_DAYS_MAX);
    const от = new Date(now.getTime() - окно * 86_400_000);
    const [строки, реестр] = await Promise.all([
      this.db
        .select()
        .from(vendingRefillEvent)
        .where(gte(vendingRefillEvent.windowTo, от))
        .orderBy(desc(vendingRefillEvent.windowTo))
        .limit(LIST_LIMIT),
      this.vending.machineIndex(),
    ]);
    return строки.map((r) => ({
      id: r.id,
      // Канон и на выдаче: строки, записанные до R-FW-10, лежат в сырой форме,
      // а отчёт об усушке и панель ключуются каноном — разнобой в одном списке
      // читался бы как два разных автомата.
      serial: normalizeMachineSerial(r.machineSerial),
      name: реестр.nameBySerial.get(normalizeMachineSerial(r.machineSerial)) ?? r.machineSerial,
      windowFrom: r.windowFrom.toISOString(),
      windowTo: r.windowTo.toISOString(),
      units: r.units,
      slots: r.slots,
      matchedRefillId: r.matchedRefillId,
    }));
  }

  /**
   * Порог детектора: база важнее env, env важнее дефолта (общий резолвер
   * настроек), а непрочитанное значение уходит в лог предупреждением — молча
   * считать по дефолту значит скрыть от владельца, что его правка не сработала.
   */
  private minUnits(): Promise<number> {
    return readIntSetting(this.db, "REFILL_DETECT_MIN_UNITS", MIN_UNITS_FALLBACK, this.logger);
  }
}

/**
 * Почему источник молчит об автомате — или `null`, если сказать ему есть что.
 *
 * Если хоть один снимок окна читается, автомат живой: один «плохой» съём —
 * это сбой выгрузки, а не приговор, и выбрасывать из-за него сутки данных
 * нельзя. Если не читается ни один — причину берём по САМОМУ СВЕЖЕМУ снимку:
 * это текущее состояние аппарата, а не смесь состояний за двое суток.
 *
 * Публично: тот же вопрос задаёт отчёт об усушке (П4), и вторая реализация
 * рано или поздно разошлась бы с этой — детектор считал бы автомат живым, а
 * усушка мёртвым, и владелец получал бы два отчёта об одном аппарате с
 * противоположными выводами.
 */
export function skipReasonOf(снимки: MachineSnapshot[]): SkipReason | null {
  if (снимки.some((s) => planogramStatus(s.slots) === "ok")) return null;
  const свежий = снимки.reduce((a, b) => (b.capturedAt > a.capturedAt ? b : a));
  if (deadMachine(свежий.slots)) return "dead";
  if (planogramStatus(свежий.slots) === "no_slots") return "no_slots";
  return "uncalibrated";
}

function зажать(days: number, дефолт: number, потолок: number): number {
  const n = Math.trunc(days);
  if (!Number.isFinite(n) || n <= 0) return дефолт;
  return Math.min(n, потолок);
}
