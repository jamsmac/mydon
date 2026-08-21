import { Inject, Injectable, Logger, NotFoundException, OnModuleInit } from "@nestjs/common";
import { BadRequestException } from "@nestjs/common";
import { entity, person, purchase, rawLink, sale, stockBatch, stockMovement } from "@mydon/db";
import {
  TZ,
  allocateFEFO,
  consumptionReport,
  convertQty,
  DEFAULT_EXPIRING_DAYS,
  effectiveExpiry,
  expiryFlag,
  FLAG_ORDER,
  isUnit,
  matchContractorByName,
  normalizeSourceKey,
  parseRecipe,
  planPurchaseIntake,
  productKind,
  recipeCost,
  stockBalance,
  strictNumber,
  type ContractorRef,
  type ExpiryFlag,
  type FefoBatch,
  type IngredientPrice,
  type PurchaseInput,
  type RecipeLine,
  type ResolvedIngredient,
  type SoldProduct,
  type StockMovement,
  type Unit,
} from "@mydon/shared";
import { Cron } from "croner";
import { and, desc, eq, gte, inArray, lte, or, sql } from "drizzle-orm";
import { DB, type Db } from "../db/db.module";

function isExpiryFlag(v: string): v is ExpiryFlag {
  return v === "expired" || v === "expiring" || v === "ok" || v === "none";
}

/**
 * Сегодняшняя дата ПО ТАШКЕНТУ, а не по UTC.
 *
 * `new Date().toISOString()` даёт день по Гринвичу: с полуночи до пяти утра по
 * Ташкенту это ВЧЕРА. Приход, заведённый ночной сменой, получал бы вчерашнюю
 * дату, а срок годности — на сутки короче. Правило проекта — Asia/Tashkent
 * везде; `en-CA` даёт ровно формат YYYY-MM-DD.
 */
function todayTashkent(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: TZ });
}

/** Строка партии для списков/отчёта: остаток и срок уже посчитаны. */
export interface BatchRow {
  id: string;
  ingredientId: string;
  ingredientName: string;
  warehouseId: string;
  warehouseName: string;
  batchCode: string | null;
  receivedOn: string;
  qtyReceived: number;
  unit: string;
  /** Остаток партии = qtyReceived минус сумма расходных (consumption) движений с этим batchId. Леджер, не поле. */
  remaining: number;
  /** Эффективный срок годности (ISO-дата) или null — ни даты, ни норматива карточки нет. */
  expiry: string | null;
  flag: ExpiryFlag;
  opened: boolean;
  openedOn: string | null;
  supplierId: string | null;
  supplierName: string | null;
  /**
   * Имя поставщика, как его ввёл человек, — даже если карточка не нашлась.
   *
   * Без него «поставщика не вводили» и «ввели, но имя не совпало с реестром»
   * выглядят на экране одинаково: пустое место. Первое — норма, второе —
   * опечатка, которую надо поправить; молча копить такие расхождения значит
   * терять историю закупок по этому поставщику.
   */
  supplierRaw: string | null;
  invoiceNo: string | null;
  invoiceDate: string | null;
  /**
   * Цена за единицу с НДС (карточка ингредиента/контрагента, срез D, Task 5) —
   * то, что ввели в приходе (ручном или импорте реестра). null — цену не
   * вводили; отличать от 0, который выглядел бы как «бесплатно».
   */
  unitPriceGross: number | null;
  note: string | null;
  source: string;
}

/** Строка отчёта о сроках: партия плюс её место в очереди FEFO. */
export interface ExpiryRow extends BatchRow {
  /** Порядковый номер, каким партия уйдёт следующей по FEFO среди партий того же ингредиента и склада. null — остаток исчерпан. */
  fefoOrder: number | null;
}

/** Сортировка партий/отчёта: сначала просроченное (FLAG_ORDER), затем ближе срок, затем новее приход. */
function compareBatchRow(a: BatchRow, b: BatchRow): number {
  const fo = FLAG_ORDER[a.flag] - FLAG_ORDER[b.flag];
  if (fo !== 0) return fo;
  const ea = a.expiry ? new Date(a.expiry).getTime() : Infinity;
  const eb = b.expiry ? new Date(b.expiry).getTime() : Infinity;
  if (ea !== eb) return ea - eb;
  return b.receivedOn.localeCompare(a.receivedOn);
}

/** Заявка на новую партию прихода: карточка §4.3 плюс документ Р3/Р4. */
export interface CreateBatchInput {
  ingredientId: string;
  warehouseId: string;
  qtyReceived: number;
  unit: string;
  receivedOn?: string | null;
  batchCode?: string | null;
  expiryDate?: string | null;
  manufactureDate?: string | null;
  personId?: string | null;
  /** Имя поставщика как в карточке — разрешается в supplierId через matchContractorByName (R-C4). */
  supplier?: string | null;
  invoiceNo?: string | null;
  invoiceDate?: string | null;
  ikpu?: string | null;
  unitPriceNet?: number | null;
  vatRate?: number | null;
  unitPriceGross?: number | null;
  note?: string | null;
  source?: string | null;
  extId?: string | null;
  createdBy?: string | null;
  /** Ключ идемпотентности связанного движения прихода — тот же приём, что у createMovement. */
  clientKey?: string | null;
  /**
   * Дата инвентаризации, до которой партия считается израсходованной (R-D1,
   * срез D). Задан — вместе с приходом пишется расходное (`consumption`)
   * движение того же объёма с этим же `batchId` и датой `closeOn`: партия
   * закрывается, остаток ингредиента не двоится историческим импортом.
   * Не задан — партия остаётся открытой, обычный приход (поведение не
   * меняется для всех существующих вызовов).
   */
  closeOn?: string | null;
}

/**
 * Одна строка массового импорта партий (срез D, задача 3): вход для
 * `POST /stock/batches/import`. Сопоставление карточки — забота витрины
 * (Task 2 `suggestCard`), сюда приходит уже готовый `ingredientId` либо
 * `null` (строка не сопоставлена).
 */
export interface ImportBatchItem {
  /** Номер строки в исходном файле — для отчёта владельцу и (по умолчанию) ключа идемпотентности. */
  fileRow: number;
  /** Карточка сырья, подтверждённая на витрине; отсутствует/`null` — не сопоставлена, строка уходит в `unmatched`. */
  ingredientId?: string | null;
  warehouseId: string;
  qtyReceived: number;
  unit: string;
  /** Дата прихода (R-D3); отсутствует/`null` — строка уходит в `noDate`, партия не создаётся. */
  receivedOn?: string | null;
  supplier?: string | null;
  invoiceNo?: string | null;
  invoiceDate?: string | null;
  unitPriceGross?: number | null;
  note?: string | null;
  /** Имя строки — только для отчёта (noDate/unmatched/rejected), не сохраняется. */
  name?: string | null;
  /** Ключ идемпотентности строки в паре с `source`; по умолчанию — `String(fileRow)`. */
  extId?: string | null;
}

/** Строка отчёта импорта без записи (без даты / не сопоставлена). */
export interface ImportBatchIssue {
  fileRow: number;
  name: string | null;
}

/** Строка отчёта импорта, отклонённая с причиной (R-D2 и другие ошибки валидации). */
export interface ImportBatchRejection extends ImportBatchIssue {
  reason: string;
}

/** Отчёт массового импорта — одинаковый и в `dryRun`, и в настоящем прогоне (R-D7). */
export interface ImportBatchesReport {
  dryRun: boolean;
  created: number;
  /**
   * Сколько партий закрыто расходом (R-D1) и на какую дату.
   *
   * В отчёте отдельными полями, а не «подразумевается»: закрытие можно выключить
   * одним пустым полем даты, и без этих двух чисел прогон без закрытия выглядел
   * бы ровно так же, как правильный, — а остаток при этом задвоился бы.
   * `closed: 0` при `created > 0` означает «партии открыты», и это видно сразу.
   */
  closed: number;
  closeOn: string | null;
  /** Пропущено как повтор — партия с этим (source, extId) уже существует. */
  skippedRepeat: number;
  noDate: ImportBatchIssue[];
  unmatched: ImportBatchIssue[];
  rejected: ImportBatchRejection[];
}

