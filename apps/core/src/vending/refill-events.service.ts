import { Inject, Injectable } from "@nestjs/common";
import { desc, eq, gte } from "drizzle-orm";
import { event, slotSnapshot, systemConfig, vendingRefill, vendingRefillEvent } from "@mydon/db";
import {
  deadMachine,
  detectRefills,
  matchRefill,
  normalizeMachineSerial,
  planogramStatus,
  type HumanRefill,
  type MachineSnapshot,
} from "@mydon/shared";
import { DB, type Db } from "../db/db.module";
import { resolveEffective, specFor } from "../system/config-spec";
import { VendingService } from "./vending.service";

/** Окно прогона по умолчанию: крон бежит после каждого сбора слотов (раз в 3 ч). */
export const DETECT_DAYS_DEFAULT = 2;
/** Потолок окна: 30 дней снимков — это уже отчёт, а не детектор. */
export const DETECT_DAYS_MAX = 30;
/** Окно журнала по умолчанию. */
export const LIST_DAYS_DEFAULT = 14;
/** Потолок выборки журнала: 6 автоматов × 14 дней дают десятки строк, не тысячи. */
export const LIST_LIMIT = 500;
/** Порог детектора, если настройки нет (донор mydon-stock). */
export const MIN_UNITS_FALLBACK = 10;
/**
 * Допуск сопоставления с записью оператора: снимки идут раз в 3 ч, и человек
 * пишет боту либо перед выездом, либо после — но в пределах того же выезда.
 */
export const MATCH_PAD_MS = 3 * 3_600_000;

export interface DetectResult {
  /** Автоматы, о которых снимки что-то говорят (без мёртвых). */
  machines: number;
  /** Пар соседних снимков, рассмотренных детектором. */
  windows: number;
  /** Новых событий записано (повтор прогона даёт 0). */
  events: number;
  /** Сопоставлено с записью оператора в этом прогоне: новые + доклеенные к старым. */
  matched: number;
  /** Автоматы без данных: все слоты полны либо планограмма не читается (R-P4-4). */
  skippedDead: string[];
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
    const от = new Date(Date.now() - окно * 86_400_000);

    const [снимки, canonOf, minUnits] = await Promise.all([
      this.db.select().from(slotSnapshot).where(gte(slotSnapshot.capturedAt, от)),
      // Карта алиасов читается ОДИН раз на прогон: имён в снимках тысячи, и
      // поход в базу на каждое превратил бы детектор в N+1.
      this.vending.canonResolver(),
      this.minUnits(),
    ]);

    // Снимок = (автомат, момент съёма): строки `slot_snapshot` лежат по слоту.
    const поМоменту = new Map<string, MachineSnapshot>();
    for (const r of снимки) {
      const k = `${r.machineSerial}|${r.capturedAt.getTime()}`;
      let snap = поМоменту.get(k);
      if (!snap) {
        snap = { serial: r.machineSerial, capturedAt: r.capturedAt, slots: [] };
        поМоменту.set(k, snap);
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

    const поАвтомату = new Map<string, MachineSnapshot[]>();
    for (const snap of поМоменту.values()) {
      поАвтомату.set(snap.serial, [...(поАвтомату.get(snap.serial) ?? []), snap]);
    }

    // Мёртвые — вон до расчёта (R-P4-4). «Все слоты полны во всех снимках» и
    // «планограмма не читается» — это одно и то же «данных с автомата нет»:
    // SKLAD 4S/5S/6S отдают quantity = capacity = 199 по всем пружинам, и
    // такой автомат не должен ни давать событий, ни молча исчезать из итога.
    const skippedDead: string[] = [];
    const живые: MachineSnapshot[] = [];
    let windows = 0;
    let machines = 0;
    for (const [serial, список] of поАвтомату) {
      if (список.every((s) => нетДанных(s))) {
        skippedDead.push(serial);
        continue;
      }
      machines += 1;
      windows += Math.max(0, список.length - 1);
      живые.push(...список);
    }
    skippedDead.sort((a, b) => a.localeCompare(b, "ru"));

    const события = detectRefills(живые, minUnits);
    if (события.length === 0) return { machines, windows, events: 0, matched: 0, skippedDead };

    const [записи, ужеЕсть, реестр] = await Promise.all([
      this.db
        .select({ id: vendingRefill.id, machineSerial: vendingRefill.machineSerial, performedAt: vendingRefill.performedAt, qty: vendingRefill.qty })
        .from(vendingRefill)
        // Запись могла быть сделана до начала окна снимков — на ширину допуска.
        .where(gte(vendingRefill.performedAt, new Date(от.getTime() - MATCH_PAD_MS))),
      this.db.select().from(vendingRefillEvent).where(gte(vendingRefillEvent.windowTo, от)),
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
            machineSerial: ev.serial,
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
        await tx.insert(event).values({
          source: "system",
          type: "vending.refill_detected",
          payload: {
            serial: canon,
            name: реестр.nameBySerial.get(canon) ?? canon,
            units: ev.units,
            windowTo: ev.windowTo.toISOString(),
            // `recorded:false` — заливка, которую видел детектор, а мастер не
            // отчитался. Это строка отчёта, а не алерт: факт мы всё равно знаем.
            recorded: человек !== null,
          },
        });
      }
    });

    return { machines, windows, events: записано, matched, skippedDead };
  }

  /** Журнал событий детектора за `days` суток, свежие сверху. */
  async list(days = LIST_DAYS_DEFAULT): Promise<RefillEventRow[]> {
    const окно = зажать(days, LIST_DAYS_DEFAULT, DETECT_DAYS_MAX);
    const от = new Date(Date.now() - окно * 86_400_000);
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
      serial: r.machineSerial,
      name: реестр.nameBySerial.get(normalizeMachineSerial(r.machineSerial)) ?? r.machineSerial,
      windowFrom: r.windowFrom.toISOString(),
      windowTo: r.windowTo.toISOString(),
      units: r.units,
      slots: r.slots,
      matchedRefillId: r.matchedRefillId,
    }));
  }

  /**
   * Порог детектора: база важнее env, env важнее дефолта — тот же резолвер,
   * что у панели настроек, чтобы правка владельца работала сразу.
   */
  private async minUnits(): Promise<number> {
    const spec = specFor("REFILL_DETECT_MIN_UNITS");
    if (!spec) return MIN_UNITS_FALLBACK;
    const rows = await this.db.select().from(systemConfig);
    const map: Record<string, string> = {};
    for (const r of rows) map[r.key] = r.value;
    const n = Number(resolveEffective(spec, map, process.env).value.replace(",", "."));
    // Ноль и мусор — не «ловить всё подряд»: одна проданная и возвращённая
    // банка стала бы «заливкой» на каждом автомате каждые три часа.
    return Number.isFinite(n) && n > 0 ? n : MIN_UNITS_FALLBACK;
  }
}

/** Снимок, по которому детектор не может сказать ничего (см. `skippedDead`). */
function нетДанных(snap: MachineSnapshot): boolean {
  return planogramStatus(snap.slots) !== "ok" || deadMachine(snap.slots);
}

function зажать(days: number, дефолт: number, потолок: number): number {
  const n = Math.trunc(days);
  if (!Number.isFinite(n) || n <= 0) return дефолт;
  return Math.min(n, потолок);
}
