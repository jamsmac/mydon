import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, gte, lte, sql, type SQL } from "drizzle-orm";
import { auditLog, vendingRefill, vendingStock } from "@mydon/db";
import { DB, type Db } from "../db/db.module";
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
    // Канон имени берём ДО транзакции: справочник и алиасы читаются, а не
    // пишутся, и держать транзакцию открытой ради них незачем.
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
        const [stock] = await tx
          .select({ quantity: vendingStock.quantity })
          .from(vendingStock)
          .where(eq(vendingStock.productName, productName))
          .limit(1);
        return { refill: existing, stockLeft: stock?.quantity ?? null, duplicate: true };
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

      await tx.insert(auditLog).values({
        actorKind: input.personId ? "human" : "system",
        actorRef: input.createdBy ?? "owner",
        action: "vending.refill_created",
        target: created.id,
        after: created,
      });

      return { refill: created, stockLeft: stock?.quantity ?? null, duplicate: false };
    });
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