/** Заявка на движение склада. */
export interface CreateMovementInput {
  kind: "intake" | "consumption" | "transfer";
  ingredientId: string;
  warehouseId: string;
  counterpartyId?: string | null;
  dt?: string;
  qty: number;
  unit: string;
  unitPrice?: number | null;
  supplier?: string | null;
  note?: string | null;
  createdBy?: string | null;
  /** Ключ идемпотентности от клиента (бот): повтор несёт то же значение. */
  clientKey?: string | null;
  /**
   * Партия, к которой относится движение. НЕ часть публичного контракта
   * `POST /stock/movement` (контроллер это поле не принимает и не может
   * задать) — заполняется только сервисом партий (createBatch) при создании
   * приходного движения вместе с новой партией.
   */
  batchId?: string | null;
}

/** Пересчёт: сколько по факту насчитали ингредиента на складе. */
export interface StocktakeInput {
  warehouseId: string;
  ingredientId: string;
  /** Фактическое количество по пересчёту, ≥ 0. */
  actual: number;
  /** Единица пересчёта; пусто — считаем в базовой единице ингредиента. */
  unit?: string | null;
  note?: string | null;
  countedBy?: string | null;
  /** Ключ идемпотентности от клиента (бот): повтор несёт то же значение. */
  clientKey?: string | null;
}

type MovementRow = typeof stockMovement.$inferSelect;

/** Цена покупки ингредиента из его карточки: число-или-строка + единица. */
function readIngredientPrice(attrs: Record<string, unknown>): IngredientPrice {
  const raw = attrs["цена покупки"];
  const price =
    typeof raw === "number" && Number.isFinite(raw) && raw > 0
      ? raw
      : typeof raw === "string" && raw.trim().length > 0 && Number.isFinite(Number(raw))
        ? Number(raw)
        : null;
  const unit = isUnit(attrs["единица"]) ? (attrs["единица"] as Unit) : null;
  return { price, unit };
}

/**
 * Склад: движения сырья и остаток НА ЧТЕНИИ.
 *
 * Остаток не хранится полем — выводится из ленты движений при запросе, как и
 * себестоимость рецепта. Первый срез пишет только приход; расход (из журнала
 * продаж) и перемещение включатся своими срезами, но схема и подсчёт уже их
 * держат.
 */
@Injectable()
export class StockService implements OnModuleInit {
  private readonly log = new Logger(StockService.name);
  private cron: Cron | null = null;

  constructor(@Inject(DB) private readonly db: Db) {}

  /**
   * Приход из mydon-stock сводим в ленту склада потоком: тем же ритмом, что и
   * зеркало закупок (supply-sync), но со сдвигом, чтобы читать уже пополненную
   * таблицу purchase. Идемпотентно — повторный проход не двоит.
   */
  onModuleInit(): void {
    this.cron = new Cron("7-59/10 * * * *", { timezone: "Asia/Tashkent" }, () => {
      void this.syncIntakeFromPurchases().catch((e: unknown) =>
        this.log.warn(`Синк прихода не удался: ${e instanceof Error ? e.message : String(e)}`),
      );
    });
  }

  /** Базовая единица ингредиента: та, в которой заведена его цена покупки. */
  private baseUnitOf(attrs: Record<string, unknown>): Unit | null {
    return isUnit(attrs["единица"]) ? (attrs["единица"] as Unit) : null;
  }

  /** Проверить, что карточка есть и нужного типа. */
  private async cardOfType(id: string, type: string): Promise<typeof entity.$inferSelect> {
    const [card] = await this.db.select().from(entity).where(eq(entity.id, id));
    if (!card) throw new NotFoundException(`Карточки нет: ${id}`);
    if (card.type !== type) {
      throw new BadRequestException(`Карточка ${card.name} — не ${type}`);
    }
    return card;
  }

  /** Завести движение. Приход — с ценой; расход/перемещение пока не с экрана. */
  async createMovement(input: CreateMovementInput): Promise<MovementRow> {
    if (!(input.qty > 0)) throw new BadRequestException("Количество должно быть больше нуля");
    if (!isUnit(input.unit)) throw new BadRequestException(`Единица «${input.unit}» неизвестна`);
    const unit: Unit = input.unit;

    const ing = await this.cardOfType(input.ingredientId, "ingredient");
    await this.cardOfType(input.warehouseId, "warehouse");
    if (input.kind === "transfer") {
      if (!input.counterpartyId) {
        throw new BadRequestException("Перемещение требует встречный склад");
      }
      if (input.counterpartyId === input.warehouseId) {
        throw new BadRequestException("Склад-источник и встречный совпадают");
      }
      await this.cardOfType(input.counterpartyId, "warehouse");
    }

    // Единицу прихода сверяем с базовой единицей ингредиента: несводимую не
    // принимаем молча — иначе остаток нельзя будет посчитать честно.
    const base = this.baseUnitOf((ing.attrs ?? {}) as Record<string, unknown>);
    if (base && unit !== base && convertQty(input.qty, unit, base) === null) {
      throw new BadRequestException(
        `«${unit}» не перевести в базовую единицу ингредиента «${base}»`,
      );
    }

    const total =
      input.unitPrice != null && Number.isFinite(input.unitPrice)
        ? String(input.unitPrice * input.qty)
        : null;
    const [row] = await this.db
      .insert(stockMovement)
      .values({
        kind: input.kind,
        ingredientId: input.ingredientId,
        warehouseId: input.warehouseId,
        counterpartyId: input.kind === "transfer" ? input.counterpartyId : null,
        batchId: input.batchId ?? null,
        dt: input.dt ?? new Date().toISOString().slice(0, 10),
        qty: String(input.qty),
        unit: input.unit,
        unitPrice: input.unitPrice != null ? String(input.unitPrice) : null,
        total,
        supplier: input.supplier ?? null,
        source: "owner",
        note: input.note ?? null,
        clientKey: input.clientKey ?? null,
        createdBy: input.createdBy ?? "owner",
      })
      .onConflictDoNothing({ target: stockMovement.clientKey })
      .returning();

    // Повтор по clientKey: движение уже записано первой попыткой — возвращаем
    // его же, склад не задваивается (тот же принцип, что у vending_refill).
    if (!row) {
      const [existing] = await this.db
        .select()
        .from(stockMovement)
        .where(eq(stockMovement.clientKey, input.clientKey!))
        .limit(1);
      if (!existing) {
        throw new BadRequestException("Повтор движения ещё записывается — попробуй ещё раз через минуту");
      }
      return existing;
    }
    return row;
  }

  /** Удалить движение (правка ручного прихода). */
  async removeMovement(id: string): Promise<void> {
    const [row] = await this.db.delete(stockMovement).where(eq(stockMovement.id, id)).returning();
    if (!row) throw new NotFoundException("Движения нет");
  }

  /** Движения ингредиента: лента прихода/расхода со всеми складами. */
  private async movementsOf(where: ReturnType<typeof eq>): Promise<MovementRow[]> {
    return this.db.select().from(stockMovement).where(where).orderBy(desc(stockMovement.dt));
  }

  /** Привести строки БД к движениям для подсчёта; чужие единицы отбрасываем. */
  private toBalanceInput(rows: MovementRow[]): StockMovement[] {
    const out: StockMovement[] = [];
    for (const r of rows) {
      if (!isUnit(r.unit)) continue;
      out.push({
        kind: r.kind,
        warehouseId: r.warehouseId,
        counterpartyId: r.counterpartyId,
        qty: Number(r.qty),
        unit: r.unit,
      });
    }
    return out;
  }

