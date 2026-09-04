import { Inject, Injectable, Optional } from "@nestjs/common";
import { and, desc, eq, gte, lte, sql, type SQL } from "drizzle-orm";
import { auditLog, event, machineSlot, vendingRefill, vendingStock } from "@mydon/db";
import { normalizeMachineSerial } from "@mydon/shared";
import { DB, type Db } from "../db/db.module";
import { VendingLedgerService } from "../stock/vending-ledger";
import { VendingService } from "./vending.service";

type RefillRow = typeof vendingRefill.$inferSelect;

export interface CreateRefillInput {
  /** MuMachineID Ourvend — обязателен: по нему живёт зеркало и сверка. */
  machineSerial: string;
  machineId?: string;
  coilId?: string;
  productName: string;
  qty: number;
  personId?: string;
  taskId?: string;
  performedAt?: Date;
  /** Ключ идемпотентности мастера. Одна позиция — один ключ. */
  clientKey: string;
  source?: string;
  note?: string;
  createdBy?: string;
}

export interface CreateRefillResult {
  refill: RefillRow;
  /** Остаток центрального склада по товару ПОСЛЕ списания. */
  stockLeft: number | null;
  /** Запись уже была — повтор мастера, склад второй раз не тронут. */
  duplicate: boolean;
}

/**
 * Заливка снек/дринк-автомата: факт от сотрудника плюс списание со склада.
 *
 * Отдельный сервис, а не метод `VendingService`: тот отвечает за зеркало
 * Ourvend и закуп — данные, которые приезжают снаружи. Здесь наоборот, данные
 * рождаются у нас, и держать два источника истины в одном классе значит рано
 * или поздно перепутать, что чем перезаписывается (WAREHOUSE_SPEC §3.1).
 *
 * Кофейные бункеры сюда не входят: у них свой ключ (точка, позиция 1–8) и вес
 * вместо штук — §3.3 там же.
 */
@Injectable()
export class RefillService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly vending: VendingService,
    /** Проекция `vending_stock` → леджер (У6). В тестах отсутствует — двойной записи нет. */
    @Optional() @Inject(VendingLedgerService) private readonly ledger?: VendingLedgerService,
  ) {}

  /**
   * Записать заливку и списать товар с центрального склада.
   *
   * ИДЕМПОТЕНТНО по `clientKey`. Плохая связь в подвале — норма, и двойное
   * нажатие «Готово» не должно ни задваивать факт, ни списывать склад дважды.
   * Гонку двух одновременных запросов ловит уникальный индекс, а не
   * предварительный SELECT: между проверкой и вставкой успевает пройти
   * второй запрос.
   */
  async create(input: CreateRefillInput): Promise<CreateRefillResult> {
    // Канон имени берём ДО транзакции: каталог читается, а не пишется, и
    // держать транзакцию открытой ради него незачем. Спорное имя (ключ — имя
    // одной карточки и одновременно алиас другой) резолвер отбивает
    // `BadRequestException` ЗДЕСЬ, до единой записи: заливка списывает склад,
    // и списание не с того товара повторный прогон уже не исправит (R-G-1).
    const { name: productName, productId } = await this.vending.resolveProductRef(
      input.productName,
    );
    const performedAt = input.performedAt ?? new Date();

    return this.db.transaction(async (tx) => {
      const [created] = await tx
        .insert(vendingRefill)
        .values({
          machineId: input.machineId ?? null,
          machineSerial: input.machineSerial,
          coilId: input.coilId ?? null,
          productId,
          productName,
          qty: input.qty,
          personId: input.personId ?? null,
          taskId: input.taskId ?? null,
          performedAt,
          clientKey: input.clientKey,
          source: input.source ?? "bot",
          note: input.note ?? null,
          createdBy: input.createdBy ?? "owner",
        })
        .onConflictDoNothing({ target: vendingRefill.clientKey })
        .returning();

      if (!created) {
        // Повтор. Возвращаем ту же запись и НЕ трогаем склад: списание уже
        // прошло в первый раз. Остаток отдаём текущий — сотруднику важно
        // увидеть число, а не узнать, что его нажатие было лишним.
        const [existing] = await tx
          .select()
          .from(vendingRefill)
          .where(eq(vendingRefill.clientKey, input.clientKey))
          .limit(1);
        // Остаток — тем же источником, что и у свежей заливки: в режиме ledger
        // таблица не читается (R-GS-4), без карточки — «неизвестно».
        let stockLeft: number | null = null;
        if (this.ledger && (await this.ledger.source(tx)) === "ledger") {
          const [warehouseId, cardId] = await Promise.all([this.ledger.centralWarehouseId(tx), productId ? this.ledger.cardIdOf(tx, productId) : Promise.resolve(null)]);
          stockLeft = warehouseId && cardId ? await this.ledger.qty(tx, warehouseId, cardId) : null;
        } else {
          const [stock] = await tx
            .select({ quantity: vendingStock.quantity })
            .from(vendingStock)
            .where(eq(vendingStock.productName, productName))
            .limit(1);
          stockLeft = stock?.quantity ?? null;
        }
        return { refill: existing, stockLeft, duplicate: true };
      }

      // Заливка — перемещение «центральный склад → автомат». Если строки
      // склада по товару нет, заводим её сразу в минус: отрицательный остаток
      // это честное «склад не пересчитывали, а товар возят». Запрет означал бы,
      // что техник не сможет отметить заливку, и мы потеряем факт целиком ради
      // красоты числа (WAREHOUSE_SPEC §4.2).
      //
      // countedAt НЕ трогаем у существующей строки: это «когда пересчитали
      // склад», а заливка — не пересчёт. Соврав здесь, мы заставили бы
      // ingestStock() игнорировать настоящую инвентаризацию как «опоздавшую».
      const [stock] = await tx
        .insert(vendingStock)
        .values({
          productName,
          productId,
          quantity: -input.qty,
          countedAt: performedAt,
        })
        .onConflictDoUpdate({
          target: [vendingStock.productName],
          set: {
            quantity: sql`${vendingStock.quantity} - ${input.qty}`,
            updatedAt: new Date(),
          },
        })
        .returning();

      // Двойная запись (У6): то же списание — движением леджера по карточке
      // товара на центральном складе; ключ — заливка, повтор не двоит.
      await this.ledger?.movement(tx, {
        productId,
        productName,
        kind: "consumption",
        qty: input.qty,
        dt: performedAt.toISOString().slice(0, 10),
        note: `заливка автомата ${input.machineSerial}`,
        clientKey: `vending-refill:${created.id}`,
        createdBy: input.createdBy ?? "owner",
      });

      await tx.insert(auditLog).values({
        actorKind: input.personId ? "human" : "system",
        actorRef: input.createdBy ?? "owner",
        action: "vending.refill_created",
        target: created.id,
        after: created,
      });

      // Лента событий (П4). В ТОЙ ЖЕ транзакции: событие снаружи пережило бы
      // откат вставки, и владелец увидел бы заливку, которой в журнале нет.
      // Правило уведомления сюда не заводится намеренно — «Действия» читают
      // таблицу заливок, а будить владельца ночью каждой записью техника
      // значит научить его выключать уведомления целиком.
      await tx.insert(event).values({
        source: input.personId ? "human" : "system",
        type: "vending.refill_recorded",
        payload: {
          // Канон, а не сырое написание: события детектора уже в каноне, и
          // потребитель, ключующийся по serial, иначе увидел бы два автомата
          // вместо одного («c2508160376» и «2508160376»).
          serial: normalizeMachineSerial(created.machineSerial),
          product: productName,
          qty: input.qty,
          personId: input.personId ?? null,
        },
      });

      // После катовера (VENDING_STOCK_SOURCE=ledger) остаток — по леджеру, а не по строке проекции;
      // без карточки/товара/склада — «неизвестно», а не число из тени (R-GS-3): в ledger-режиме
      // таблица вообще не читается для остатка, как и в ветке повтора выше.
      let stockLeft: number | null;
      if (this.ledger && (await this.ledger.source(tx)) === "ledger") {
        const [warehouseId, cardId] = await Promise.all([this.ledger.centralWarehouseId(tx), productId ? this.ledger.cardIdOf(tx, productId) : Promise.resolve(null)]);
        stockLeft = productId && warehouseId && cardId ? await this.ledger.qty(tx, warehouseId, cardId) : null;
      } else {
        stockLeft = stock?.quantity ?? null;
      }
      return { refill: created, stockLeft, duplicate: false };
    });
  }

  /**
   * Товары, стоящие в автомате по зеркалу Ourvend.
   *
   * Зеркало здесь используется по назначению — как подсказка «что тут обычно
   * бывает», а не как источник факта. Пустой ответ (автомата нет в зеркале
   * или сбор выключен) не ошибка: мастер предложит ввести название руками.
   */
  async productsOf(machineSerial: string): Promise<string[]> {
    if (!machineSerial.trim()) return [];
    const rows = await this.db
      .select({ productName: machineSlot.productName })
      .from(machineSlot)
      .where(eq(machineSlot.machineSerial, machineSerial.trim()))
      .limit(200);
    const names = new Set<string>();
    for (const r of rows) if (r.productName?.trim()) names.add(r.productName.trim());
    return [...names].sort((a, b) => a.localeCompare(b, "ru"));
  }

  /** Журнал заливок. Фильтры складываются; без них — последние по времени. */
  async list(filter: {
    machineSerial?: string;
    personId?: string;
    from?: Date;
    to?: Date;
    limit?: number;
  }): Promise<RefillRow[]> {
    const conditions: SQL[] = [];
    if (filter.machineSerial) conditions.push(eq(vendingRefill.machineSerial, filter.machineSerial));
    if (filter.personId) conditions.push(eq(vendingRefill.personId, filter.personId));
    if (filter.from) conditions.push(gte(vendingRefill.performedAt, filter.from));
    if (filter.to) conditions.push(lte(vendingRefill.performedAt, filter.to));

    return this.db
      .select()
      .from(vendingRefill)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(vendingRefill.performedAt))
      .limit(Math.min(filter.limit ?? 200, 1000));
  }
}