  /**
   * Остаток ингредиента: сводный и по каждому складу. Считается на чтении из
   * движений; несводимые единицы честно помечены непосчитанными.
   */
  async ingredientStock(ingredientId: string): Promise<{
    ingredientId: string;
    ingredientName: string;
    baseUnit: Unit | null;
    total: number | null;
    unconvertible: number;
    warehouses: { warehouseId: string; warehouseName: string; qty: number; unconvertible: number }[];
    movements: {
      id: string;
      kind: string;
      dt: string;
      warehouseId: string;
      warehouseName: string | null;
      counterpartyId: string | null;
      counterpartyName: string | null;
      qty: number;
      unit: string;
      unitPrice: number | null;
      total: number | null;
      supplier: string | null;
      source: string;
      note: string | null;
    }[];
  }> {
    const ing = await this.cardOfType(ingredientId, "ingredient");
    const base = this.baseUnitOf((ing.attrs ?? {}) as Record<string, unknown>);
    const rows = await this.movementsOf(eq(stockMovement.ingredientId, ingredientId));

    // Имена складов, встретившихся в движениях.
    const whIds = [
      ...new Set(rows.flatMap((r) => [r.warehouseId, r.counterpartyId].filter(Boolean) as string[])),
    ];
    const whCards =
      whIds.length === 0 ? [] : await this.db.select().from(entity).where(inArray(entity.id, whIds));
    const whName = new Map(whCards.map((w) => [w.id, w.name]));

    const input = this.toBalanceInput(rows);
    const total = base ? stockBalance(input, base) : null;

    const warehouses = whIds.map((wid) => {
      const b = base ? stockBalance(input, base, wid) : { qty: 0, unconvertible: 0 };
      return {
        warehouseId: wid,
        warehouseName: whName.get(wid) ?? "склад",
        qty: b.qty,
        unconvertible: b.unconvertible,
      };
    });

    return {
      ingredientId,
      ingredientName: ing.name,
      baseUnit: base,
      total: total ? total.qty : null,
      unconvertible: total ? total.unconvertible : 0,
      warehouses,
      movements: rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        dt: String(r.dt),
        warehouseId: r.warehouseId,
        warehouseName: whName.get(r.warehouseId) ?? null,
        counterpartyId: r.counterpartyId,
        counterpartyName: r.counterpartyId ? whName.get(r.counterpartyId) ?? null : null,
        qty: Number(r.qty),
        unit: r.unit,
        unitPrice: r.unitPrice != null ? Number(r.unitPrice) : null,
        total: r.total != null ? Number(r.total) : null,
        supplier: r.supplier,
        source: r.source,
        note: r.note,
      })),
    };
  }

  /**
   * Остаток склада: каждый ингредиент, что через него проходил, и сколько лежит
   * сейчас. Остаток в базовой единице ингредиента.
   */
  async warehouseStock(warehouseId: string): Promise<{
    warehouseId: string;
    warehouseName: string;
    items: {
      ingredientId: string;
      ingredientName: string;
      baseUnit: Unit | null;
      qty: number | null;
      unconvertible: number;
    }[];
    /** Лента движений склада, свежие сверху, до 100 строк. */
    movements: {
      id: string;
      kind: string;
      dt: string;
      ingredientId: string;
      ingredientName: string;
      qty: number;
      unit: string;
      supplier: string | null;
      note: string | null;
    }[];
  }> {
    const wh = await this.cardOfType(warehouseId, "warehouse");
    const rows = await this.movementsOf(
      or(eq(stockMovement.warehouseId, warehouseId), eq(stockMovement.counterpartyId, warehouseId))!,
    );

    const ingIds = [...new Set(rows.map((r) => r.ingredientId))];
    const ingCards =
      ingIds.length === 0 ? [] : await this.db.select().from(entity).where(inArray(entity.id, ingIds));
    const ingById = new Map(ingCards.map((i) => [i.id, i]));

    const items = ingIds.map((iid) => {
      const ing = ingById.get(iid);
      const base = ing ? this.baseUnitOf((ing.attrs ?? {}) as Record<string, unknown>) : null;
      const input = this.toBalanceInput(rows.filter((r) => r.ingredientId === iid));
      const b = base ? stockBalance(input, base, warehouseId) : null;
      return {
        ingredientId: iid,
        ingredientName: ing?.name ?? "ингредиент",
        baseUnit: base,
        qty: b ? b.qty : null,
        unconvertible: b ? b.unconvertible : 0,
      };
    });

    // Лента: движения уже загружены для остатков — доджойниваем только имена.
    const movements = rows.slice(0, 100).map((r) => ({
      id: r.id,
      kind: r.kind,
      dt: String(r.dt),
      ingredientId: r.ingredientId,
      ingredientName: ingById.get(r.ingredientId)?.name ?? "ингредиент",
      qty: Number(r.qty),
      unit: r.unit,
      supplier: r.supplier,
      note: r.note,
    }));

    return { warehouseId, warehouseName: wh.name, items, movements };
  }

  /**
   * Остаток одной пары «склад × ингредиент» в базовой единице — то, что видит
   * сотрудник перед вводом факта при инвентаризации.
   */
  async pairBalance(warehouseId: string, ingredientId: string): Promise<{
    warehouseId: string;
    warehouseName: string;
    ingredientId: string;
    ingredientName: string;
    baseUnit: Unit | null;
    qty: number | null;
    unconvertible: number;
  }> {
    const wh = await this.cardOfType(warehouseId, "warehouse");
    const ing = await this.cardOfType(ingredientId, "ingredient");
    const base = this.baseUnitOf((ing.attrs ?? {}) as Record<string, unknown>);
    const rows = await this.movementsOf(eq(stockMovement.ingredientId, ingredientId));
    const b = base ? stockBalance(this.toBalanceInput(rows), base, warehouseId) : null;
    return {
      warehouseId,
      warehouseName: wh.name,
      ingredientId,
      ingredientName: ing.name,
      baseUnit: base,
      qty: b ? b.qty : null,
      unconvertible: b ? b.unconvertible : 0,
    };
  }

  /**
   * Инвентаризация: сотрудник насчитал по факту `actual` — записываем
   * корректировку на дельту «стало − было».
   *
   * Дельту считает сервер (единственный источник правды об остатке), а не
   * клиент: два человека могли считать один склад, и вычитать надо из текущего
   * остатка на момент записи. Корректировка — обычное движение ленты
   * (append-only), поэтому история пересчётов видна, а прежние движения не
   * переписываются.
   */
  async stocktake(input: StocktakeInput): Promise<{
    changed: boolean;
    before: number;
    actual: number;
    delta: number;
    unit: Unit;
    ingredientName: string;
    warehouseName: string;
    movementId: string | null;
  }> {
    if (!(input.actual >= 0)) {
      throw new BadRequestException("Фактическое количество не может быть отрицательным");
    }
    const pair = await this.pairBalance(input.warehouseId, input.ingredientId);
    const base = pair.baseUnit;
    if (!base) {
      throw new BadRequestException(
        `У ингредиента «${pair.ingredientName}» не задана базовая единица — сначала укажите её, потом инвентаризация`,
      );
    }
    if (pair.unconvertible > 0) {
      throw new BadRequestException(
        "Часть движений в несводимой единице — остаток неполон, инвентаризация дала бы неверную дельту. Сначала выправьте единицы.",
      );
    }

    // Факт приводим к базовой единице ингредиента: считать могли в любой из
    // совместимых (кг вместо г), но остаток и дельта — в базовой.
    let actualBase = input.actual;
    if (input.unit && input.unit !== base) {
      if (!isUnit(input.unit)) throw new BadRequestException(`Единица «${input.unit}» неизвестна`);
      const conv = convertQty(input.actual, input.unit, base);
      if (conv === null) {
        throw new BadRequestException(`«${input.unit}» не перевести в базовую единицу «${base}»`);
      }
      actualBase = conv;
    }

    const before = pair.qty ?? 0;
    // Округляем до точности хранения (scale 3), иначе дельта копит хвосты.
    const delta = Math.round((actualBase - before) * 1000) / 1000;
    if (delta === 0) {
      return {
        changed: false,
        before,
        actual: actualBase,
        delta: 0,
        unit: base,
        ingredientName: pair.ingredientName,
        warehouseName: pair.warehouseName,
        movementId: null,
      };
    }

    const [row] = await this.db
      .insert(stockMovement)
      .values({
        kind: "adjustment",
        ingredientId: input.ingredientId,
        warehouseId: input.warehouseId,
        dt: new Date().toISOString().slice(0, 10),
        qty: String(delta), // подписанная дельта; знак несёт вид adjustment
        unit: base,
        source: "stocktake",
        note: input.note ?? null,
        clientKey: input.clientKey ?? null,
        createdBy: input.countedBy ?? "owner",
      })
      .onConflictDoNothing({ target: stockMovement.clientKey })
      .returning();

    // Повтор по clientKey: корректировка уже записана — отдаём ЗАПИСАННОЕ
    // движение, а не свежепересчитанную дельту (после первой записи остаток
    // уже сдвинулся, и повторный «стало − было» дал бы ложные числа).
    if (!row) {
      const [existing] = await this.db
        .select()
        .from(stockMovement)
        .where(eq(stockMovement.clientKey, input.clientKey!))
        .limit(1);
      if (!existing) {
        throw new BadRequestException("Повтор пересчёта ещё записывается — попробуй ещё раз через минуту");
      }
      const recordedDelta = Number(existing.qty);
      return {
        changed: true,
        before: Math.round((actualBase - recordedDelta) * 1000) / 1000,
        actual: actualBase,
        delta: recordedDelta,
        unit: base,
        ingredientName: pair.ingredientName,
        warehouseName: pair.warehouseName,
        movementId: existing.id,
      };
    }

    return {
      changed: true,
      before,
      actual: actualBase,
      delta,
      unit: base,
      ingredientName: pair.ingredientName,
      warehouseName: pair.warehouseName,
      movementId: row.id,
    };
  }

  /**
   * Расход сырья за период: сколько ингредиентов списали продажи.
   *
   * Считается НА ЧТЕНИИ из журнала продаж и рецептов — не хранится и не пишется
   * движениями. Продажа товара-рецепта раскрывается в состав × количество и
   * приводится к базовой единице ингредиента. Товар из продажи сопоставляется с
   * карточкой так же, как в разборе источников: по имени и ручным связкам
   * (raw_link), чтобы владелец правил соответствие в одном месте.
   */
  async consumption(from: string, to: string): Promise<{
    from: string;
    to: string;
    soldRecipeUnits: number;
    totalCost: number;
    unresolved: number;
    ingredients: {
      ingredientId: string;
      ingredientName: string;
      approved: boolean;
      consumed: number | null;
      unit: string | null;
      cost: number | null;
      unconvertible: number;
      fromProducts: number;
    }[];
    products: { productId: string; productName: string; soldQty: number; cost: number | null }[];
    noRecipe: { productId: string; productName: string; soldQty: number }[];
    unmatched: { product: string; source: string; soldQty: number; revenue: number }[];
  }> {
    // Продажи за период, свёрнутые по источнику и названию товара.
    const rows = await this.db
      .select({
        source: sale.source,
        product: sale.product,
        qty: sql<string>`sum(${sale.qty})`,
        amount: sql<string>`sum(${sale.amount})`,
      })
      .from(sale)
      .where(and(gte(sale.dt, from), lte(sale.dt, to)))
      .groupBy(sale.source, sale.product);

    // Карточки товаров и ручные связки — для сопоставления имени с карточкой.
    const products = await this.db.select().from(entity).where(eq(entity.type, "product"));
    const byId = new Map(products.map((p) => [p.id, p]));
    const byName = new Map(products.map((p) => [normalizeSourceKey(p.name), p]));
    const links = await this.db.select().from(rawLink).where(eq(rawLink.kind, "product"));
    const linkByKey = new Map(links.map((l) => [`${l.sourceCode}::${l.externalKey}`, l]));

    const soldByProduct = new Map<string, number>();
    const noRecipe = new Map<string, { productName: string; soldQty: number }>();
    const unmatched: { product: string; source: string; soldQty: number; revenue: number }[] = [];

    for (const r of rows) {
      const qty = Number(r.qty) || 0;
      if (qty <= 0) continue;
      const key = normalizeSourceKey(r.product);
      const link = linkByKey.get(`${r.source}::${key}`);
      // Связка владельца сильнее авто-совпадения; связка с пустой карточкой —
      // осознанное «карточку не заводить», товар в расход не идёт.
      const card = link ? (link.entityId ? byId.get(link.entityId) ?? null : null) : byName.get(key) ?? null;

      if (!card) {
        unmatched.push({ product: r.product, source: r.source, soldQty: qty, revenue: Number(r.amount) || 0 });
        continue;
      }
      if (productKind((card.attrs ?? {}) as Record<string, unknown>) !== "рецепт") {
        const cur = noRecipe.get(card.id) ?? { productName: card.name, soldQty: 0 };
        cur.soldQty += qty;
        noRecipe.set(card.id, cur);
        continue;
      }
      soldByProduct.set(card.id, (soldByProduct.get(card.id) ?? 0) + qty);
    }

    // Составы проданных рецептов и карточки их ингредиентов.
    const recipeLines = new Map<string, RecipeLine[]>();
    const ingIds = new Set<string>();
    for (const productId of soldByProduct.keys()) {
      const card = byId.get(productId);
      const lines = parseRecipe((card?.attrs ?? {}) as Record<string, unknown>);
      recipeLines.set(productId, lines);
      for (const l of lines) ingIds.add(l.ingredientId);
    }
    const ingCards =
      ingIds.size === 0
        ? []
        : await this.db.select().from(entity).where(inArray(entity.id, [...ingIds]));
    const ingById = new Map(ingCards.map((i) => [i.id, i]));

    const priceOf = (id: string): IngredientPrice =>
      readIngredientPrice((ingById.get(id)?.attrs ?? {}) as Record<string, unknown>);
    const recipeOf = (id: string): RecipeLine[] => recipeLines.get(id) ?? [];
    const sold: SoldProduct[] = [...soldByProduct].map(([productId, qty]) => ({ productId, qty }));

    const report = consumptionReport(sold, recipeOf, priceOf);

    return {
      from,
      to,
      soldRecipeUnits: sold.reduce((n, s) => n + s.qty, 0),
      totalCost: report.totalCost,
      unresolved: report.unresolved,
      ingredients: report.ingredients
        .map((i) => {
          const ing = ingById.get(i.ingredientId);
          return {
            ingredientId: i.ingredientId,
            ingredientName: ing?.name ?? "ингредиент",
            approved: ing ? ing.approvedAt !== null : false,
            consumed: i.consumed,
            unit: i.unit,
            cost: i.cost,
            unconvertible: i.unconvertible,
            fromProducts: i.fromProducts,
          };
        })
        .sort((a, b) => (b.cost ?? 0) - (a.cost ?? 0)),
      products: sold
        .map((s) => {
          const cost = recipeCost(recipeOf(s.productId), priceOf);
          return {
            productId: s.productId,
            productName: byId.get(s.productId)?.name ?? "товар",
            soldQty: s.qty,
            cost: cost.unresolved > 0 && cost.total === 0 ? null : s.qty * cost.total,
          };
        })
        .sort((a, b) => b.soldQty - a.soldQty),
      noRecipe: [...noRecipe].map(([productId, v]) => ({ productId, ...v })),
      unmatched: unmatched.sort((a, b) => b.revenue - a.revenue),
    };
  }

  /** Значение поля карточки — «истинное»: да/true/1/непустое. */
  private truthy(v: unknown): boolean {
    if (v === true) return true;
    if (typeof v === "number") return v !== 0;
    if (typeof v === "string") {
      const s = v.trim().toLowerCase();
      return s === "да" || s === "true" || s === "1" || s === "yes" || s === "+";
    }
    return false;
  }

  /**
   * Целевой склад приёма: помеченный «приём по умолчанию»; если такого нет, но
   * склад один — он; если складов несколько и ни один не помечен — не решаем за
   * владельца, возвращаем null (синк честно скажет, что цель не выбрана).
   */
  private async defaultWarehouse(): Promise<typeof entity.$inferSelect | null> {
    const whs = await this.db.select().from(entity).where(eq(entity.type, "warehouse"));
    const flagged = whs.find((w) => this.truthy((w.attrs as Record<string, unknown>)["приём по умолчанию"]));
    if (flagged) return flagged;
    return whs.length === 1 ? whs[0] : null;
  }

  /**
   * Свести приход из зеркала mydon-stock (таблица purchase) в ленту склада.
   *
   * Строку закупки сопоставляем с карточкой ингредиента по имени и ручным
   * связкам (raw_link) — как в разборе источников и расходе. Пишем движение
   * прихода идемпотентно (ключ `purchase:<id>`): повторный синк не двоит.
   * Товары без карточки-ингредиента и несводимые единицы не молчим — считаем.
   */
  async syncIntakeFromPurchases(): Promise<{
    warehouse: string | null;
    created: number;
    alreadySynced: number;
    noCard: number;
    badUnit: number;
    noWarehouse: "нет" | "неоднозначно" | null;
  }> {
    const wh = await this.defaultWarehouse();
    if (!wh) {
      const [{ n }] = await this.db
        .select({ n: sql<number>`count(*)` })
        .from(entity)
        .where(eq(entity.type, "warehouse"));
      return {
        warehouse: null,
        created: 0,
        alreadySynced: 0,
        noCard: 0,
        badUnit: 0,
        noWarehouse: Number(n) === 0 ? "нет" : "неоднозначно",
      };
    }

    const rows = await this.db.select().from(purchase);
    // Карточки ингредиентов и связки — сопоставление имени с карточкой.
    const ings = await this.db.select().from(entity).where(eq(entity.type, "ingredient"));
    const ingByName = new Map(ings.map((i) => [normalizeSourceKey(i.name), i]));
    const ingById = new Map(ings.map((i) => [i.id, i]));
    const links = await this.db.select().from(rawLink).where(eq(rawLink.kind, "product"));
    const linkByKey = new Map(links.map((l) => [`${l.sourceCode}::${l.externalKey}`, l]));

    const resolve = (p: PurchaseInput): ResolvedIngredient | null => {
      const key = normalizeSourceKey(p.product);
      const link = linkByKey.get(`${p.source}::${key}`);
      const card = link
        ? link.entityId
          ? ingById.get(link.entityId) ?? null // связка на не-ингредиент → не приход сырья
          : null
        : ingByName.get(key) ?? null;
      if (!card) return null;
      return {
        ingredientId: card.id,
        baseUnit: isUnit((card.attrs as Record<string, unknown>)["единица"])
          ? ((card.attrs as Record<string, unknown>)["единица"] as Unit)
          : null,
      };
    };

    const inputs: PurchaseInput[] = rows.map((r) => ({
      id: r.extId,
      source: r.source,
      product: r.product,
      unit: r.unit,
      qty: Number(r.qty) || 0,
      unitPrice: r.unitPrice != null ? Number(r.unitPrice) : null,
      dt: String(r.dt),
    }));

    const plan = planPurchaseIntake(inputs, resolve);

    let created = 0;
    for (const it of plan.intakes) {
      const total = it.unitPrice != null ? String(it.unitPrice * it.qty) : null;
      const inserted = await this.db
        .insert(stockMovement)
        .values({
          kind: "intake",
          ingredientId: it.ingredientId,
          warehouseId: wh.id,
          dt: it.dt,
          qty: String(it.qty),
          unit: it.unit,
          unitPrice: it.unitPrice != null ? String(it.unitPrice) : null,
          total,
          source: "stock",
          extId: it.extId,
          createdBy: "stock-sync",
        })
        .onConflictDoNothing({ target: [stockMovement.source, stockMovement.extId] })
        .returning();
      if (inserted.length > 0) created += 1;
    }

    if (created > 0) this.log.log(`Синк прихода: заведено ${created} движений на «${wh.name}».`);
    return {
      warehouse: wh.name,
      created,
      alreadySynced: plan.intakes.length - created,
      noCard: plan.noCard.length,
      badUnit: plan.badUnit.length,
      noWarehouse: null,
    };
  }

  /** Сотрудник существует — иначе FK партии/вскрытия упал бы сырой ошибкой БД. */
  private async personExists(id: string): Promise<void> {
    const [row] = await this.db.select({ id: person.id }).from(person).where(eq(person.id, id));
    if (!row) throw new NotFoundException(`Сотрудник ${id} не найден`);
  }

  /**
   * Сопоставить имя поставщика (свободный текст с карточки/формы прихода) с
   * карточкой контрагента (R-C4). Не нашлось ИЛИ нашлось больше одной —
   * `null`, без выдумок (см. `matchContractorByName`).
   */
  private async matchSupplier(name: string | null | undefined): Promise<string | null> {
    const raw = typeof name === "string" ? name.trim() : "";
    if (raw === "") return null;
    const contractors: ContractorRef[] = await this.db
      .select({ id: entity.id, name: entity.name })
      .from(entity)
      .where(eq(entity.type, "contractor"));
    return matchContractorByName(raw, contractors)?.id ?? null;
  }

  /**
   * Партии с посчитанным остатком и сроком годности.
   *
   * Остаток — леджером: `qty_received` минус сумма `consumption`-движений с
   * этим `batch_id` (шаг 1 брифа); никакого денормализованного поля. Этот
   * срез не подключает автосписание к движениям (R-C2 — на чтение), поэтому
   * сегодня таких движений нет ни одного и остаток партии всегда равен
   * `qtyReceived` — запрос уже готов на будущее, когда появится расход.
   *
   * Срок — `effectiveExpiry`: явная `expiry_date` партии, иначе
   * `manufacture_date ?? received_on` плюс норматив карточки
   * `attrs["срок годности, дней"]`; нет и норматива — флаг `none`.
   *
   * Фильтр по `ingredientId`/`warehouseId`/`ids` — точное совпадение в JS
   * после полной выборки (партий у одного заведения — десятки-сотни, не
   * тысячи; так дешевле, чем городить динамическое `where` под каждую
   * комбинацию опциональных фильтров).
   */
  private async computeBatchRows(filter: {
    ingredientId?: string;
    warehouseId?: string;
    ids?: string[];
  }): Promise<BatchRow[]> {
    if (filter.ids && filter.ids.length === 0) return [];
    let rows = await this.db.select().from(stockBatch);
    if (filter.ids) rows = rows.filter((r) => filter.ids!.includes(r.id));
    if (filter.ingredientId) rows = rows.filter((r) => r.ingredientId === filter.ingredientId);
    if (filter.warehouseId) rows = rows.filter((r) => r.warehouseId === filter.warehouseId);
    if (rows.length === 0) return [];

    const batchIds = rows.map((r) => r.id);
    const consumedRows = await this.db
      .select({ batchId: stockMovement.batchId, sum: sql<string>`sum(${stockMovement.qty})` })
      .from(stockMovement)
      .where(and(eq(stockMovement.kind, "consumption"), inArray(stockMovement.batchId, batchIds)))
      .groupBy(stockMovement.batchId);
    const consumedMap = new Map(consumedRows.map((r) => [r.batchId as string, Number(r.sum) || 0]));

    // Сырое имя поставщика живёт на приходном движении партии: на самой партии
    // хранится только ссылка (R-C4). Достаём его, чтобы показать введённое имя,
    // когда карточка не нашлась.
    const intakeRows = await this.db
      .select({ batchId: stockMovement.batchId, supplier: stockMovement.supplier })
      .from(stockMovement)
      .where(and(eq(stockMovement.kind, "intake"), inArray(stockMovement.batchId, batchIds)));
    const supplierRawMap = new Map<string, string>();
    for (const r of intakeRows) {
      const t = (r.supplier ?? "").trim();
      if (r.batchId && t !== "" && !supplierRawMap.has(r.batchId)) supplierRawMap.set(r.batchId, t);
    }

    const idPool = [
      ...rows.map((r) => r.ingredientId),
      ...rows.map((r) => r.warehouseId),
      ...rows.map((r) => r.supplierId).filter((x): x is string => x != null),
    ];
    const cardIds = [...new Set(idPool)];
    const cards = cardIds.length === 0 ? [] : await this.db.select().from(entity).where(inArray(entity.id, cardIds));
    const cardById = new Map(cards.map((c) => [c.id, c]));

    // Сравниваем СУТКИ, а не моменты. Postgres-тип `date` приходит строкой
    // «2026-08-21», а `new Date("2026-08-21")` — это UTC-полночь, то есть 05:00
    // по Ташкенту. Сравнивать её с реальным «сейчас» значит объявлять партию
    // просроченной с пяти утра дня, в который она ещё годна: чип краснеет, а
    // счётчик «Просрочено» врёт целые сутки. Берём ташкентскую дату и якорим её
    // в ту же UTC-полночь — тогда обе стороны сравнения суточные, и разница
    // считается в целых днях.
    const now = new Date(`${todayTashkent()}T00:00:00Z`);
    return rows.map((b) => {
      const ingCard = cardById.get(b.ingredientId);
      const shelfLifeDays = strictNumber(
        (ingCard?.attrs as Record<string, unknown> | undefined)?.["срок годности, дней"],
      );
      const expiry = effectiveExpiry(
        {
          expiryAt: b.expiryDate ? new Date(String(b.expiryDate)) : null,
          manufactureAt: b.manufactureDate ? new Date(String(b.manufactureDate)) : null,
          receivedAt: new Date(String(b.receivedOn)),
        },
        shelfLifeDays,
      );
      const flag = expiryFlag(expiry, now);
      // Округляем до точности хранения (scale 3 у qty_received), как и в
      // stocktake — иначе вычитание копит хвосты вида 4.999999999999998.
      const remaining = Math.round((Number(b.qtyReceived) - (consumedMap.get(b.id) ?? 0)) * 1000) / 1000;
      return {
        id: b.id,
        ingredientId: b.ingredientId,
        ingredientName: ingCard?.name ?? "ингредиент",
        warehouseId: b.warehouseId,
        warehouseName: cardById.get(b.warehouseId)?.name ?? "склад",
        batchCode: b.batchCode,
        receivedOn: String(b.receivedOn),
        qtyReceived: Number(b.qtyReceived),
        unit: b.unit,
        remaining,
        expiry: expiry ? expiry.toISOString().slice(0, 10) : null,
        flag,
        opened: b.openedOn != null,
        openedOn: b.openedOn ? String(b.openedOn) : null,
        supplierId: b.supplierId,
        supplierName: b.supplierId ? (cardById.get(b.supplierId)?.name ?? null) : null,
        supplierRaw: supplierRawMap.get(b.id) ?? null,
        invoiceNo: b.invoiceNo,
        invoiceDate: b.invoiceDate ? String(b.invoiceDate) : null,
        unitPriceGross: b.unitPriceGross != null ? Number(b.unitPriceGross) : null,
        note: b.note,
        source: b.source,
      };
    });
  }

  /**
   * Проверки и обе идемпотентности партии — ДО первой записи (шаг 1 брифа
   * среза D). Общая для одиночного `createBatch` и массового `importBatches`,
   * чтобы `dryRun` (R-D7) видел ТОЧНО то же самое основание, по которому
   * настоящий прогон решит «уже была» / «создать» / «отклонить», не
   * дублируя логику в двух местах.
   *
   * Идемпотентность здесь двойная:
   *  - `clientKey` — приём от бота/панели (повтор нажатия при таймауте);
   *  - `(source, extId)` — приём массового импорта (факт 9 брифа: у
   *    `stock_batch` есть уникальный индекс `stock_batch_ext_key` на паре,
   *    но сервис его раньше не проверял, и повтор падал сырой ошибкой
   *    Postgres). Обе — до вставки: вернуть чужую строку ПОСЛЕ неё оставило
   *    бы партию-сироту (эта ошибка уже ловилась в срезе C).
   */
  private async prepareBatch(input: CreateBatchInput): Promise<
    | { kind: "existing"; row: BatchRow }
    | {
        kind: "new";
        unit: Unit;
        base: Unit | null;
        source: string;
        supplierId: string | null;
        unitPriceGross: number | null;
        receivedOn: string;
        packageWeightSnapshot: number | null;
      }
  > {
    if (!(input.qtyReceived > 0)) throw new BadRequestException("Количество партии должно быть больше нуля");
    // Знак цены проверяем здесь, а не в DTO: при массовом импорте одна строка с
    // минусом иначе отвергла бы всю пачку. Отрицательная цена — опечатка ввода,
    // то же правило, что в ingredient-price.ts.
    for (const [что, цена] of [
      ["без НДС", input.unitPriceNet],
      ["с НДС", input.unitPriceGross],
    ] as const) {
      if (цена != null && цена < 0) {
        throw new BadRequestException(`Цена ${что} не может быть отрицательной — похоже на опечатку`);
      }
    }
    if (input.vatRate != null && input.vatRate < 0) {
      throw new BadRequestException("Ставка НДС не может быть отрицательной");
    }
    if (!isUnit(input.unit)) throw new BadRequestException(`Единица «${input.unit}» неизвестна`);
    const unit: Unit = input.unit;

    const ing = await this.cardOfType(input.ingredientId, "ingredient");
    await this.cardOfType(input.warehouseId, "warehouse");
    const attrs = (ing.attrs ?? {}) as Record<string, unknown>;
    const base = this.baseUnitOf(attrs);
    if (base && unit !== base && convertQty(input.qtyReceived, unit, base) === null) {
      throw new BadRequestException(`«${unit}» не перевести в базовую единицу ингредиента «${base}»`);
    }
    if (input.personId) await this.personExists(input.personId);

    const source = input.source ?? "manual";

    // Повтор по clientKey отбиваем ДО первой записи. Иначе новая партия уже
    // вставлена в транзакцию, и вернуть чужую строку значит закоммитить сироту:
    // партию без приходного движения, которая всплывёт в остатках ниоткуда.
    if (input.clientKey) {
      const [already] = await this.db
        .select({ batchId: stockMovement.batchId })
        .from(stockMovement)
        .where(eq(stockMovement.clientKey, input.clientKey))
        .limit(1);
      if (already?.batchId) {
        const [row] = await this.computeBatchRows({ ids: [already.batchId] });
        if (row) return { kind: "existing", row };
      }
      if (already) {
        throw new BadRequestException(
          "Этот ключ идемпотентности уже занят приходом без партии — повторите с другим ключом",
        );
      }
    }

    // Повтор по (source, extId) — идемпотентность массового импорта.
    if (input.extId) {
      const [already] = await this.db
        .select({ id: stockBatch.id })
        .from(stockBatch)
        .where(and(eq(stockBatch.source, source), eq(stockBatch.extId, input.extId)))
        .limit(1);
      if (already) {
        const [row] = await this.computeBatchRows({ ids: [already.id] });
        if (row) return { kind: "existing", row };
      }
    }

    const supplierId = await this.matchSupplier(input.supplier);

    // Цена с НДС: доверяем явно переданной; иначе считаем из цены без НДС и
    // ставки, если обе даны — придумывать ставку 0% по умолчанию нельзя.
    const unitPriceGross =
      input.unitPriceGross != null
        ? input.unitPriceGross
        : input.unitPriceNet != null && input.vatRate != null
          ? input.unitPriceNet * (1 + input.vatRate / 100)
          : null;

    const receivedOn = input.receivedOn ?? todayTashkent();
    // Снимок веса упаковки: правка карточки не должна дорожать/удешевлять уже
    // принятую партию. Колонка целая (package_weight_snapshot) — округляем;
    // запрет на Math.trunc/parseInt из глобальных правил про КОЛИЧЕСТВА сюда
    // не относится: это справочный вес упаковки карточки, а не остаток склада.
    const packageWeightRaw = strictNumber(attrs["вес упаковки, г"]);
    const packageWeightSnapshot = packageWeightRaw != null ? Math.round(packageWeightRaw) : null;

    return { kind: "new", unit, base, source, supplierId, unitPriceGross, receivedOn, packageWeightSnapshot };
  }

  /**
   * Записать партию, приходное движение и (R-D1) закрывающий расход —
   * ровно то, что делал раньше `createBatch` целиком. Вызывается только
   * когда {@link prepareBatch} сказал `"new"` — то есть НИКОГДА в `dryRun`.
   */
  private async writeBatch(
    input: CreateBatchInput,
    prep: Extract<Awaited<ReturnType<StockService["prepareBatch"]>>, { kind: "new" }>,
  ): Promise<BatchRow> {
    const { unit, base, source, supplierId, unitPriceGross, receivedOn, packageWeightSnapshot } = prep;

    const created = await this.db.transaction(async (tx) => {
      const [batch] = await tx
        .insert(stockBatch)
        .values({
          ingredientId: input.ingredientId,
          warehouseId: input.warehouseId,
          batchCode: input.batchCode ?? null,
          expiryDate: input.expiryDate ?? null,
          manufactureDate: input.manufactureDate ?? null,
          receivedOn,
          qtyReceived: String(input.qtyReceived),
          unit,
          openedOn: null,
          openedBy: null,
          personId: input.personId ?? null,
          supplierId,
          invoiceNo: input.invoiceNo ?? null,
          invoiceDate: input.invoiceDate ?? null,
          ikpu: input.ikpu ?? null,
          unitPriceNet: input.unitPriceNet != null ? String(input.unitPriceNet) : null,
          vatRate: input.vatRate != null ? String(input.vatRate) : null,
          unitPriceGross: unitPriceGross != null ? String(unitPriceGross) : null,
          baseUnitSnapshot: base,
          packageWeightSnapshot,
          source,
          extId: input.extId ?? null,
          note: input.note ?? null,
        })
        .returning();
      if (!batch) throw new BadRequestException("Не удалось завести партию");

      const total = unitPriceGross != null ? String(unitPriceGross * input.qtyReceived) : null;
      const [movement] = await tx
        .insert(stockMovement)
        .values({
          kind: "intake",
          ingredientId: input.ingredientId,
          warehouseId: input.warehouseId,
          batchId: batch.id,
          dt: receivedOn,
          qty: String(input.qtyReceived),
          unit,
          unitPrice: unitPriceGross != null ? String(unitPriceGross) : null,
          total,
          supplier: input.supplier ?? null,
          source: "owner",
          note: input.note ?? null,
          clientKey: input.clientKey ?? null,
          createdBy: input.createdBy ?? "owner",
        })
        .onConflictDoNothing({ target: stockMovement.clientKey })
        .returning();

      if (!movement) {
        // Повтор по clientKey — УСПЕХ, а не ошибка (тот же контракт, что у
        // createMovement выше). Приход уже записан первой попыткой; возвращаем
        // ту же партию, к которой он привязан.
        //
        // Почему не ошибка. Клиент повторяет запрос ровно тогда, когда не
        // дождался ответа по таймауту — и запись при этом прошла. Ответить
        // ошибкой на успевший запрос значит подтолкнуть оператора нажать ещё
        // раз, уже с НОВЫМ ключом, и вот тогда партия действительно задвоится.
        // Идемпотентность обязана вести себя одинаково во всём складе.
        // Сюда попадаем только гонкой: проверка выше ключ не нашла, а между ней
        // и вставкой запись успел сделать параллельный запрос. Бросаем — вся
        // транзакция откатывается, сироты не остаётся, клиент повторит и уже на
        // проверке выше получит ту же партию.
        if (input.clientKey) {
          throw new BadRequestException("Повтор прихода ещё записывается — попробуй ещё раз через минуту");
        }
        throw new BadRequestException("Не удалось записать движение прихода партии");
      }

      // R-D1: закрытие исторической партии расходом. Импорт партии БЕЗ этого
      // задвоил бы остаток (кофе стал бы ~293 кг вместо 43 на живом складе) —
      // расходное движение того же объёма, с тем же batchId, гасит приход в
      // `stockBalance` (kind=consumption вычитает вне зависимости от batchId)
      // и одновременно обнуляет `remaining` партии в `computeBatchRows`
      // (qtyReceived минус сумма consumption-движений с этим batchId).
      if (input.closeOn) {
        await tx
          .insert(stockMovement)
          .values({
            kind: "consumption",
            ingredientId: input.ingredientId,
            warehouseId: input.warehouseId,
            batchId: batch.id,
            dt: input.closeOn,
            qty: String(input.qtyReceived),
            unit,
            source: "owner",
            note: `израсходовано до инвентаризации ${input.closeOn}, точная дата неизвестна`,
            createdBy: "import",
          })
          .returning();
      }

      return batch;
    });

    const [row] = await this.computeBatchRows({ ids: [created.id] });
    if (!row) throw new NotFoundException("Партия заведена, но не нашлась при чтении — повторите запрос");
    return row;
  }

  /**
   * Завести партию прихода (§4.3 + документ Р3/Р4) и связанное приходное
   * движение склада в одной транзакции: `stock_batch.qty_received` без
   * движения не отразилось бы в остатке ингредиента/склада (тот считается
   * ИСКЛЮЧИТЕЛЬНО из `stock_movement` — формула `stockBalance` не тронута),
   * а движение без партии — уже существующий, законный случай (снимок
   * владельца, синк снабжения), который эта партия не должна задваивать.
   */
  async createBatch(input: CreateBatchInput): Promise<BatchRow> {
    const prep = await this.prepareBatch(input);
    if (prep.kind === "existing") return prep.row;
    return this.writeBatch(input, prep);
  }

  /**
   * Массовый импорт партий с предпросмотром (срез D, задача 3). До 500 строк
   * за раз (проверено и в `ImportBatchesDto`, здесь — второй рубеж на случай
   * прямого вызова сервиса).
   *
   * Каждая строка несёт готовый `ingredientId` (сопоставление уже сделано на
   * витрине, Task 2 `suggestCard`) — сервис карточки не подбирает и не
   * гадает. `ingredientId: null` — строка не сопоставлена (`unmatched`, а не
   * ошибка); `receivedOn: null` — даты нет (`noDate`, R-D3); карточка не типа
   * `ingredient` — тип `cardOfType` бросит исключение, строка уходит в
   * `rejected` с причиной, а импорт продолжается для остальных строк (R-D2):
   * каждая строка обёрнута в свой `try/catch`, одна упавшая не роняет пачку.
   *
   * `dryRun` (R-D7): классификация каждой строки (`existing`/`new` из
   * {@link prepareBatch}, ошибки валидации) идёт ОДИНАКОВО что в предпросмотре,
   * что в настоящем прогоне — отличается только то, что `writeBatch` в dryRun
   * НЕ вызывается вовсе. Поэтому отчёт совпадает буквально, а не «похож».
   */
  async importBatches(input: {
    source: string;
    dryRun?: boolean;
    closeOn?: string | null;
    items: ImportBatchItem[];
  }): Promise<ImportBatchesReport> {
    if (input.items.length > 500) {
      throw new BadRequestException("Пачка не может быть больше 500 строк за раз");
    }
    const dryRun = input.dryRun === true;

    // Пустая строка — не дата. `if (input.closeOn)` считает её ложью, и закрытие
    // партий молча выключилось бы для всего прогона: остаток задвоился бы, а
    // отчёт выглядел бы точно так же, как при верной дате. Приводим к null явно
    // и говорим в отчёте, закрывали мы партии или нет.
    const closeOn = typeof input.closeOn === "string" && input.closeOn.trim() !== "" ? input.closeOn.trim() : null;

    let created = 0;
    let closed = 0;
    let skippedRepeat = 0;
    const noDate: ImportBatchIssue[] = [];
    const unmatched: ImportBatchIssue[] = [];
    const rejected: ImportBatchRejection[] = [];

    for (const item of input.items) {
      const name = item.name ?? null;

      if (!item.ingredientId) {
        unmatched.push({ fileRow: item.fileRow, name });
        continue;
      }
      if (!item.receivedOn) {
        noDate.push({ fileRow: item.fileRow, name });
        continue;
      }

      const batchInput: CreateBatchInput = {
        ingredientId: item.ingredientId,
        warehouseId: item.warehouseId,
        qtyReceived: item.qtyReceived,
        unit: item.unit,
        receivedOn: item.receivedOn,
        supplier: item.supplier ?? null,
        invoiceNo: item.invoiceNo ?? null,
        invoiceDate: item.invoiceDate ?? null,
        unitPriceGross: item.unitPriceGross ?? null,
        note: item.note ?? null,
        source: input.source,
        extId: item.extId ?? String(item.fileRow),
        closeOn,
        createdBy: "import",
      };

      try {
        const prep = await this.prepareBatch(batchInput);
        if (prep.kind === "existing") {
          skippedRepeat += 1;
          continue;
        }
        if (!dryRun) await this.writeBatch(batchInput, prep);
        created += 1;
        if (closeOn !== null) closed += 1;
      } catch (e) {
        rejected.push({ fileRow: item.fileRow, name, reason: e instanceof Error ? e.message : String(e) });
      }
    }

    return { dryRun, created, closed, closeOn, skippedRepeat, noDate, unmatched, rejected };
  }

  /** Список партий с остатком и флагом срока; необязательные фильтры. */
  async listBatches(filter: {
    ingredientId?: string;
    warehouseId?: string;
    flag?: string;
  }): Promise<{ rows: BatchRow[] }> {
    let flag: ExpiryFlag | undefined;
    if (filter.flag !== undefined && filter.flag !== "") {
      if (!isExpiryFlag(filter.flag)) throw new BadRequestException(`Флаг «${filter.flag}» неизвестен`);
      flag = filter.flag;
    }
    let rows = await this.computeBatchRows({ ingredientId: filter.ingredientId, warehouseId: filter.warehouseId });
    if (flag) rows = rows.filter((r) => r.flag === flag);
    rows = [...rows].sort(compareBatchRow);
    return { rows };
  }

  /**
   * Отчёт по срокам годности: просрочено / истекает < 14 дней / в порядке /
   * без срока, плюс порядок расхода по FEFO — какая партия ушла бы первой
   * (шаг 4 брифа, R-C2). FEFO считается ГРУППОЙ «ингредиент × склад»:
   * списание физически идёт с конкретного склада, партии с другого склада в
   * очередь не подмешиваются. `allocateFEFO` зовётся с `need`, РОВНО равным
   * сумме остатков группы, — тогда легла раскладка целиком покрывает все
   * партии группы в порядке FEFO без хвоста, и порядковый номер леги = место
   * партии в очереди списания. Это ЧТЕНИЕ (R-C2): движений это не создаёт.
   */
  async expiryReport(): Promise<{
    asOf: string;
    thresholdDays: number;
    counts: Record<ExpiryFlag, number>;
    rows: ExpiryRow[];
  }> {
    // Только партии, в которых что-то ОСТАЛОСЬ. Израсходованная партия не может
    // испортиться: показывать её среди сроков — значит звать разбираться с тем,
    // чего на полке нет. Особенно заметно после импорта истории: он заводит
    // партии прошлого года и тут же закрывает их расходом (R-D1), и без этого
    // отбора экран сроков сразу после загрузки наполнился бы десятками
    // «просроченных» позиций, которых физически не существует.
    const rows = (await this.computeBatchRows({})).filter((r) => r.remaining > 0);
    const counts: Record<ExpiryFlag, number> = { expired: 0, expiring: 0, ok: 0, none: 0 };
    for (const r of rows) counts[r.flag] += 1;

    const groups = new Map<string, BatchRow[]>();
    for (const r of rows) {
      const key = `${r.ingredientId}::${r.warehouseId}`;
      const arr = groups.get(key);
      if (arr) arr.push(r);
      else groups.set(key, [r]);
    }
    const orderByBatch = new Map<string, number>();
    for (const group of groups.values()) {
      const fefoBatches: FefoBatch[] = group
        .filter((r) => r.remaining > 0)
        .map((r) => ({
          batchId: r.id,
          remaining: r.remaining,
          expiryAt: r.expiry ? new Date(r.expiry) : null,
          receivedAt: new Date(r.receivedOn),
        }));
      const need = fefoBatches.reduce((s, b) => s + b.remaining, 0);
      if (need <= 0) continue;
      const legs = allocateFEFO(need, fefoBatches);
      legs.forEach((leg, i) => {
        if (leg.batchId) orderByBatch.set(leg.batchId, i + 1);
      });
    }

    const result: ExpiryRow[] = rows
      .map((r) => ({ ...r, fefoOrder: orderByBatch.get(r.id) ?? null }))
      .sort(compareBatchRow);

    return {
      asOf: todayTashkent(),
      thresholdDays: DEFAULT_EXPIRING_DAYS,
      counts,
      rows: result,
    };
  }

  /** Отметить вскрытие партии: `opened_on` (по умолчанию сегодня) и `opened_by`. */
  async openBatch(
    id: string,
    input: { openedOn?: string | null; openedBy?: string | null },
  ): Promise<BatchRow> {
    const [existing] = await this.db
      .select({ id: stockBatch.id, openedOn: stockBatch.openedOn, openedBy: stockBatch.openedBy })
      .from(stockBatch)
      .where(eq(stockBatch.id, id));
    if (!existing) throw new NotFoundException("Партия не найдена");
    if (input.openedBy) await this.personExists(input.openedBy);

    // Пачку вскрывают ОДИН раз (инвариант §4.3). Повторный вызов — это второе
    // нажатие, а не второе вскрытие: возвращаем как есть, не переписывая дату
    // сегодняшним днём. И `openedBy` не затираем в null, если его не передали —
    // иначе повтор стёр бы уже записанного человека.
    if (existing.openedOn != null) {
      const [row] = await this.computeBatchRows({ ids: [id] });
      if (!row) throw new NotFoundException("Партия не найдена");
      return row;
    }

    const openedOn = input.openedOn ?? todayTashkent();
    await this.db
      .update(stockBatch)
      .set({ openedOn, openedBy: input.openedBy ?? existing.openedBy ?? null })
      .where(eq(stockBatch.id, id));

    const [row] = await this.computeBatchRows({ ids: [id] });
    if (!row) throw new NotFoundException("Партия не найдена");
    return row;
  }
}
