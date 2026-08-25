/**
 * Схема MYDON Core (PostgreSQL / Drizzle).
 * Единый реестр по ТЗ §7: org · project · entity · person · task ·
 * approval · event · document · money_flow · note · audit_log.
 *
 * Принцип: сначала реестр, потом дашборд. Базы движков (VHM24 и др.) — отдельные, здесь не хранятся.
 */
import { desc, sql } from "drizzle-orm";
import {
  pgTable,
  pgEnum,
  uuid,
  text,
  timestamp,
  jsonb,
  numeric,
  integer,
  boolean,
  index,
  date,
  uniqueIndex,
  check,
} from "drizzle-orm/pg-core";
import type { CashCategorySummary, RecipeLine } from "@mydon/shared";

// ── Перечисления ──
export const domainEnum = pgEnum("domain", ["globerent", "vendhub", "personal", "mydon"]);
export const ownerKindEnum = pgEnum("owner_kind", ["human", "agent"]);
export const taskStatusEnum = pgEnum("task_status", ["todo", "in_progress", "done", "cancelled"]);
/** Оценка сделанной задачи владельцем: качество должно отмечаться, а не подразумеваться. */
export const taskQualityEnum = pgEnum("task_quality", ["excellent", "accepted", "redo"]);
export const approvalTierEnum = pgEnum("approval_tier", ["T0", "T1", "T2", "T3", "T4"]);
export const approvalDecisionEnum = pgEnum("approval_decision", [
  "pending",
  "approved",
  "rejected",
  "clarify",
]);
export const taskPriorityEnum = pgEnum("task_priority", ["low", "normal", "high", "urgent"]);
export const moneyDirectionEnum = pgEnum("money_direction", ["in", "out"]);
export const actorKindEnum = pgEnum("actor_kind", ["human", "agent", "system"]);

const id = () => uuid("id").defaultRandom().primaryKey();
const createdAt = () => timestamp("created_at", { withTimezone: true }).defaultNow().notNull();

// ── org: направления бизнеса ──
export const org = pgTable("org", {
  id: id(),
  code: domainEnum("code").notNull(),
  name: text("name").notNull(),
  createdAt: createdAt(),
});

// ── project: инициативы внутри org ──
export const project = pgTable("project", {
  id: id(),
  orgId: uuid("org_id").references(() => org.id),
  name: text("name").notNull(),
  status: text("status").default("active").notNull(),
  createdAt: createdAt(),
});

// ── entity: универсальная сущность (контрагент, автомат, техника, объект, договор) ──
export const entity = pgTable(
  "entity",
  {
    id: id(),
    orgId: uuid("org_id").references(() => org.id),
    type: text("type").notNull(), // contractor | machine | equipment | object | contract | ...
    name: text("name").notNull(),
    externalRef: text("external_ref"), // ссылка на источник (ИНН, id в VHM24 и т.п.)
    attrs: jsonb("attrs").default({}).notNull(),
    /**
     * Карточка утверждена владельцем.
     *
     * NULL — заведена не им (из выгрузки источника, кодом, агентом) и ждёт
     * утверждения. До него карточка существует и её видно, но фактом она не
     * считается и на экранах помечена отдельно.
     *
     * Слово владельца — единственное, что делает запись реестра фактом.
     */
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    approvedBy: text("approved_by"),
    /** Откуда карточка взялась: код источника или пусто, если завёл владелец. */
    createdFrom: text("created_from"),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("entity_org_type_idx").on(t.orgId, t.type),
    // ИНН контрагента уникален (перенос правила PROMACH uq_clients_inn):
    // пустой ИНН не конфликтует — физлица и незаполненные карточки допустимы.
    uniqueIndex("ux_entity_contractor_inn")
      .on(t.type, t.externalRef)
      .where(sql`type = 'contractor' and external_ref is not null and external_ref <> ''`),
  ],
);

/**
 * Значение поля карточки, предложенное НЕ владельцем.
 *
 * Правило владельца: всё, что по автоматам и товарам вписал не он, лежит
 * отдельно и ждёт утверждения. Поэтому такие значения НЕ попадают в
 * `entity.attrs` сразу: пока значение здесь, оно не факт, и всё, что считается
 * поверх реестра — фискальная готовность, журнал, сверки, — его не видит.
 *
 * Утвердил — значение переехало в карточку и запись отсюда ушла. Отклонил —
 * ушла без следа в карточке. Промежуточного состояния «вроде записано, но
 * не совсем» быть не должно.
 */
export const entityDraft = pgTable(
  "entity_draft",
  {
    id: id(),
    entityId: uuid("entity_id")
      .notNull()
      .references(() => entity.id, { onDelete: "cascade" }),
    /** Имя поля: ключ attrs, либо «название» / «номер» для полей самой карточки. */
    field: text("field").notNull(),
    /** Предложенное значение строкой — как его дал источник. */
    value: text("value").notNull(),
    /** Что стоит в карточке сейчас: владелец должен видеть, что заменяется. */
    current: text("current"),
    /** Откуда взято: код источника, имя агента. Владелец читает это словами. */
    origin: text("origin").notNull(),
    /** Кто предложил: ingest | agent:<имя> | source:<код>. */
    setBy: text("set_by").default("system").notNull(),
    /** Почему предложено — если требуется объяснение. */
    note: text("note"),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("ux_entity_draft").on(t.entityId, t.field)],
);

// ── person: сотрудники, партнёры, контакты ──
// Задачи людям доходят через Telegram (решение владельца): для этого нужны
// tgUsername (его называет владелец) и tgChatId (появляется, когда сотрудник
// нажал /start у бота). Разделены намеренно — по имени пользователя писать
// нельзя, писать можно только по chat_id.
export const person = pgTable("person", {
  id: id(),
  orgId: uuid("org_id").references(() => org.id),
  name: text("name").notNull(),
  role: text("role"),
  /**
   * Роли сотрудника. Массив, а не одно значение: двое в поле делают всю
   * работу, и «оператор ИЛИ техник» описало бы их неверно.
   *
   * Старая колонка `role` (свободный текст) остаётся: она нигде не читалась
   * ботом и служит подсказкой владельцу при расстановке ролей.
   */
  roles: text("roles")
    .array()
    .default(sql`'{}'::text[]`)
    .notNull(),
  /** Направление, куда нанят: сотрудник живёт внутри GLOBERENT/VendHub, а не отдельно. */
  domain: domainEnum("domain"),
  email: text("email"),
  phone: text("phone"),
  /** @username в Telegram — как владелец записал в карточке. */
  tgUsername: text("tg_username"),
  /** Числовой chat_id: один Telegram — один сотрудник, иначе задачи уйдут не туда. */
  tgChatId: text("tg_chat_id").unique(),
  /** Уволенный сотрудник не удаляется: его задачи и история должны остаться. */
  active: text("active").default("yes").notNull(),
  attrs: jsonb("attrs").default({}).notNull(),
  createdAt: createdAt(),
});

// ── task: задачи (исполнитель — человек или агент) ──
export const task = pgTable(
  "task",
  {
    id: id(),
    title: text("title").notNull(),
    /** Подробности: что именно сделать. Заголовка часто мало. */
    description: text("description"),
    ownerKind: ownerKindEnum("owner_kind").notNull(),
    /**
     * person.id или имя агента. NULL при ownerKind='human' означает
     * «свободная задача»: её видят все и разбирают из общего пула.
     * Закрепления сотрудников за объектами нет — все работают по всему парку.
     */
    ownerRef: text("owner_ref"),
    domain: domainEnum("domain"),
    /**
     * По какому объекту работа: автомат, точка, склад — запись реестра.
     *
     * Без этого поля задачи нельзя сгруппировать по объекту, а техник ездит
     * по точкам, а не по видам работ: «три дела на Kaffit-04» — это один
     * заезд, а тот же список вперемешку — три.
     */
    entityId: uuid("entity_id").references(() => entity.id),
    status: taskStatusEnum("status").default("todo").notNull(),
    /** Срочность — чтобы список сортировался по важности, а не по алфавиту. */
    priority: taskPriorityEnum("priority").default("normal").notNull(),
    due: timestamp("due", { withTimezone: true }),
    source: text("source"), // откуда пришла задача
    /** Кто поставил: владелец, агент, расписание. */
    createdBy: text("created_by"),
    /** Отчёт при закрытии: без него «сделано» ничего не значит. */
    resultNote: text("result_note"),
    /** Оценка владельца после «сделано»: отлично / принято / переделать. */
    quality: taskQualityEnum("quality"),
    /** Когда исполнителю сообщили о возврате на доработку — защита от повторов. */
    redoNotifiedAt: timestamp("redo_notified_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    /**
     * Кто ФАКТИЧЕСКИ закрыл: person:<id> | owner. Исполнитель (ownerRef) и
     * закрывший — разные вопросы: задачу сотрудника может закрыть владелец
     * из панели, и лента действий не должна приписывать это сотруднику.
     */
    closedBy: text("closed_by"),
    /** Когда исполнителю уже напомнили — чтобы не слать одно и то же дважды. */
    remindedAt: timestamp("reminded_at", { withTimezone: true }),
    /**
     * Ключ идемпотентности от клиента (бот, заявка о поломке). Ретрай после
     * таймаута не должен плодить дубль-заявки. NULL у всех остальных путей.
     */
    clientKey: text("client_key"),
    createdAt: createdAt(),
  },
  // Главные запросы: «что у этого исполнителя» и «что горит по срокам».
  (t) => [
    index("task_owner_idx").on(t.ownerKind, t.ownerRef),
    index("task_due_idx").on(t.due),
    index("task_entity_idx").on(t.entityId),
    /**
     * Идемпотентность повторяющихся задач.
     *
     * `ensureForDay` строит source как `<ключ>:<YYYY-MM-DD>` и раньше делал
     * select-then-insert: два тика монитора в одну секунду создавали две
     * задачи на один день. Ставку делает БД.
     *
     * Индекс ЧАСТИЧНЫЙ — только по источникам с датой на конце. Обычные
     * source ("ourvend", "sales-sync", "owner", "agent:<имя>") повторяются
     * у сотен задач на законных основаниях, и глобальный unique их сломал бы.
     */
    uniqueIndex("task_source_key")
      .on(t.source)
      .where(sql`source ~ ':[0-9]{4}-[0-9]{2}-[0-9]{2}$'`),
    uniqueIndex("task_client_key").on(t.clientKey),
  ],
);

// ── collection: инкассация автоматов (перенос VendCash внутрь MYDON) ──
// Двухэтапный процесс из спецификации VendCash: оператор фиксирует сбор
// (время до секунды), менеджер принимает и вводит сумму.
export const collectionStatusEnum = pgEnum("collection_status", [
  "collected",
  "received",
  "cancelled",
]);
export const collectionSourceEnum = pgEnum("collection_source", [
  "realtime",
  "manual_history",
  "import",
]);
export const collection = pgTable(
  "collection",
  {
    id: id(),
    /** Автомат — запись реестра (entity типа machine). */
    machineId: uuid("machine_id")
      .references(() => entity.id)
      .notNull(),
    /** Кто собрал. Пусто у перенесённой истории без оператора. */
    operatorId: uuid("operator_id").references(() => person.id),
    /** Кто принял и пересчитал: "owner" или person:<id>. */
    managerRef: text("manager_ref"),
    /** Время сбора — до секунды (требование спецификации VendCash). */
    collectedAt: timestamp("collected_at", { withTimezone: true }).notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }),
    /** Сумма в сумах. Появляется только при приёме. */
    amount: numeric("amount", { precision: 15, scale: 2 }),
    /** Направление бизнеса. Пока вся инкассация — VendHub. */
    domain: domainEnum("domain").default("vendhub").notNull(),
    /** Валюта суммы. Пока сумы. */
    currency: text("currency").default("UZS").notNull(),
    status: collectionStatusEnum("status").default("collected").notNull(),
    source: collectionSourceEnum("source").default("realtime").notNull(),
    notes: text("notes"),
    /**
     * Разбивка суммы по купюрам — приходит только при приёме, и только если
     * её вводили. У ВСЕХ 386 существующих инкассаций её нет и не будет:
     * колонка новая, а те записи заведены до неё (247 импортом, 139 ручным
     * вводом истории). Пусто здесь — законно, а не пробел в данных.
     */
    denominations: jsonb("denominations"),
    createdAt: createdAt(),
  },
  (t) => [
    index("collection_machine_date_idx").on(t.machineId, t.collectedAt),
    index("collection_status_idx").on(t.status),
  ],
);

// ── sale: продажи автоматов (этап 1 миграции: синк из mydon-stock/OurVend) ──
// Дневные сводки «дата · автомат · товар»: источник отдаёт агрегаты за день,
// и строка дообновляется в течение дня — поэтому уникальный ключ и upsert.
export const sale = pgTable(
  "sale",
  {
    id: id(),
    /** День продажи (у источника нет времени внутри дня). */
    dt: date("dt").notNull(),
    /** Серийник автомата из источника — ключ сопоставления. */
    machineSerial: text("machine_serial").notNull(),
    /** Автомат в реестре, если серийник узнан. */
    machineId: uuid("machine_id").references(() => entity.id),
    product: text("product").notNull(),
    qty: numeric("qty", { precision: 12, scale: 2 }).default("0").notNull(),
    amount: numeric("amount", { precision: 15, scale: 2 }).default("0").notNull(),
    /** Направление бизнеса. Пока все продажи — VendHub (расчётов по направлениям нет). */
    domain: domainEnum("domain").default("vendhub").notNull(),
    /** Валюта суммы. Пока сумы. */
    currency: text("currency").default("UZS").notNull(),
    source: text("source").default("ourvend").notNull(),
    /** Когда источник видел эти цифры — по нему выбираем свежее. */
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull(),
    importedAt: createdAt(),
  },
  (t) => [
    uniqueIndex("sale_src_day_key").on(t.source, t.dt, t.machineSerial, t.product),
    index("sale_dt_idx").on(t.dt),
    index("sale_machine_idx").on(t.machineId, t.dt),
  ],
);

// ── ourvend_sale_snapshot: СОБСТВЕННЫЙ учётный снапшот продаж OurVend ──
// П2 плана поглощения (docs/PLAN_STOCK_ABSORPTION.md): свой суточный съём
// кабинета вместо чтения БД mydon-stock. Пишется агентом через
// POST /vending/accounting-snapshot днями-перезаписью (как у донора). До
// переключения OURVEND_ACCOUNTING_SOURCE=own таблица — теневая: по ней
// считается паритет со stock-дорожкой, в `sale` она не попадает.
export const ourvendSaleSnapshot = pgTable(
  "ourvend_sale_snapshot",
  {
    id: id(),
    dt: date("dt").notNull(),
    /** Серийник в форме API OurVend (голые 10 цифр); канон сопоставляет обе формы. */
    machineSerial: text("machine_serial").notNull(),
    product: text("product").notNull(),
    qty: numeric("qty", { precision: 12, scale: 2 }).default("0").notNull(),
    amount: numeric("amount", { precision: 15, scale: 2 }).default("0").notNull(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull(),
    importedAt: createdAt(),
  },
  (t) => [
    uniqueIndex("ourvend_sale_snap_key").on(t.dt, t.machineSerial, t.product),
    index("ourvend_sale_snap_dt_idx").on(t.dt),
  ],
);

// ── ourvend_stock_snapshot: собственный утренний снимок остатков автоматов ──
export const ourvendStockSnapshot = pgTable(
  "ourvend_stock_snapshot",
  {
    id: id(),
    dt: date("dt").notNull(),
    machineSerial: text("machine_serial").notNull(),
    product: text("product").notNull(),
    qty: numeric("qty", { precision: 12, scale: 2 }).default("0").notNull(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull(),
    importedAt: createdAt(),
  },
  (t) => [
    uniqueIndex("ourvend_stock_snap_key").on(t.dt, t.machineSerial, t.product),
    index("ourvend_stock_snap_dt_idx").on(t.dt),
  ],
);

// ── purchase: приход товара/сырья (этап 2: синк из mydon-stock) ──
export const purchase = pgTable(
  "purchase",
  {
    id: id(),
    /** id строки в источнике — ключ идемпотентного синка. */
    extId: text("ext_id").notNull(),
    dt: date("dt").notNull(),
    product: text("product").notNull(),
    unit: text("unit"),
    qty: numeric("qty", { precision: 12, scale: 2 }).default("0").notNull(),
    unitPrice: numeric("unit_price", { precision: 15, scale: 2 }),
    total: numeric("total", { precision: 15, scale: 2 }),
    /** Направление бизнеса. Пока весь приход — VendHub. */
    domain: domainEnum("domain").default("vendhub").notNull(),
    /** Валюта суммы. Пока сумы. */
    currency: text("currency").default("UZS").notNull(),
    note: text("note"),
    /** Срок годности партии — для отчёта «Сроки годности». */
    expiryDate: date("expiry_date"),
    source: text("source").default("stock").notNull(),
    importedAt: createdAt(),
  },
  (t) => [uniqueIndex("purchase_src_key").on(t.source, t.extId), index("purchase_dt_idx").on(t.dt)],
);

// ── machine_stock: остатки внутри автоматов (снапшоты OurVend по дням) ──
export const machineStock = pgTable(
  "machine_stock",
  {
    id: id(),
    dt: date("dt").notNull(),
    machineSerial: text("machine_serial").notNull(),
    machineId: uuid("machine_id").references(() => entity.id),
    product: text("product").notNull(),
    qty: numeric("qty", { precision: 12, scale: 2 }).default("0").notNull(),
    /** Направление бизнеса. Остатки — количества, валюты здесь нет. */
    domain: domainEnum("domain").default("vendhub").notNull(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull(),
    importedAt: createdAt(),
  },
  (t) => [
    uniqueIndex("machine_stock_day_key").on(t.dt, t.machineSerial, t.product),
    index("machine_stock_serial_idx").on(t.machineSerial, t.dt),
  ],
);

// ── stock_movement: движения склада (приход, расход, перемещение) ──
//
// Append-only лента: остаток = сумма движений НА ЧТЕНИИ, как себестоимость
// рецепта. Ничего не пересчитывается в мутабельное поле — производное выводим
// из данных, не держим (у донора кэш остатка расходился с движениями).
// Схема сразу под несколько складов и будущий расход по продажам, но первый
// срез пишет только приход; расход и перемещение включатся своими срезами.
export const stockMovementKindEnum = pgEnum("stock_movement_kind", [
  "intake", // приход: закупка сырья на склад (+)
  "consumption", // расход: списание по продажам (−)
  "transfer", // перемещение между складами (− со склада, + на встречный)
  "adjustment", // корректировка инвентаризации: подписанная дельта «стало − было»
]);

/**
 * Алиас имени продажи: «как товар назван в источнике» → карточка реестра.
 *
 * `sale.product` — текст из mydon-stock/Ourvend без FK; часть имён совпадает
 * с карточками, остальные продажи карточка товара не видит. Привязку делает
 * владелец (слово владельца — как в vending_alias): автоматическое «похожее
 * имя» рано или поздно склеит 330ml с 450ml, и цифры продаж соврут.
 */
export const productNameAlias = pgTable(
  "product_name_alias",
  {
    id: id(),
    /** Карточка товара (entity type=product). */
    entityId: uuid("entity_id")
      .notNull()
      .references(() => entity.id, { onDelete: "cascade" }),
    /** Имя из источника — ровно как в sale.product, уникально во всём словаре. */
    name: text("name").notNull().unique(),
    createdBy: text("created_by"),
    createdAt: createdAt(),
  },
  (t) => [index("product_name_alias_entity_idx").on(t.entityId)],
);

// ── stock_batch: партия сырья/товара (WAREHOUSE_SPEC §4.3 + документ прихода Р3/Р4) ──
//
// Остаток партии — леджером (сумма движений с этим batch_id), а не
// денормализованным полем: так уже устроен stock_movement, и рассинхрона не
// бывает. Партия без кода (batchCode = NULL) — законна: не у каждой поставки
// есть номер партии от поставщика.
export const stockBatch = pgTable(
  "stock_batch",
  {
    id: id(),
    /** Карточка сырья/товара: entity(type='ingredient'|'product'). */
    ingredientId: uuid("ingredient_id")
      .references(() => entity.id)
      .notNull(),
    /** Куда принято: entity(type='warehouse'). */
    warehouseId: uuid("warehouse_id")
      .references(() => entity.id)
      .notNull(),
    /** Код партии поставщика. Пусто — партия без кода, это законно. */
    batchCode: text("batch_code"),
    /** Срок годности партии. Пусто — считается из «срок годности, дней» карточки. */
    expiryDate: date("expiry_date"),
    /** Дата производства, если известна: от неё считается срок при пустом expiryDate. */
    manufactureDate: date("manufacture_date"),
    receivedOn: date("received_on").notNull(),
    qtyReceived: numeric("qty_received", { precision: 14, scale: 3 }).notNull(),
    unit: text("unit").notNull(),
    /** Когда вскрыли пачку. Отдельной таблицы не заводим: пачка вскрывается один раз. */
    openedOn: date("opened_on"),
    openedBy: uuid("opened_by").references(() => person.id),
    personId: uuid("person_id").references(() => person.id),
    // ── Документ прихода (Р3/Р4): партия обязана помнить, почём её взяли ──
    /** Поставщик ссылкой, а не именем (R-C4): у документа есть ИНН. */
    supplierId: uuid("supplier_id").references(() => entity.id),
    invoiceNo: text("invoice_no"),
    invoiceDate: date("invoice_date"),
    /** ИКПУ позиции документа — устойчивый ключ каталога, надёжнее названия. */
    ikpu: text("ikpu"),
    /** Цена за `unit` без НДС, ставка и цена с НДС (R-C5). */
    unitPriceNet: numeric("unit_price_net", { precision: 14, scale: 4 }),
    vatRate: numeric("vat_rate", { precision: 5, scale: 2 }),
    unitPriceGross: numeric("unit_price_gross", { precision: 14, scale: 4 }),
    /** Снимок на момент прихода: правка карточки не должна дорожать прошлую партию. */
    baseUnitSnapshot: text("base_unit_snapshot"),
    packageWeightSnapshot: integer("package_weight_snapshot"),
    /** Откуда партия: 'manual' | 'didox' | 'excel' | 'receipt'. */
    source: text("source").default("manual").notNull(),
    /** Ключ идемпотентности источника: у Didox — идентификатор документа + № строки. */
    extId: text("ext_id"),
    note: text("note"),
    createdAt: createdAt(),
  },
  (t) => [
    index("stock_batch_expiry_idx")
      .on(t.expiryDate)
      .where(sql`expiry_date is not null`),
    index("stock_batch_open_idx")
      .on(t.openedOn)
      .where(sql`opened_on is not null`),
    uniqueIndex("stock_batch_code_key")
      .on(t.ingredientId, t.batchCode)
      .where(sql`batch_code is not null`),
    uniqueIndex("stock_batch_ext_key")
      .on(t.source, t.extId)
      .where(sql`ext_id is not null`),
  ],
);

export const stockMovement = pgTable(
  "stock_movement",
  {
    id: id(),
    kind: stockMovementKindEnum("kind").notNull(),
    /** Ингредиент — карточка entity type=ingredient. */
    ingredientId: uuid("ingredient_id")
      .notNull()
      .references(() => entity.id),
    /** Склад — карточка entity type=warehouse, куда/откуда движение. */
    warehouseId: uuid("warehouse_id")
      .notNull()
      .references(() => entity.id),
    /** Встречный склад (для перемещения) — куда легло. Пусто у прихода/расхода. */
    counterpartyId: uuid("counterparty_id").references(() => entity.id),
    /**
     * Партия, к которой относится движение. Nullable: приход без партии
     * остаётся законным — иначе сломался бы существующий синк снабжения
     * (у него партий нет вовсе) и уже записанный снимок остатка владельца
     * (движения `adjustment` без партии: кофе 43 кг, сухое молоко 26 кг и т.д.).
     */
    batchId: uuid("batch_id").references(() => stockBatch.id),
    dt: date("dt").notNull(),
    /** Количество в `unit`, всегда положительное. Знак задаёт вид движения. */
    qty: numeric("qty", { precision: 14, scale: 3 }).notNull(),
    unit: text("unit").notNull(),
    /** Цена за единицу и сумма — только у прихода. */
    unitPrice: numeric("unit_price", { precision: 15, scale: 2 }),
    total: numeric("total", { precision: 15, scale: 2 }),
    supplier: text("supplier"),
    /** Направление бизнеса. Пока весь склад — VendHub. */
    domain: domainEnum("domain").default("vendhub").notNull(),
    currency: text("currency").default("UZS").notNull(),
    /** Откуда движение: owner | stock (синк) | sales-derived (расход). */
    source: text("source").default("owner").notNull(),
    /** id строки в источнике — ключ идемпотентного синка. У ручных пусто. */
    extId: text("ext_id"),
    note: text("note"),
    /**
     * Ключ идемпотентности от клиента (бот): таймаут при успехе + честный
     * повтор не должны давать второй приход/корректировку. NULL у панели и
     * синка (у синка своя идемпотентность source+extId).
     */
    clientKey: text("client_key"),
    createdBy: text("created_by"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("stock_movement_client_key").on(t.clientKey),
    index("stock_movement_ing_idx").on(t.ingredientId, t.dt),
    index("stock_movement_wh_idx").on(t.warehouseId, t.dt),
    // Идемпотентность синка: одна строка источника — одно движение. Ручные
    // (extId = NULL) не конфликтуют: NULL в уникальном индексе различны.
    uniqueIndex("stock_movement_src_key").on(t.source, t.extId),
  ],
);

// ── raw_snapshot / raw_row: сырой слой источников ──
//
// Сюда кладётся выгрузка отчёта внешней системы РОВНО как она пришла: те же
// названия колонок, тот же порядок, значения строками. Ничего не переименовано
// и не приведено к типам — иначе спорную цифру нечем будет подтвердить.
// Разбор в аналитику (sale, purchase, machine_stock) живёт отдельно и этот
// слой не меняет: он остаётся распечаткой источника на дату.
export const rawSnapshot = pgTable(
  "raw_snapshot",
  {
    id: id(),
    /** Код системы-источника: gjvending | ourvend | payme | vendinghub. */
    sourceCode: text("source_code").notNull(),
    /** Код отчёта внутри системы: order_query, machine_cash… */
    reportCode: text("report_code").notNull(),
    /** Направление бизнеса. Пока все источники — VendHub. */
    domain: domainEnum("domain").default("vendhub").notNull(),
    /** Когда снято у источника — это, а не время загрузки, отвечает «насколько свежо». */
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull(),
    /** Период выгрузки, как он был выбран в источнике. */
    periodFrom: date("period_from"),
    periodTo: date("period_to"),
    /** Учётная запись, под которой снималось: выгрузки разных кабинетов не путаются. */
    account: text("account"),
    /** Сколько строк показывал источник. Может быть больше, чем влезло в снимок. */
    rowsTotal: integer("rows_total"),
    /** Названия колонок в порядке источника. Порядок — часть данных. */
    columns: jsonb("columns").$type<string[]>().default([]).notNull(),
    /** Кто принёс: owner | agent:<имя> | ingest. */
    importedBy: text("imported_by"),
    note: text("note"),
    /**
     * Когда снимок целиком принят и его можно читать в отчётах.
     * NULL означает незавершённую пакетную загрузку: строки уже лежат для
     * безопасного повтора, но аналитика их ещё не считает фактом.
     */
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    // Один и тот же снимок не должен лечь дважды при повторной отправке.
    uniqueIndex("raw_snapshot_key").on(t.sourceCode, t.reportCode, t.fetchedAt),
    index("raw_snapshot_report_idx").on(t.sourceCode, t.reportCode, t.fetchedAt),
  ],
);

export const rawRow = pgTable(
  "raw_row",
  {
    id: id(),
    snapshotId: uuid("snapshot_id")
      .references(() => rawSnapshot.id, { onDelete: "cascade" })
      .notNull(),
    /** Номер строки в источнике, с единицы: порядок выгрузки тоже факт. */
    idx: integer("idx").notNull(),
    /** Значения строки, порядок соответствует columns снимка. Всё строками. */
    cells: jsonb("cells").$type<string[]>().default([]).notNull(),
  },
  (t) => [
    uniqueIndex("raw_row_key").on(t.snapshotId, t.idx),
    index("raw_row_snapshot_idx").on(t.snapshotId),
  ],
);

// ── raw_link: сопоставление значений источника с карточками реестра ──
//
// Второй слой: сырьё лежит как пришло, а «Ice Lemon Tea» из чужой панели
// связывается с нашей карточкой товара здесь. Хранится, а не вычисляется
// на лету: решение владельца обязано пережить следующую выгрузку, иначе он
// будет разбирать одни и те же незнакомые названия каждую неделю.
/**
 * Справочник источников, заполняемый владельцем.
 *
 * Основа справочника — код (`packages/shared/src/sources.ts`): он типизирован,
 * лежит в git и проходит ревью. Но добавить систему или отчёт выкладкой можно
 * только тогда, когда рядом есть разработчик, а владелец заводит кабинеты сам и
 * тогда, когда они у него появляются.
 *
 * Поэтому здесь — ДОПОЛНЕНИЯ и ПРАВКИ владельца. Правило разрешения: запись
 * отсюда важнее записи в коде с тем же кодом; записи, которых в коде нет,
 * просто добавляются. Код при этом остаётся основой и никуда не девается —
 * иначе выложенное однажды знание об источнике потерялось бы при чистке базы.
 */
export const rawSourceDef = pgTable("raw_source_def", {
  /** Код системы: латиницей, стабилен — по нему связаны снимки. */
  code: text("code").primaryKey(),
  title: text("title").notNull(),
  /** Чем эта система является в хозяйстве владельца. */
  subtitle: text("subtitle").default("").notNull(),
  /** Адрес кабинета. Пусто — честное «ещё не записан», а не выдуманный адрес. */
  url: text("url").default("").notNull(),
  /** Убран с глаз, но не удалён: снимки на него по-прежнему ссылаются. */
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

/**
 * Отчёт внутри системы-источника, заведённый владельцем.
 *
 * `roles` заполняется НЕ вручную по памяти, а выбором из настоящих заголовков
 * первой выгрузки: угадывать название колонки, которой не видел, — то же самое,
 * что выдумывать данные.
 */
export const rawReportDef = pgTable(
  "raw_report_def",
  {
    id: id(),
    sourceCode: text("source_code").notNull(),
    code: text("code").notNull(),
    title: text("title").notNull(),
    /** Что это по-русски — владелец читает эту строку, а не английский заголовок. */
    ru: text("ru").default("").notNull(),
    /** Где его нажать в чужом интерфейсе: «Report Query → Order Query». */
    path: text("path").default("").notNull(),
    /**
     * Роли колонок: ключ роли → названия колонки у источника.
     * Пусто — состав отчёта ещё не видели, и это честное состояние.
     */
    roles: jsonb("roles").$type<Record<string, string[]>>().default({}).notNull(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("ux_raw_report_def").on(t.sourceCode, t.code)],
);

export const rawLinkKindEnum = pgEnum("raw_link_kind", ["machine", "product", "point"]);
export const rawLink = pgTable(
  "raw_link",
  {
    id: id(),
    sourceCode: text("source_code").notNull(),
    kind: rawLinkKindEnum("kind").notNull(),
    /** Значение источника после нормализации — по нему ищем совпадение. */
    externalKey: text("external_key").notNull(),
    /** Как оно выглядело в источнике: владельцу показываем его написание. */
    externalLabel: text("external_label").notNull(),
    /** Карточка реестра. Пусто = «разобрано и решено карточку не заводить». */
    entityId: uuid("entity_id").references(() => entity.id, { onDelete: "set null" }),
    /**
     * Кто решил: owner — владелец руками, agent:<имя> — предложил агент.
     * Автосовпадения по точному ключу здесь НЕ хранятся: они пересчитываются
     * от текущих карточек, и запись о них протухла бы при переименовании.
     */
    decidedBy: text("decided_by").default("owner").notNull(),
    /** Почему связано именно так — если владельцу пришлось объяснять. */
    note: text("note"),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("raw_link_key").on(t.sourceCode, t.kind, t.externalKey),
    index("raw_link_entity_idx").on(t.entityId),
  ],
);

// ── task_comment: переписка по задаче (уточнения, отчёты, вопросы) ──
export const taskComment = pgTable(
  "task_comment",
  {
    id: id(),
    taskId: uuid("task_id")
      .references(() => task.id, { onDelete: "cascade" })
      .notNull(),
    /** Кто написал: "owner", "person:<id>", "agent:<имя>". */
    authorRef: text("author_ref").notNull(),
    body: text("body").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("task_comment_task_idx").on(t.taskId)],
);

// ── approval: запрос на согласование действия агента ──
export const approval = pgTable("approval", {
  id: id(),
  agent: text("agent").notNull(),
  action: text("action").notNull(),
  tier: approvalTierEnum("tier").notNull(),
  payload: jsonb("payload").default({}).notNull(),
  decision: approvalDecisionEnum("decision").default("pending").notNull(),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  createdAt: createdAt(),
});

// ── event: всё, что произошло (шина событий) ──
export const event = pgTable(
  "event",
  {
    id: id(),
    source: text("source").notNull(),
    type: text("type").notNull(),
    payload: jsonb("payload").default({}).notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).defaultNow().notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("event_type_time_idx").on(t.type, t.occurredAt)],
);

// ── geo_point: типизированные координаты карточки ──
//
// Раньше широта/долгота жили в entity.attrs строками без всякой проверки: можно
// было записать «широта: 999» или перепутать её с долготой. Здесь координаты
// лежат ЧИСЛАМИ с ограничением диапазона на уровне БД — мусор не запишется
// вовсе, а не всплывёт позже пропавшей с карты точкой. Одна точка на карточку.
// attrs остаются для совместимости; Core держит эту таблицу в согласии с ними.
export const geoPoint = pgTable(
  "geo_point",
  {
    entityId: uuid("entity_id")
      .primaryKey()
      .references(() => entity.id, { onDelete: "cascade" }),
    lat: numeric("lat", { precision: 9, scale: 6 }).notNull(),
    lng: numeric("lng", { precision: 9, scale: 6 }).notNull(),
    /** Адрес точки словами — из «точка»/«адрес»/«локация». */
    address: text("address"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    check("geo_point_lat_range", sql`${t.lat} >= -90 and ${t.lat} <= 90`),
    check("geo_point_lng_range", sql`${t.lng} >= -180 and ${t.lng} <= 180`),
  ],
);

// ── attachment: файлы (фото номенклатуры, чеки), привязанные к записи ──
//
// Полиморфная привязка: одна таблица под фото карточек, чеки приходов и т.п.
// Сам файл лежит в объектном хранилище (S3/MinIO) или на диске — здесь только
// ключ и метаданные. Так фото товара/запчасти, снятое сотрудником в Telegram,
// привязывается к карточке (owner_type='entity') или движению склада.
export const attachment = pgTable(
  "attachment",
  {
    id: id(),
    /** К чему привязано: 'entity' | 'stock_movement' | ... */
    ownerType: text("owner_type").notNull(),
    ownerId: uuid("owner_id").notNull(),
    /** Что это: photo | receipt | doc. */
    kind: text("kind").default("photo").notNull(),
    /**
     * Стадия съёмки: before | after | plate | counter. NULL — вне контекста
     * работы (фото карточки в реестре).
     *
     * Без неё две фотографии задачи неразличимы, и «до/после» существует
     * только в голове того, кто их прислал. Отдельная колонка, а не префикс
     * в `kind`: `kind` отвечает на «что это за файл», стадия — на «в какой
     * момент снят», и смешивать их значит терять одно из двух.
     */
    stage: text("stage"),
    /** Ключ в хранилище (S3-ключ или относительный путь на диске). */
    storageKey: text("storage_key").notNull(),
    mime: text("mime"),
    bytes: integer("bytes"),
    /** Кто загрузил: owner | staff:<id> | agent:<имя>. */
    createdBy: text("created_by"),
    createdAt: createdAt(),
  },
  (t) => [index("attachment_owner_idx").on(t.ownerType, t.ownerId)],
);

// ── notification_delivery: что уже доставлено владельцу (FR-2) ──
//
// Срочное уведомление выводится из события правилом детерминированно, поэтому
// ключ `<eventId>:<ruleId>` стабилен. Отметку о доставке храним ЗДЕСЬ, а не в
// памяти бота: иначе перезапуск бота задвоил бы тревоги, а сбой отправки — терял
// бы их. Бот отмечает доставку ПОСЛЕ успешной отправки в Telegram, и `pending`
// уже доставленное не возвращает.
export const notificationDelivery = pgTable("notification_delivery", {
  /** `<eventId>:<ruleId>` — одно уведомление. */
  key: text("key").primaryKey(),
  deliveredAt: createdAt(),
});

// ── document: ссылки на файлы (в архив/knowledge-curator) ──
export const document = pgTable("document", {
  id: id(),
  pathOrUrl: text("path_or_url").notNull(),
  kind: text("kind"), // финмодель | КП | договор | юридический | аналитика | ...
  orgId: uuid("org_id").references(() => org.id),
  entityId: uuid("entity_id").references(() => entity.id),
  tags: jsonb("tags").default([]).notNull(),
  createdAt: createdAt(),
});

// ── money_flow: движения денег ──
export const moneyFlow = pgTable(
  "money_flow",
  {
    id: id(),
    orgId: uuid("org_id").references(() => org.id),
    entityId: uuid("entity_id").references(() => entity.id),
    /** Направление бизнеса — чтобы деньги GLOBERENT и VendHub не смешивались. */
    domain: domainEnum("domain"),
    direction: moneyDirectionEnum("direction").notNull(),
    amount: numeric("amount", { precision: 18, scale: 2 }).notNull(),
    currency: text("currency").default("UZS").notNull(),
    /** Откуда операция: click | payme | uzum | bank | cash | manual. */
    source: text("source").default("manual").notNull(),
    /** Идентификатор транзакции у источника. Пусто у ручных записей. */
    extId: text("ext_id"),
    /** Назначение человеческими словами: «инкассация автомата», «оплата HELI». */
    purpose: text("purpose"),
    /** Связь с инкассацией: наличные из автомата → сдача в банк. */
    collectionId: uuid("collection_id").references(() => collection.id),
    /**
     * Кассовый символ банка — признак вида операции для нал.-безнал. учёта.
     * Взносы наличной выручки помечаются `0200`. Пусто у всех операций, где
     * банк символ не присваивает (безнал, ручные записи и т.д.) — это законно.
     */
    cashSymbol: text("cash_symbol"),
    date: timestamp("date", { withTimezone: true }).notNull(),
    status: text("status").default("actual").notNull(), // planned | actual | overdue
    // ── Модель платежа — перенос из PROMACH (warehouse_payments + финзаписи
    // контракта). Донор: ~/Developer/promach; поля выбраны по анализу
    // «PROMACH_анализ_и_интеграция_globerent_finans.md», Часть B, шаг 1. ──
    /** Категория: supplier | logistics | customs | certification | sale | service | tax | other. */
    category: text("category"),
    /** Способ оплаты: bank | cash. Критично для разделения бухгалтерий (PROMACH). */
    method: text("method"),
    /** Официальная операция (банк, в бухгалтерии) или внутренний учёт (нал). */
    isOfficial: boolean("is_official").default(true).notNull(),
    /**
     * Курс к суму НА ДАТУ ОПЕРАЦИИ (PROMACH, миграция 083): исторические суммы
     * не «плавают» при смене курса. null — запись уже в сумах.
     */
    rate: numeric("rate", { precision: 18, scale: 4 }),
    /** Эквивалент в сумах по rate. null — запись уже в сумах. */
    amountUzs: numeric("amount_uzs", { precision: 18, scale: 2 }),
    /** Контрагент из реестра (карточка contractor). */
    counterpartyId: uuid("counterparty_id").references(() => entity.id),
    /** Имя контрагента словами — когда карточки в реестре ещё нет. */
    counterparty: text("counterparty"),
    /** Номер документа: счёт, платёжка, инвойс. */
    docNo: text("doc_no"),
    /** Срок оплаты (для planned) — по нему считается агинг и «к сроку ≤ 7 дней». */
    dueDate: date("due_date"),
    /** Когда фактически оплачено. null у планов. */
    paidAt: timestamp("paid_at", { withTimezone: true }),
    /** Основание платежа: UZS-договор. Оплаченность договора считается по этой связке. */
    contractId: uuid("contract_id").references(() => grContract.id),
    /** Основание платежа: импортный контракт (оплаты заводу по графику). */
    importContractId: uuid("import_contract_id").references(() => grImportContract.id),
    /** Привязка к единице техники: из этих записей считается её себестоимость. */
    unitId: uuid("unit_id").references(() => globerentUnit.id),
    createdAt: createdAt(),
  },
  (t) => [
    index("money_flow_org_date_idx").on(t.orgId, t.date),
    // Защита от двойного импорта: одна транзакция источника — одна запись.
    // Частичный индекс: ручные записи (ext_id пуст) под ограничение не попадают.
    uniqueIndex("money_flow_source_ext_key")
      .on(t.source, t.extId)
      .where(sql`${t.extId} is not null`),
    index("money_flow_collection_idx").on(t.collectionId),
    // Агинг и «к сроку»: выборка открытых обязательств по сроку.
    index("money_flow_due_idx").on(t.domain, t.status, t.dueDate),
    index("money_flow_counterparty_idx").on(t.counterpartyId),
    index("money_flow_contract_idx").on(t.contractId),
    index("money_flow_unit_idx").on(t.unitId),
  ],
);

// ── contract: UZS-договор купли-продажи (GLOBERENT, перенос contracts PROMACH) ──
// Операционная сущность с потоком записей (платежи → money_flow, акты, статусы),
// поэтому отдельная таблица, а не EAV-карточка (SPEC_UZS_CONTRACTS §9.1).
// Реквизиты покупателя — snapshot на момент подписания: за справочником не «плывут».
export const grContract = pgTable(
  "contract",
  {
    id: id(),
    orgId: uuid("org_id").references(() => org.id),
    domain: domainEnum("domain").default("globerent").notNull(),
    /** Номер без суффикса «/ОП» — суффикс существует только в рендере документа. */
    contractNo: text("contract_no").notNull(),
    contractDate: date("contract_date").notNull(),
    /** Покупатель — карточка реестра (contractor). nullable как у донора. */
    clientId: uuid("client_id").references(() => entity.id),
    /** Snapshot реквизитов покупателя: name, director, inn, address, account, bank, mfo, oked, nds, phone. */
    buyer: jsonb("buyer").default({}).notNull(),
    /** Продавец — наша карточка own_company (замена SELLER-хардкода донора). */
    sellerCompanyId: uuid("seller_company_id").references(() => entity.id),
    totalWithVat: numeric("total_with_vat", { precision: 18, scale: 2 }).notNull(),
    totalVat: numeric("total_vat", { precision: 18, scale: 2 }).notNull(),
    /** 100 | partial | install | post. */
    payType: text("pay_type"),
    warranty: text("warranty"),
    deliveryDays: integer("delivery_days"),
    /** Позиции: [{equipmentId: uuid|null, name, unit, qty, price}] — структурные, без парсинга строк. */
    items: jsonb("items").default([]).notNull(),
    /**
     * Параметры документа (payDays, prepayPct, installMonths, installInterest,
     * installFirstDate, partialTranches, penaSeller/Buyer/Max, copies, warrantyMode):
     * у донора жили только в state формы — документ был невоспроизводим.
     */
    docParams: jsonb("doc_params").default({}).notNull(),
    status: text("status").default("active").notNull(), // active | closed | cancelled
    /** Агент-посредник (contractor c ролью agent). Snapshot комиссии — на договоре. */
    agentId: uuid("agent_id").references(() => entity.id),
    agentCommissionAmount: numeric("agent_commission_amount", { precision: 18, scale: 2 }),
    agentCommissionCurrency: text("agent_commission_currency"),
    createdFrom: text("created_from"),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("ux_contract_org_no").on(t.orgId, t.contractNo),
    index("contract_org_date_idx").on(t.orgId, t.contractDate),
    index("contract_status_idx").on(t.status),
    index("contract_client_idx").on(t.clientId),
  ],
);

// ── contract_act: акт приёма-передачи по договору (партиями, 1 договор → N актов) ──
export const contractAct = pgTable(
  "contract_act",
  {
    id: id(),
    /** НЕ cascade: акты не исчезают вместе с договором (у донора исчезали). */
    contractId: uuid("contract_id")
      .references(() => grContract.id)
      .notNull(),
    actNo: text("act_no").notNull(),
    actDate: date("act_date").notNull(),
    /** Какие позиции сданы: [{equipmentId: uuid|null, name}] — замена vehicle_ids INTEGER[] без FK. */
    itemRefs: jsonb("item_refs").default([]).notNull(),
    signedBySeller: text("signed_by_seller"),
    signedByBuyer: text("signed_by_buyer"),
    notes: text("notes"),
    createdBy: text("created_by"),
    createdAt: createdAt(),
  },
  (t) => [index("contract_act_contract_idx").on(t.contractId)],
);

// ── gr_import_contract: импортный контракт с заводом (перенос import_contracts PROMACH) ──
// Контур односторонний: портала поставщика нет, менеджер отмечает за завод
// (решение сверки переноса — HELI в систему не логинится). Материализация
// спецификации создаёт единицы globerent_unit; lifecycle — монотонный синк.
export const grImportContract = pgTable(
  "gr_import_contract",
  {
    id: id(),
    orgId: uuid("org_id").references(() => org.id),
    domain: domainEnum("domain").default("globerent").notNull(),
    contractNo: text("contract_no").notNull(),
    contractDate: date("contract_date").notNull(),
    /** Завод-поставщик — карточка contractor с ролью supplier. */
    supplierId: uuid("supplier_id").references(() => entity.id),
    currency: text("currency").default("USD").notNull(),
    totalAmount: numeric("total_amount", { precision: 18, scale: 2 }).notNull(),
    /** Позиции: [{modelId: uuid|null, name, qty, price}] в валюте контракта. */
    items: jsonb("items").default([]).notNull(),
    /** for_stock | under_client | for_sum_contract (требует saleContractId). */
    purpose: text("purpose").default("for_stock").notNull(),
    /** UZS-договор продажи, под который везём (purpose=for_sum_contract). */
    saleContractId: uuid("sale_contract_id").references(() => grContract.id),
    /** Договорной статус (односторонний): draft | in_progress | completed | cancelled. */
    status: text("status").default("draft").notNull(),
    /** Физический lifecycle (draft…closed) — монотонный синк от единиц. */
    lifecycleStatus: text("lifecycle_status").default("draft").notNull(),
    // График оплат заводу (миграция 064 донора): предоплата + баланс.
    prepaymentAmount: numeric("prepayment_amount", { precision: 18, scale: 2 }),
    prepaymentDueDate: date("prepayment_due_date"),
    prepaymentPaidAt: timestamp("prepayment_paid_at", { withTimezone: true }),
    balanceAmount: numeric("balance_amount", { precision: 18, scale: 2 }),
    balanceDueDate: date("balance_due_date"),
    balancePaidAt: timestamp("balance_paid_at", { withTimezone: true }),
    notes: text("notes"),
    createdFrom: text("created_from"),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    // Уникальность номера в паре с поставщиком — правило донора.
    uniqueIndex("ux_import_contract_supplier_no").on(t.supplierId, t.contractNo),
    index("gr_import_contract_org_idx").on(t.orgId, t.contractDate),
    index("gr_import_contract_lifecycle_idx").on(t.lifecycleStatus),
  ],
);

// ── globerent_unit: единица техники (перенос warehouse_vehicles PROMACH) ──
// Операционный конвейер: 17 статусов от заявки до передачи клиенту,
// fromStatuses-переходы — в shared/globerent/unit-status (единый словарь).
// История статусов — audit_log + event (решение сверки: без отдельной таблицы).
export const globerentUnit = pgTable(
  "globerent_unit",
  {
    id: id(),
    orgId: uuid("org_id").references(() => org.id),
    domain: domainEnum("domain").default("globerent").notNull(),
    /** Складской номер: WH-0001. Генерируется сервисом в транзакции. */
    code: text("code").notNull(),
    /** Модель каталога (entity equipment_model). */
    modelId: uuid("model_id").references(() => entity.id),
    /** Название единицы словами (модель + год) — живёт и без карточки каталога. */
    name: text("name").notNull(),
    year: integer("year"),
    /** VIN появляется при привязке инвойса; до того NULL. */
    vin: text("vin"),
    status: text("status").default("NEW_REQUEST").notNull(),
    /** Стадия продажи — надстройка; NULL = продажа не начата. */
    salesStage: text("sales_stage"),
    lostReason: text("lost_reason"),
    salesPrice: numeric("sales_price", { precision: 18, scale: 2 }),
    /** Покупатель (contractor) и договор — связи по FK, не по имени. */
    clientId: uuid("client_id").references(() => entity.id),
    contractId: uuid("contract_id").references(() => grContract.id),
    /** Импортный контракт, из которого единица материализована. */
    importContractId: uuid("import_contract_id").references(() => grImportContract.id),
    /** Дата прихода на склад. */
    arrivalDate: date("arrival_date"),
    /** Таможенное оформление: тип/номер/дата последней ГТД. */
    declarationType: text("declaration_type"),
    declarationNumber: text("declaration_number"),
    declarationDate: date("declaration_date"),
    transportCompany: text("transport_company"),
    notes: text("notes"),
    createdFrom: text("created_from"),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("ux_globerent_unit_code").on(t.orgId, t.code),
    index("globerent_unit_status_idx").on(t.orgId, t.status),
    index("globerent_unit_contract_idx").on(t.contractId),
    // VIN уникален среди заполненных: одна физическая машина — одна карточка.
    uniqueIndex("ux_globerent_unit_vin")
      .on(t.vin)
      .where(sql`vin is not null and vin <> ''`),
  ],
);

// ── gr_preorder: предзаказ техники (перенос pre_orders PROMACH, 8 статусов) ──
export const grPreorder = pgTable(
  "gr_preorder",
  {
    id: id(),
    orgId: uuid("org_id").references(() => org.id),
    domain: domainEnum("domain").default("globerent").notNull(),
    /** Номер PO-#### — генерируется сервисом в транзакции. */
    code: text("code").notNull(),
    /** Модель каталога (entity equipment_model). */
    modelId: uuid("model_id").references(() => entity.id),
    name: text("name").notNull(),
    qty: integer("qty").default(1).notNull(),
    /** Клиент, под которого везём (пусто — на склад). */
    clientId: uuid("client_id").references(() => entity.id),
    supplierId: uuid("supplier_id").references(() => entity.id),
    /** Ссылка на контракт завода — ОБЯЗАТЕЛЬНА при переходе в ordered (правило донора). */
    contractRef: text("contract_ref"),
    factoryPriceUsd: numeric("factory_price_usd", { precision: 18, scale: 2 }),
    promisedDeliveryDate: date("promised_delivery_date"),
    status: text("status").default("draft").notNull(),
    /** Причина отмены — обязательна (правило донора). */
    cancelledReason: text("cancelled_reason"),
    notes: text("notes"),
    createdBy: text("created_by"),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("ux_gr_preorder_code").on(t.orgId, t.code),
    index("gr_preorder_status_idx").on(t.orgId, t.status),
  ],
);

// ── unit_reserve: резерв единицы под клиента (максимум один активный) ──
export const unitReserve = pgTable(
  "unit_reserve",
  {
    id: id(),
    unitId: uuid("unit_id")
      .references(() => globerentUnit.id)
      .notNull(),
    clientId: uuid("client_id").references(() => entity.id),
    /** До какой даты держим. Просрочка снимается expire-проходом при чтении. */
    endDate: date("end_date").notNull(),
    status: text("status").default("active").notNull(), // active | cancelled | expired
    note: text("note"),
    createdBy: text("created_by"),
    createdAt: createdAt(),
  },
  (t) => [
    index("unit_reserve_unit_idx").on(t.unitId),
    // Один активный резерв на единицу — правило донора, закреплённое индексом.
    uniqueIndex("ux_unit_reserve_active")
      .on(t.unitId)
      .where(sql`status = 'active'`),
  ],
);

// ── tnved_rate: ставки ТН ВЭД для расчёта растаможки (GLOBERENT, донор PROMACH) ──
// Отдельная таблица, не реестр: ставки — числовая основа калькулятора, им нужны
// NUMERIC-типизация и JOIN; EAV-attrs это ломает (решение сверки переноса).
// Ставки в долях: 0.05 = 5%. valid_from — историчность, которой у донора не было.
export const tnvedRate = pgTable(
  "tnved_rate",
  {
    id: id(),
    /** Код ТН ВЭД: 8429519900. Не уникален — разные товары под одним кодом. */
    code: text("code").notNull(),
    nameRu: text("name_ru").notNull(),
    /** autotransport | spec_tech — у HELI почти всё spec_tech. */
    vehicleCategory: text("vehicle_category").default("spec_tech").notNull(),
    /** Импортная пошлина, доля (0.05 = 5%). */
    importDutyRate: numeric("import_duty_rate", { precision: 7, scale: 4 }).default("0").notNull(),
    /** Сбор за таможенное оформление, доля (стандарт 0.002 = 0.2%). */
    customsFeeRate: numeric("customs_fee_rate", { precision: 7, scale: 4 })
      .default("0.002")
      .notNull(),
    exciseRate: numeric("excise_rate", { precision: 7, scale: 4 }).default("0").notNull(),
    vatRate: numeric("vat_rate", { precision: 7, scale: 4 }).default("0.12").notNull(),
    /** Утильсбор: сколько БРВ (0 — не облагается). */
    utilizationBrvCount: integer("utilization_brv_count").default(0).notNull(),
    /** Доп. пошлина за см³ двигателя, USD (3.36 у тягачей; 0 у погрузчиков). */
    extraDutyPerCcUsd: numeric("extra_duty_per_cc_usd", { precision: 10, scale: 4 })
      .default("0")
      .notNull(),
    /** gibdd — авто, gostechnadzor — спецтехника (влияет на регистрацию). */
    registrationType: text("registration_type").default("gostechnadzor").notNull(),
    /** Дефолт сертификации: нал / безнал (может быть пусто). */
    certCashDefaultUzs: numeric("cert_cash_default_uzs", { precision: 12, scale: 2 }),
    certBankDefaultUzs: numeric("cert_bank_default_uzs", { precision: 12, scale: 2 }),
    /** Валидация перед расчётом (Phase 15.22 донора): диапазон массы брутто. */
    grossMassMinKg: integer("gross_mass_min_kg"),
    grossMassMaxKg: integer("gross_mass_max_kg"),
    /** CSV допустимых типов двигателя: "diesel,electric". Пусто — любой. */
    engineTypeConstraint: text("engine_type_constraint"),
    isActive: boolean("is_active").default(true).notNull(),
    notes: text("notes"),
    /** С какой даты действует ставка (YYYY-MM-DD). */
    validFrom: date("valid_from"),
    setBy: text("set_by"),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("tnved_rate_code_idx").on(t.code), index("tnved_rate_active_idx").on(t.isActive)],
);

// ── brv_value: базовая расчётная величина РУз по датам (утильсбор = БРВ × count) ──
export const brvValue = pgTable(
  "brv_value",
  {
    id: id(),
    valueUzs: numeric("value_uzs", { precision: 12, scale: 2 }).notNull(),
    /** Действует с даты (YYYY-MM-DD). Актуальная — последняя по valid_from ≤ сегодня. */
    validFrom: date("valid_from").notNull(),
    note: text("note"),
    setBy: text("set_by"),
    createdAt: createdAt(),
  },
  (t) => [index("brv_value_from_idx").on(t.validFrom)],
);

// ── fx_rate: курс валют к суму — ручной ввод владельца, история сохраняется ──
// Перенос паттерна exchange-rates.ts PROMACH без внешнего источника: сначала
// ручной override (он в PROMACH был страховкой, у нас — основной путь),
// источник курса ЦБ РУз можно добавить позже тем же интерфейсом.
// История нужна аудиту: «какой курс действовал на дату платежа».
export const fxRate = pgTable(
  "fx_rate",
  {
    id: id(),
    /** Валюта, курс которой задан к суму: USD | CNY | EUR | RUB. */
    currency: text("currency").notNull(),
    /** Сколько сумов за единицу валюты. */
    rate: numeric("rate", { precision: 18, scale: 4 }).notNull(),
    /** Откуда курс: manual | cbu (задел под ЦБ РУз). */
    source: text("source").default("manual").notNull(),
    note: text("note"),
    setBy: text("set_by"),
    createdAt: createdAt(),
  },
  (t) => [index("fx_rate_currency_idx").on(t.currency, t.createdAt)],
);

// ── note: заметки и знания (вход для knowledge-curator) ──
export const note = pgTable("note", {
  id: id(),
  title: text("title"),
  body: text("body").notNull(),
  entityId: uuid("entity_id").references(() => entity.id),
  tags: jsonb("tags").default([]).notNull(),
  createdAt: createdAt(),
});

// ── audit_log: кто/что/когда, включая действия агентов ──
export const auditLog = pgTable(
  "audit_log",
  {
    id: id(),
    actorKind: actorKindEnum("actor_kind").notNull(),
    actorRef: text("actor_ref"),
    action: text("action").notNull(),
    target: text("target"),
    before: jsonb("before"),
    after: jsonb("after"),
    ts: timestamp("ts", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("audit_log_ts_idx").on(t.ts)],
);

// ── agent: настройки агентов (карточка агента в панели) ──
// Раньше настройки жили только в файлах внутри образа — правки владельца
// слетали бы при каждом обновлении. Здесь они переживают пересборку.
// Паспорта-файлы остаются НАЧАЛЬНЫМ сидом: первый запуск переносит их сюда.
export const agent = pgTable(
  "agent",
  {
    id: id(),
    /** Машинное имя (vendhub-ops). По нему агент связан с журналом и согласованиями. */
    name: text("name").notNull().unique(),
    /** Направление бизнеса; shared — общий для всех. */
    business: text("business").default("shared").notNull(),
    /** active | paused | draft | deprecated — работает ли агент. */
    status: text("status").default("paused").notNull(),
    description: text("description"),
    /** Зачем агент нужен — владелец должен видеть это словами. */
    mission: text("mission"),
    /** Чего агент НЕ делает: границы важнее возможностей. */
    nonGoals: jsonb("non_goals").default([]).notNull(),
    /** Уровень самостоятельности по умолчанию (T0…T4). */
    autonomyDefault: approvalTierEnum("autonomy_default").default("T1").notNull(),
    /** Навыки агента: ["monitor-stock", ...]. */
    skills: jsonb("skills").default([]).notNull(),
    /** Расписания: [{cron, skill}]. Меняются целиком при сохранении карточки. */
    schedule: jsonb("schedule").default([]).notNull(),
    /** Дневной потолок трат, USD. */
    budgetPerDayUsd: numeric("budget_per_day_usd", { precision: 10, scale: 2 }),
    /** Что делать при исчерпании бюджета: pause | downgrade | ask. */
    budgetOnExceeded: text("budget_on_exceeded"),
    /** Сайты, которые агенту разрешено ЧИТАТЬ: [{name, url}]. */
    webSources: jsonb("web_sources").default([]).notNull(),
    /** Навыки, которые ВСЕГДА идут через согласование (break-glass): ["skill"]. */
    breakGlass: jsonb("break_glass").default([]).notNull(),
    /** Публичные Telegram-каналы идей для чтения: ["promtjam"]. */
    ideaChannels: jsonb("idea_channels").default([]).notNull(),
    /** Архив: агент убран из работы, но его история сохранена. */
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("agent_status_idx").on(t.status)],
);

// ── system_config: глобальные тумблеры системы, редактируемые из панели ──────
// Не-секретные настройки активации (мозг/RAG/пауза/бюджет) живут в базе, а не
// только в .env: тогда владелец меняет их из интерфейса, и правка переживает
// пересборку. Приоритет над окружением задаёт читатель (значение из базы важнее
// env). Секретов здесь НЕ хранит: ключи остаются в .env (правило ТЗ).
export const systemConfig = pgTable("system_config", {
  /** Ключ тумблера (белый список на стороне Core): LLM_PROVIDER, EMBED_BASE_URL … */
  key: text("key").primaryKey(),
  /** Значение строкой. Пусто/нет строки → тумблер берётся из env/дефолта. */
  value: text("value").notNull(),
  /** Кто менял (владелец из панели) — для журналируемости. */
  updatedBy: text("updated_by"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

// ── Вендинг-операции (ТЗ «Вендинг-операции», §4) ─────────────────────────────
// Перенос Ourvend-скрипта в продукт. Машины и товары живут в общем реестре
// (entity), склад — в stock_movement; здесь — вендинг-специфика: слоты с
// ВМЕСТИМОСТЬЮ (её нет в machine_stock), снапшоты, продажи за период, прайс и
// алиасы имён вендора. Числа Ourvend приходят строками — в базе храним числами.

export const vendingCategoryEnum = pgEnum("vending_category", ["drink", "snack", "other"]);
export const vendingAliasSourceEnum = pgEnum("vending_alias_source", [
  "ourvend",
  "warehouse",
  "manual",
]);
export const vendingSyncStatusEnum = pgEnum("vending_sync_status", [
  "running",
  "success",
  "partial",
  "failed",
]);
/** Жизненный цикл накладной закупа: одобрена → заказана → принята | отменена. */
export const vendingOrderStatusEnum = pgEnum("vending_order_status", [
  "approved",
  "ordered",
  "received",
  "cancelled",
]);

/** Справочник товаров вендинга: прайс и кратность (Приложение А ТЗ). */
export const vendingProduct = pgTable("vending_product", {
  id: id(),
  /** Каноническое имя товара. */
  name: text("name").notNull().unique(),
  category: vendingCategoryEnum("category").default("other").notNull(),
  /** Закупочная цена за единицу, сум. Пусто → в сумму закупа не входит. */
  purchasePrice: numeric("purchase_price", { precision: 10, scale: 2 }),
  /**
   * Эталон витрины (слово владельца), сум за единицу — R-P5b-6.
   *
   * ФАКТ витрины в базе не хранится и храниться не должен: он выводится из
   * продаж (`sale.amount / sale.qty` за окно). Здесь лежит то, чего в продажах
   * нет и быть не может, — сколько владелец РЕШИЛ брать за товар. Без второго
   * операнда отчёт «разрыв витрины» давал бы ноль строк не потому, что
   * расхождений нет, а потому что сравнивать не с чем.
   *
   * CHECK («sale_price» > 0) живёт в SQL миграции 0068, а не в этой схеме —
   * по тем же соображениям, что у `fixedPurchaseQty` ниже.
   */
  salePrice: numeric("sale_price", { precision: 12, scale: 2 }),
  /**
   * Кратность закупки: напитки 12, снеки 10 (решение владельца 02.08.2026).
   * CHECK («pack_size» > 0) живёт в SQL миграции 0066, а не в drizzle-схеме —
   * см. `fixedPurchaseQty` ниже.
   */
  packSize: integer("pack_size").default(1).notNull(),
  /** «Убрано из закупки» (П5a): дефицит закрываем только складом, не покупаем. Правило владельца 24.08.2026. */
  excludedFromPurchase: boolean("excluded_from_purchase").default(false).notNull(),
  /**
   * Фикс-количество закупа при дефиците, без округления до блока (СуперКонтик 50,
   * Snickers 48). NULL — обычное округление.
   *
   * CHECK (NULL или > 0) стоит в базе — в SQL миграции `0066_purchase_rules.sql`,
   * НЕ в этой схеме. Осознанно: `check()` в drizzle-схеме заставил бы генератор
   * выпустить ещё одну миграцию (0067) ради ограничения, которое 0066 уже
   * ставит, и снапшот разошёлся бы с файлом. При правке ограничения менять
   * SQL 0066 (пока не применена) или заводить новую миграцию.
   */
  fixedPurchaseQty: integer("fixed_purchase_qty"),
  isActive: boolean("is_active").default(true).notNull(),
  createdAt: createdAt(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

/**
 * Алиасы имён: строка ровно как в Ourvend/рукописном листе → товар. Только
 * ТОЧНЫЕ соответствия (нечёткое сопоставление по подстроке в продукт не
 * переносим — оно даёт неверную цену на новом похожем имени).
 */
export const vendingAlias = pgTable(
  "vending_alias",
  {
    id: id(),
    productId: uuid("product_id")
      .references(() => vendingProduct.id, { onDelete: "cascade" })
      .notNull(),
    alias: text("alias").notNull().unique(),
    source: vendingAliasSourceEnum("source").default("ourvend").notNull(),
  },
  (t) => [index("vending_alias_alias_idx").on(t.alias)],
);

/** Актуальная планограмма: слот → товар → вместимость/остаток (SoltInfo). */
export const machineSlot = pgTable(
  "machine_slot",
  {
    id: id(),
    /** Машина в реестре, если сопоставлена. */
    machineId: uuid("machine_id").references(() => entity.id),
    /** MuMachineID Ourvend (серийный). */
    machineSerial: text("machine_serial").notNull(),
    /** SiCoilId — номер слота (пружины). */
    coilId: text("coil_id").notNull(),
    /** Имя товара как в вендоре; пусто → слот не назначен. */
    productName: text("product_name"),
    productId: uuid("product_id").references(() => vendingProduct.id),
    capacity: integer("capacity").default(0).notNull(),
    quantity: integer("quantity").default(0).notNull(),
    /** Прошёл ли валидацию 0 < capacity ≤ 100. */
    isValid: boolean("is_valid").default(false).notNull(),
    syncedAt: timestamp("synced_at", { withTimezone: true }).notNull(),
  },
  (t) => [uniqueIndex("machine_slot_key").on(t.machineSerial, t.coilId)],
);

/** История слотов: пишется каждым сбором. По ней считается реальный расход. */
export const slotSnapshot = pgTable(
  "slot_snapshot",
  {
    id: id(),
    machineSerial: text("machine_serial").notNull(),
    coilId: text("coil_id").notNull(),
    productName: text("product_name"),
    capacity: integer("capacity").default(0).notNull(),
    quantity: integer("quantity").default(0).notNull(),
    capturedAt: timestamp("captured_at", { withTimezone: true }).notNull(),
  },
  (t) => [index("slot_snapshot_machine_captured_idx").on(t.machineSerial, t.capturedAt)],
);

/** Продажи по товарам за период (для прогноза и пометки «нет продаж»). */
export const productSale = pgTable(
  "product_sale",
  {
    id: id(),
    machineSerial: text("machine_serial").notNull(),
    /**
     * Карточка автомата из реестра.
     *
     * Nullable намеренно: автомат появляется в Ourvend раньше, чем карточка в
     * реестре — так и было с 2508160355 и 2508160358. Продажа без карточки
     * должна лечь и подождать, а не быть отвергнутой.
     */
    machineId: uuid("machine_id").references(() => entity.id),
    productName: text("product_name").notNull(),
    productId: uuid("product_id").references(() => vendingProduct.id),
    periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
    periodEnd: timestamp("period_end", { withTimezone: true }).notNull(),
    quantity: integer("quantity").default(0).notNull(),
    capturedAt: timestamp("captured_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    index("product_sale_machine_captured_idx").on(t.machineSerial, t.capturedAt),
    // Ключ идемпотентности батча: повторная доставка того же сбора (тот же
    // capturedAt) по тому же автомату/товару — апдейт, а не вторая строка,
    // иначе latestSold7() задваивает продажи и прогноз (найдено внешним
    // аудитом, P1).
    uniqueIndex("product_sale_batch_key").on(t.machineSerial, t.productName, t.capturedAt),
  ],
);

/** Продажи автомата за период (деньги и чеки). */
export const machineSale = pgTable(
  "machine_sale",
  {
    id: id(),
    machineSerial: text("machine_serial").notNull(),
    /** Карточка автомата из реестра. Nullable — см. product_sale. */
    machineId: uuid("machine_id").references(() => entity.id),
    periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
    periodEnd: timestamp("period_end", { withTimezone: true }).notNull(),
    totalAmount: numeric("total_amount", { precision: 14, scale: 2 }).default("0").notNull(),
    totalCount: integer("total_count").default(0).notNull(),
    capturedAt: timestamp("captured_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    // Ключ идемпотентности батча — та же причина, что и у product_sale выше.
    uniqueIndex("machine_sale_batch_key").on(t.machineSerial, t.capturedAt),
  ],
);

/**
 * Остаток центрального склада вендинга по товару (§5.4). Одна строка на товар —
 * текущий баланс, вводится инвентаризацией (перезапись, а не леджер): владелец
 * пересчитывает склад и вводит факт, как со слотами автоматов. По этому остатку
 * закуп считает `buy = max(0, потребность − склад)`, а не «весь дефицит».
 */
export const vendingStock = pgTable("vending_stock", {
  id: id(),
  /** Каноническое имя товара (как в vending_product / слотах). */
  productName: text("product_name").notNull().unique(),
  productId: uuid("product_id").references(() => vendingProduct.id),
  quantity: integer("quantity").default(0).notNull(),
  /** Когда пересчитали склад (ISO приходит от инвентаризации). */
  countedAt: timestamp("counted_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

/**
 * Вид автомата. Задаётся при заведении карточки, а не выводится из косвенных
 * признаков (WAREHOUSE_SPEC §4.0).
 *
 * До этой таблицы «кофейный ли автомат» определялось наличием привязки
 * к кофейной точке. На боевом парке это дало осечку сразу: три автомата
 * с кофейными серийниками привязки не имели и попали в «прочие» — не потому,
 * что они прочие, а потому что связь никто не завёл. Инференс ломается всегда
 * одинаково: признак заводился для другой цели, и в день, когда его забыли
 * проставить, система молча делает неверный вывод.
 */
export const machineKindEnum = pgEnum("machine_kind", [
  "coffee", // кофейный: бункеры, миксер, фильтр воды
  "snack", // снек: спирали
  "drink", // напитки: холодильный блок
  "combo", // снек + напитки в одном корпусе
  "other", // не размечен либо не подходит ни под одно
]);

/**
 * Состояние автомата: работает он сейчас или нет.
 *
 * Отдельно от вида (`machine_kind`) намеренно: вид — что это за автомат,
 * состояние — работает ли он. Кофейный автомат в ремонте остаётся кофейным.
 */
export const machineStatusEnum = pgEnum("machine_status", ["in_service", "warehouse", "repair"]);

/**
 * Карточка автомата — то, что относится ТОЛЬКО к автоматам.
 *
 * Отдельная таблица, а не колонка в `entity` и не ключ в `attrs`: `entity`
 * общая для контрагентов, договоров и объектов, и вид автомата там был бы
 * колонкой, пустой у девяти строк из десяти. `attrs` уже проходили с
 * координатами — строки без проверки, из которых потом сделали `geo_point`.
 *
 * Сюда же лягут ответы на открытые вопросы полевого ТЗ, когда они появятся:
 * гарантия до (вопрос 4) и наличие механического счётчика (вопрос 10).
 */
export const machineCard = pgTable("machine_card", {
  entityId: uuid("entity_id")
    .primaryKey()
    .references(() => entity.id, { onDelete: "cascade" }),
  kind: machineKindEnum("kind").notNull(),
  /**
   * Работает ли автомат. Умолчание `in_service`: парк работает, и молчаливое
   * исключение автомата из обслуживания опаснее лишней задачи (см.
   * `DEFAULT_MACHINE_STATUS` в @mydon/shared).
   */
  status: machineStatusEnum("status").default("in_service").notNull(),
  /** Почему автомат не в строю: «отправлен в ремонт 05.08», номер заявки. */
  statusNote: text("status_note"),
  /** Когда состояние менялось последний раз — «в ремонте с …» без чтения журнала. */
  statusChangedAt: timestamp("status_changed_at", { withTimezone: true }),
  note: text("note"),
  createdBy: text("created_by"),
  /**
   * Кто поставил ТЕКУЩИЙ вид.
   *
   * `created_by` помнит только того, кто завёл карточку, и при смене вида не
   * меняется — а заводит карточки массовый прогон. Без этой колонки любая
   * карточка вечно выглядит проставленной инструментом, даже там, где вид
   * назвал владелец: обещание «через полгода будет видно, что выбрал человек»
   * (docs/REGISTRY_CLEANUP.md) держалось только на `audit_log`, куда никто не
   * смотрит из карточки.
   */
  updatedBy: text("updated_by"),
  createdAt: createdAt(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

/**
 * `vending_refill` — ФАКТ заливки автомата сотрудником (WAREHOUSE_SPEC §4.1).
 *
 * Своя таблица, а не апдейт `machine_slot`, по одной причине: зеркало Ourvend
 * перезаписывается кроном `0 * /3 * * *`, и наша запись исчезла бы без следа
 * и без ошибки. `slot_snapshot` тоже не подходит — это история ЗЕРКАЛА (что
 * показал автомат), а здесь история НАША (что сделал человек). Смешав их,
 * невозможно отличить факт от отражения.
 *
 * Расхождение «доложил 10, автомат показал +8» здесь не хранится: оно
 * считается на чтении по `slot_snapshot` до и после `performed_at`. Хранить
 * его значило бы зафиксировать разницу на момент, когда сравнивать было ещё
 * не с чем.
 */
export const vendingRefill = pgTable(
  "vending_refill",
  {
    id: id(),
    /** Карточка автомата, если сопоставлена. */
    machineId: uuid("machine_id").references(() => entity.id),
    /** MuMachineID Ourvend — ключ, по которому живёт зеркало. */
    machineSerial: text("machine_serial").notNull(),
    /** Слот. NULL — заправлял автомат целиком, по товарам. */
    coilId: text("coil_id"),
    productId: uuid("product_id").references(() => vendingProduct.id),
    /**
     * Имя товара на момент заливки. Рядом с `product_id` намеренно — тот же
     * приём, что в `machine_slot`: справочник живой, товар переименуют, и
     * отчёт за прошлый месяц не должен менять содержание задним числом.
     */
    productName: text("product_name").notNull(),
    qty: integer("qty").notNull(),
    personId: uuid("person_id").references(() => person.id),
    taskId: uuid("task_id").references(() => task.id),
    performedAt: timestamp("performed_at", { withTimezone: true }).notNull(),
    /**
     * Ключ идемпотентности мастера, а не «(автомат, слот, минута)».
     * Плохая связь в подвале даёт двойное нажатие «Готово»; ключ по времени
     * ловит дубль, только если оба нажатия попали в одну минуту, и при этом
     * ломает законное «залил тот же слот дважды подряд, не влезло сразу».
     */
    clientKey: text("client_key").notNull(),
    /** Откуда факт: bot | panel. */
    source: text("source").default("bot").notNull(),
    note: text("note"),
    createdBy: text("created_by"),
    createdAt: createdAt(),
  },
  (t) => [
    index("vending_refill_machine_idx").on(t.machineSerial, desc(t.performedAt)),
    index("vending_refill_person_idx").on(t.personId, desc(t.performedAt)),
    uniqueIndex("vending_refill_client_key").on(t.clientKey),
    check("vending_refill_qty_positive", sql`${t.qty} > 0`),
  ],
);

/**
 * Событие детектора по снимкам (П4): детектор сравнивает два соседних снимка
 * слотов автомата (`slot_snapshot`) и там, где остаток вырос, фиксирует
 * заливку — без участия оператора. `windowFrom`/`windowTo` — границы окна
 * сравнения, `slots` — снимок изменений по каждой пружине (что, сколько
 * было/стало/добавлено), `units` — сумма `delta` по всем позициям окна.
 *
 * `unique(serial, window_to)` — идемпотентность прогона: повторный запуск
 * детектора по тому же автомату и тому же концу окна не плодит дубль события.
 *
 * `matchedRefillId` — если в окне ±3 ч нашлась запись оператора
 * (`vending_refill`), событие считается подтверждённым; NULL — заливка,
 * которую детектор увидел, а мастер не отчитался (или отчитался мимо окна).
 */
export const vendingRefillEvent = pgTable(
  "vending_refill_event",
  {
    id: id(),
    /** MuMachineID Ourvend — тот же ключ, что у vending_refill.machineSerial. */
    machineSerial: text("machine_serial").notNull(),
    /** Карточка автомата, если сопоставлена. */
    machineId: uuid("machine_id").references(() => entity.id),
    windowFrom: timestamp("window_from", { withTimezone: true }).notNull(),
    windowTo: timestamp("window_to", { withTimezone: true }).notNull(),
    /** Сумма delta по всем позициям окна — сколько единиц залито за прогон. */
    units: integer("units").notNull(),
    slots: jsonb("slots")
      .$type<{ coilId: string; product: string; before: number; after: number; delta: number }[]>()
      .notNull(),
    /** Запись оператора, сопоставленная по окну ±3 ч. NULL — заливка без отчёта. */
    matchedRefillId: uuid("matched_refill_id").references(() => vendingRefill.id),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("vending_refill_event_serial_to").on(t.machineSerial, t.windowTo),
    index("vending_refill_event_to_idx").on(t.windowTo),
  ],
);

/**
 * Накладная закупа (§5.7): материализуется, когда владелец ОДОБРИЛ заявку.
 * Снимок позиций и сумм берётся из payload одобренной заявки — цифры фиксируются
 * на момент решения, а не пересчитываются задним числом. Одна накладная на
 * одобрение (approval_id уникален).
 */
export const vendingPurchaseOrder = pgTable("vending_purchase_order", {
  id: id(),
  /** Одобренная заявка-источник (approval). */
  approvalId: uuid("approval_id")
    .references(() => approval.id)
    .notNull()
    .unique(),
  status: vendingOrderStatusEnum("status").default("approved").notNull(),
  /** Позиции закупа как в момент одобрения: [{product, order, buy, price, …}]. */
  positions: jsonb("positions").default([]).notNull(),
  totalBuy: integer("total_buy").default(0).notNull(),
  totalOrder: integer("total_order").default(0).notNull(),
  /** Суммы, сум. Держим и точную (по нехватке), и с округлением до упаковок. */
  costExact: numeric("cost_exact", { precision: 14, scale: 2 }).default("0").notNull(),
  costRounded: numeric("cost_rounded", { precision: 14, scale: 2 }).default("0").notNull(),
  createdBy: text("created_by"),
  createdAt: createdAt(),
  /**
   * Распределение при приёмке (§5.7) — заполняется receiveOrder(), пусто
   * до приёмки. Персистентно, чтобы панель показывала его в списке
   * накладных, а не только в разовом ответе API/сообщении бота.
   */
  distributedUnits: integer("distributed_units"),
  unmatchedDistribution: jsonb("unmatched_distribution").$type<string[]>(),
  /**
   * Момент и автор приёмки. NULL у накладных, принятых до появления колонок
   * (бэкфилла нет — честнее пустота, чем выдуманное время). К последней
   * принятой за сутки привязывается фото чека из бота.
   */
  receivedAt: timestamp("received_at", { withTimezone: true }),
  receivedBy: text("received_by"),
});

/**
 * Касса закупа (§5.8): владелец пошёл на базар с наличными — сколько получил,
 * на что потратил по статьям («корзинка», «базар» — статья может повторяться,
 * например отдельно для снеков и напитков), сколько осталось. Строчная
 * арифметика уже посчитана владельцем от руки; здесь снимок статей с
 * подытогами и итоговый остаток — не леджер, одна запись на один поход.
 */
export const vendingCashSession = pgTable("vending_cash_session", {
  id: id(),
  receivedAmount: numeric("received_amount", { precision: 14, scale: 2 }).notNull(),
  /** Статьи с подытогами: [{name, lines: [{label, qty?, unitPrice?, amount}], subtotal}]. */
  categories: jsonb("categories").$type<CashCategorySummary[]>().default([]).notNull(),
  totalSpent: numeric("total_spent", { precision: 14, scale: 2 }).notNull(),
  /** receivedAmount − totalSpent. Может быть отрицательным — перерасход не скрываем. */
  remainder: numeric("remainder", { precision: 14, scale: 2 }).notNull(),
  createdBy: text("created_by"),
  createdAt: createdAt(),
});

/** Неопознанные имена товаров — на разбор менеджеру (не роняют сбор). */
export const vendingUnmatched = pgTable("vending_unmatched", {
  id: id(),
  externalName: text("external_name").notNull().unique(),
  source: vendingAliasSourceEnum("source").default("ourvend").notNull(),
  occurrences: integer("occurrences").default(1).notNull(),
  firstSeenAt: createdAt(),
  resolvedProductId: uuid("resolved_product_id").references(() => vendingProduct.id),
});

/** Журнал запусков сбора Ourvend. */
export const vendingSyncRun = pgTable("vending_sync_run", {
  id: id(),
  startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  status: vendingSyncStatusEnum("status").default("running").notNull(),
  machinesTotal: integer("machines_total").default(0).notNull(),
  machinesOk: integer("machines_ok").default(0).notNull(),
  error: text("error"),
  durationMs: integer("duration_ms"),
});

// ── Кофе-вендинг: бункеры, вес, мойка, ингредиенты ──────────────────────────
// Ручные кофемашины на точках владельца — Ourvend их не видит (нет сетевого
// сбора), поэтому весь учёт человеческий: техник обходит точки и заносит вес.
// Модель сверена с уже работающим у владельца приложением-референсом
// (vendhubunker) и портирована с трёх доноров (VendHub-OS Container/
// ContainerWeighing/WashingSchedule/Recipe, mydon-command-center
// BunkerWeighing/reconcile, mydon-agent-os refill_events/component_events) —
// везде независимо сошлись на одной и той же форме: точка → позиция бункера
// (1–8) → физический сменный контейнер («набор», 1–27, техники их
// перевешивают между точками) → вес.
//
// Тара: у каждого физического контейнера («набора») в каждой позиции свой
// пустой вес (эталон из Настроек, ~600–680г) — чистый вес ингредиента при
// заливке = filledWeight − тара(набор, позиция). Без тары зачёт возможен
// только по факту (сырой вес) — coffee-calc.ts требует тару явно, не гадает.

export const coffeeWashEventKindEnum = pgEnum("coffee_wash_event_kind", [
  "wash",
  "clean",
  "replace",
  "service",
]);

/**
 * Точка (адрес), где стоит кофемашина.
 *
 * `entityId` — связь с карточкой автомата в реестре (`entity`, type=machine):
 * у карточки есть серийник (`externalRef`), координаты и адрес («точка» в
 * attrs), поэтому кофе-точка через неё попадает на карту и в общий учёт.
 * Связь по id, не по имени — переименование ничего не рвёт. Пусто — точка
 * ещё не привязана (автоподбор по названию + ручная привязка в Настройках).
 */
/**
 * Точки, склады и мастерские — КАРТОЧКИ РЕЕСТРА, а не своя таблица.
 *
 * Была `coffee_location`; влита в `entity` миграцией 0049 с сохранением
 * идентификаторов, поэтому шесть таблиц с `location_id` просто перецелили
 * внешний ключ. Причина: у справочника не было и не могло быть своих
 * координат — на карту точка попадала через ссылку на стоящий там автомат, и
 * переименование таблицы отобрало бы у неё карту вместе с этой колонкой.
 *
 * Вид места — это `entity.type`: location | warehouse | workshop
 * (см. `PLACE_TYPES` в @mydon/shared).
 */

/** Ингредиент бункера (молоко, кофе, сахар, чай…) — canonical-имя, без алиасов (список закрытый, 8 позиций). */
export const coffeeIngredient = pgTable(
  "coffee_ingredient",
  {
    id: id(),
    name: text("name").notNull().unique(),
    unit: text("unit").default("g").notNull(),
    /** Закупочная цена за единицу `unit` (обычно за грамм), сум. Пусто — себестоимость расхода не считается (§ reconcile). */
    purchasePrice: numeric("purchase_price", { precision: 10, scale: 4 }),
    /**
     * Вес одной упаковки в граммах. Пусто — упаковки не считаем и не показываем.
     *
     * Учёт ведётся в граммах: техник сыплет сколько нужно, иногда половину пачки,
     * иногда полторы, и спрашивать «сколько упаковок» значило заставлять его
     * округлять на глаз, а потом принимать это округление за факт. Зная вес
     * пачки, упаковки считает программа — из тех же граммов, что уже взвешены.
     */
    packageWeight: integer("package_weight"),
    /**
     * Как называть единицу расфасовки: «упаковки» по умолчанию, «шт» для
     * стиков. MacCoffee идёт стиками по 20 г, и назвать стик упаковкой значит
     * показать «0,05 упаковки» там, где человек видит 50 стиков.
     */
    packageLabel: text("package_label"),
    /**
     * Мост в реестр карточек: `entity(type='ingredient')`.
     *
     * ЗАЧЕМ. Рецепты товаров уже ссылаются на карточку ингредиента
     * (`entity(product).attrs["состав"].ingredientId` = entity.id), а бункерный
     * контур — на строку этой таблицы. Пока связь держалась на совпадении имени,
     * цена из карточки не доходила до расчёта расхода: у всех 8 строк
     * `purchase_price` пуст. Колонка делает связь внешним ключом.
     *
     * Пусто — законно: значит карточки для этого ингредиента ещё нет, и цена
     * берётся из `purchase_price` (старый путь). Слияние таблиц сознательно НЕ
     * делаем: автодеплой применяет миграции без отката, и упавшая миграция
     * вешает выкатку молча и навсегда.
     */
    entityId: uuid("entity_id").references(() => entity.id),
    createdAt: createdAt(),
  },
  (t) => [
    // Одна карточка — не больше одной строки бункерного реестра. Частичный:
    // несвязанных строк (entity_id is null) может быть сколько угодно.
    //
    // Бэкфилл в 0059 создаёт индекс ДО присвоения и всё равно не падает — но
    // держится это на `name.unique()` выше: двум строкам не достаться одной
    // карточке, потому что двух строк с одним именем не бывает. Снимете
    // уникальность имени — сначала перенесите бэкфилл вперёд индекса, иначе
    // миграция упадёт дублем ключа и повесит автодеплой.
    // Зеркалит индекс из 0059; расхождение схемы и SQL приводит к тому, что
    // следующая генерация миграции попыталась бы создать его заново.
    uniqueIndex("ux_coffee_ingredient_entity")
      .on(t.entityId)
      .where(sql`entity_id is not null`),
  ],
);

/**
 * Какие ингредиенты вообще заливаются в позицию бункера 1–8 — ОДНА
 * конфигурация на все точки (машины у владельца унифицированы), не
 * per-точка. Это СПИСОК допустимых ингредиентов на позицию, не жёсткая
 * привязка одна-к-одной: например позиция 3 у владельца держит и лимонный
 * чай, и матчу — техник заправляет то, что есть на складе (Настройки →
 * теги ингредиентов с ×/+ на позицию, порт 1:1 с референсным приложением).
 * Позиция без ни одной строки — бункер не используется («Бункер 8 — Пусто»).
 */
export const coffeeBunkerConfig = pgTable(
  "coffee_bunker_config",
  {
    id: id(),
    position: integer("position").notNull(),
    ingredientId: uuid("ingredient_id")
      .references(() => coffeeIngredient.id)
      .notNull(),
    /**
     * Эталонный чистый вес заливки (без тары), г — «сколько должно получиться,
     * когда досыпали полную норму». Пусто — эталон не задан, недолив не
     * проверяем (coffee-calc.ts fillStatus() отдаёт "unknown", не выдумывает).
     */
    targetFillWeight: integer("target_fill_weight"),
  },
  (t) => [
    uniqueIndex("coffee_bunker_config_position_ingredient_key").on(t.position, t.ingredientId),
    index("coffee_bunker_config_position_idx").on(t.position),
    check("coffee_bunker_config_position_range", sql`${t.position} between 1 and 8`),
  ],
);

/**
 * Тара физического контейнера («набор» 1–27) в позиции 1–8 — эталонный
 * пустой вес, грамм. Матрица 27×8 задаётся в Настройках техником один раз
 * (калибровка); пусто — контейнер в этой позиции ещё не калибровали, чистый
 * вес посчитать нельзя, только сырой.
 */
export const coffeeContainerTare = pgTable(
  "coffee_container_tare",
  {
    id: id(),
    containerNumber: integer("container_number").notNull(),
    position: integer("position").notNull(),
    tareWeight: integer("tare_weight"),
  },
  (t) => [
    uniqueIndex("coffee_container_tare_key").on(t.containerNumber, t.position),
    check("coffee_container_tare_container_range", sql`${t.containerNumber} between 1 and 27`),
    check("coffee_container_tare_position_range", sql`${t.position} between 1 and 8`),
  ],
);

/**
 * Ежедневная заливка бункера («Ввод данных») — источник истины расхода.
 * `measuredBefore` — вес ДО досыпки (если техник взвесил остаток перед тем,
 * как досыпать) — опционально: даёт точный расход с прошлой заливки этой же
 * позиции на этой же точке; без него расход виден только по числу упаковок
 * (грубее, см. coffee-calc.ts consumedSince()). `ingredientId` — пусто, если
 * у позиции только один допустимый ингредиент (тогда очевиден из
 * `coffee_bunker_config`); обязателен, если их несколько — иначе расход по
 * конкретному ингредиенту не восстановить (см. coffee.service.ts).
 */
export const coffeeRefill = pgTable(
  "coffee_refill",
  {
    id: id(),
    locationId: uuid("location_id")
      .references(() => entity.id)
      .notNull(),
    position: integer("position").notNull(),
    /** «Набор» — номер физического контейнера, если техник его записал. */
    containerNumber: integer("container_number"),
    ingredientId: uuid("ingredient_id").references(() => coffeeIngredient.id),
    filledWeight: integer("filled_weight").notNull(),
    measuredBefore: integer("measured_before"),
    /**
     * Сколько упаковок ушло. NULL — не спрашивали (учёт идёт в граммах).
     *
     * Раньше поле было notNull с умолчанием 1, и «не спрашивали» было
     * неотличимо от «ровно одна пачка»: 1116 строк с единицей, из них
     * настоящих единиц никто назвать не может.
     */
    packageCount: integer("package_count"),
    /** «Дата» из формы — календарная дата обхода, без времени. */
    enteredDate: date("entered_date").notNull(),
    createdBy: text("created_by"),
    createdAt: createdAt(),
  },
  (t) => [
    index("coffee_refill_location_position_idx").on(t.locationId, t.position, t.enteredDate),
    check("coffee_refill_position_range", sql`${t.position} between 1 and 8`),
    check(
      "coffee_refill_container_range",
      sql`${t.containerNumber} is null or ${t.containerNumber} between 1 and 27`,
    ),
  ],
);

/**
 * Возврат набора: снятый с точки контейнер взвешивают с остатком ингредиента.
 * Формат из рабочей группы владельца — строка «позиция. набор. вес» (брутто,
 * с тарой): и позиция бункера, и номер набора известны, поэтому чистый
 * остаток = weight − тара(набор, позиция), а расход цикла = заливка − возврат
 * того же набора. `locationNote` — подсказка точки из текста сообщения
 * («Кпп остатки»), сырьём, без угадывания: связка с точкой достаётся из
 * парной заливки этого набора, а не из вольного заголовка.
 */
export const coffeeContainerReturn = pgTable(
  "coffee_container_return",
  {
    id: id(),
    position: integer("position").notNull(),
    containerNumber: integer("container_number").notNull(),
    /** Вес брутто при возврате (с тарой), г. */
    weight: integer("weight").notNull(),
    returnedDate: date("returned_date").notNull(),
    locationNote: text("location_note"),
    createdBy: text("created_by"),
    createdAt: createdAt(),
  },
  (t) => [
    index("coffee_container_return_container_idx").on(t.containerNumber, t.returnedDate),
    check("coffee_container_return_position_range", sql`${t.position} between 1 and 8`),
    check("coffee_container_return_container_range", sql`${t.containerNumber} between 1 and 27`),
    check("coffee_container_return_weight_range", sql`${t.weight} between 0 and 10000`),
  ],
);

/**
 * Размещение аппарата на точке — история с периодами (слово владельца,
 * 2026-08-03): один и тот же аппарат мог работать на разных точках, и на
 * одной точке в разное время работали разные аппараты. Открытое размещение
 * (end_date IS NULL) — «стоит сейчас»; перестановка ЗАКРЫВАЕТ старое и
 * открывает новое, история не переписывается. `entity.id` места
 * остаётся кэшем текущего аппарата — его ведёт linkLocation() там же,
 * где пишет размещения.
 */
export const machinePlacement = pgTable(
  "machine_placement",
  {
    id: id(),
    locationId: uuid("location_id")
      .references(() => entity.id)
      .notNull(),
    entityId: uuid("entity_id")
      .references(() => entity.id)
      .notNull(),
    /** null — стоял «с неизвестной даты» (бэкфилл существующих привязок). */
    startDate: date("start_date"),
    endDate: date("end_date"),
    note: text("note"),
    createdAt: createdAt(),
  },
  (t) => [
    index("machine_placement_location_idx").on(t.locationId, t.startDate),
    index("machine_placement_entity_idx").on(t.entityId, t.startDate),
    // Физика: на точке не больше одного текущего аппарата, аппарат — не
    // больше чем на одной точке. История (закрытые периоды) не ограничена.
    // «Один аппарат на месте» СНЯТ (решение владельца 07.08.2026): на точке
    // может стоять несколько аппаратов, в том числе одинаковых, а склад и
    // мастерская многоместны по определению. Обратный индекс остаётся —
    // аппарат не может стоять в двух местах сразу, это физика железа.
    uniqueIndex("machine_placement_entity_open_key")
      .on(t.entityId)
      .where(sql`${t.endDate} is null`),
    check(
      "coffee_machine_placement_dates",
      sql`${t.endDate} is null or ${t.startDate} is null or ${t.endDate} >= ${t.startDate}`,
    ),
  ],
);

/**
 * Расход воды/стаканчиков/крышек по точке за день — отдельно от бункеров
 * (они не ингредиент из бункера). Одна строка на (точка, дата) — повторный
 * ввод за тот же день правит её же, а не плодит дубли.
 */
export const coffeeConsumable = pgTable(
  "coffee_consumable",
  {
    id: id(),
    locationId: uuid("location_id")
      .references(() => entity.id)
      .notNull(),
    loggedDate: date("logged_date").notNull(),
    water: integer("water").default(0).notNull(),
    cups: integer("cups").default(0).notNull(),
    lids: integer("lids").default(0).notNull(),
    createdBy: text("created_by"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("coffee_consumable_location_date_key").on(t.locationId, t.loggedDate)],
);

/**
 * Журнал ВВОДОВ расходников — append-only события.
 *
 * Строка coffee_consumable — СОСТОЯНИЕ дня (upsert по точке+дате): историю
 * правок и авторство каждого ввода она держать не может по построению —
 * правка задним числом переписывала прошлое ленты действий. Лента и «итоги
 * вчера» читают события отсюда; агрегат дня остаётся в coffee_consumable.
 */
export const coffeeConsumableLog = pgTable(
  "coffee_consumable_log",
  {
    id: id(),
    locationId: uuid("location_id")
      .references(() => entity.id)
      .notNull(),
    loggedDate: date("logged_date").notNull(),
    water: integer("water").default(0).notNull(),
    cups: integer("cups").default(0).notNull(),
    lids: integer("lids").default(0).notNull(),
    createdBy: text("created_by"),
    createdAt: createdAt(),
  },
  (t) => [index("coffee_consumable_log_created_idx").on(t.createdAt)],
);

/**
 * Мойка/обслуживание бункера или машины целиком (`position: null` — вся
 * точка). Событийный журнал фактов; план обслуживания (частота, срок) —
 * отдельная таблица `coffeeWashSchedule` ниже.
 */
export const coffeeWashLog = pgTable(
  "coffee_wash_log",
  {
    id: id(),
    locationId: uuid("location_id")
      .references(() => entity.id)
      .notNull(),
    position: integer("position"),
    kind: coffeeWashEventKindEnum("kind").default("wash").notNull(),
    note: text("note"),
    performedBy: text("performed_by"),
    performedAt: timestamp("performed_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("coffee_wash_log_location_idx").on(t.locationId, t.performedAt),
    check(
      "coffee_wash_log_position_range",
      sql`${t.position} is null or ${t.position} between 1 and 8`,
    ),
  ],
);

/**
 * План обслуживания: как часто мыть точку целиком (`position: null`) или
 * конкретный бункер. Порт `WashingSchedule` донора VendHub-OS, расширенный
 * вторым триггером: частота по календарю (`frequencyDays`, как у донора) И/ИЛИ
 * по проданным чашкам с точки (`frequencyCups`) — хотя бы один должен быть
 * задан (проверка в сервисе; счёт чашек не привязан к конкретному бункеру —
 * рецепты используют несколько бункеров сразу, точной атрибуции пока нет).
 * `nextDueAt`/`overdue` считает сервис от `coffeeWashLog` — здесь только план.
 */
export const coffeeWashSchedule = pgTable(
  "coffee_wash_schedule",
  {
    id: id(),
    locationId: uuid("location_id")
      .references(() => entity.id)
      .notNull(),
    /** null — вся точка целиком, 1..8 — конкретный бункер (см. coffee_wash_log.position). */
    position: integer("position"),
    frequencyDays: integer("frequency_days"),
    frequencyCups: integer("frequency_cups"),
    isActive: boolean("is_active").default(true).notNull(),
    notes: text("notes"),
    createdAt: createdAt(),
  },
  (t) => [
    check(
      "coffee_wash_schedule_position_range",
      sql`${t.position} is null or ${t.position} between 1 and 8`,
    ),
    check(
      "coffee_wash_schedule_frequency_set",
      sql`${t.frequencyDays} is not null or ${t.frequencyCups} is not null`,
    ),
    // Частичные уникальные индексы: NULL в обычном UNIQUE не схлопывается
    // (постгрес считает NULL≠NULL), поэтому «вся точка» (position IS NULL)
    // защищена отдельным индексом от «конкретный бункер» (position IS NOT NULL).
    uniqueIndex("coffee_wash_schedule_location_position_key")
      .on(t.locationId, t.position)
      .where(sql`${t.position} is not null`),
    uniqueIndex("coffee_wash_schedule_location_whole_key")
      .on(t.locationId)
      .where(sql`${t.position} is null`),
  ],
);

/**
 * Товар кофемашины (Американо, Капучино…) и его состав — тот же формат
 * `RecipeLine`, что `recipeCost()`/`consumptionReport()` в `@mydon/shared`
 * (перенесено из VHM24 `product.types.ts`, уже используется общим рецептом
 * entity — здесь тот же контракт, своя таблица по той же причине, что и у
 * `vendingProduct`: движок вендинга держит свою схему, общую БД не сливаем).
 * Себестоимость и расход считаются на чтении из состава и текущих цен
 * ингредиентов — не хранятся отдельно, чтобы не разъехаться с ценами.
 */
export const coffeeProduct = pgTable("coffee_product", {
  id: id(),
  name: text("name").notNull().unique(),
  recipe: jsonb("recipe").$type<RecipeLine[]>().default([]).notNull(),
  isActive: boolean("is_active").default(true).notNull(),
  createdAt: createdAt(),
});

/**
 * Проданные чашки по точке за день — вводится сотрудником вручную: у этих
 * машин нет сетевого сбора и POS не подключён, «продажа» здесь факт с чужих
 * слов, как и весь остальной учёт вендинга. Источник «продаж» для сверки
 * факт/ожидание: `consumptionReport(coffee_sale × coffee_product.recipe)`
 * даёт ОЖИДАЕМЫЙ расход ингредиента, `coffee_refill` (вес) — ФАКТИЧЕСКИЙ;
 * расхождение за порогом — сигнал на разбор (`coffee-calc.ts`
 * `reconcileConsumption()`). Одна строка на (точка, товар, день) — повторный
 * ввод за тот же день правит её же, не плодит дубли (как у `coffee_consumable`).
 */
export const coffeeSale = pgTable(
  "coffee_sale",
  {
    id: id(),
    locationId: uuid("location_id")
      .references(() => entity.id)
      .notNull(),
    productId: uuid("product_id")
      .references(() => coffeeProduct.id)
      .notNull(),
    loggedDate: date("logged_date").notNull(),
    quantity: integer("quantity").default(0).notNull(),
    createdBy: text("created_by"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("coffee_sale_location_product_date_key").on(
      t.locationId,
      t.productId,
      t.loggedDate,
    ),
  ],
);

/**
 * Проданная чашка — ФАКТ из панели производителя (gjvending), одна строка на
 * заказ.
 *
 * ЗАЧЕМ ОТДЕЛЬНАЯ ТАБЛИЦА, А НЕ `sale`. `sale` — суточный агрегат из OurVend
 * по снек-автоматам: (день, серийник, товар, количество, сумма). Кофейные
 * автоматы стоят в другой системе и отдают КАЖДЫЙ заказ со временем варки,
 * вкусом и статусом выдачи. Сложить их в суточный агрегат значит выбросить
 * ровно то, ради чего они нужны: время (расход по периоду работы бункера) и
 * различие «оплачено» против «выдано».
 *
 * ЗАЧЕМ НЕ ОСТАВИТЬ В СЫРОМ СЛОЕ. `raw_row` — распечатка источника, она честна,
 * но неудобна: колонки строками, статусы по-английски, тестовые выдачи вперемешку
 * с продажами. До этой таблицы выручка кофе не участвовала в аналитике вовсе —
 * панель показывала снек (9,5 млн/мес) и молчала про кофе (~40 млн/мес).
 *
 * ЧТО СЧИТАТЬ ПРОДАЖЕЙ. Только `paymentStatus='paid'` И `orderResource` не
 * тестовая выдача и не vip: в выгрузке 1746 тестовых и 393 vip на 23 285 строк —
 * девять процентов, которые иначе осели бы в выручке. Отказ выдачи
 * (`brewStatus`) продажу не отменяет — деньги взяты; но сырьё по такому заказу
 * не израсходовано, поэтому для расхода нужен именно `brewStatus`, а не оплата.
 */
export const coffeeOrder = pgTable(
  "coffee_order",
  {
    id: id(),
    /** Номер заказа у источника — ключ идемпотентности повторного импорта. */
    extId: text("ext_id").notNull(),
    source: text("source").default("gjvending").notNull(),
    /** Время создания заказа. В источнике оно местное (Asia/Tashkent). */
    ts: timestamp("ts", { withTimezone: true }).notNull(),
    brewedAt: timestamp("brewed_at", { withTimezone: true }),
    /** Серийник автомата как в источнике — ключ сопоставления с реестром. */
    machineSerial: text("machine_serial").notNull(),
    /** Карточка автомата, если серийник узнан. NULL — не сопоставлен. */
    machineId: uuid("machine_id").references(() => entity.id),
    /** Адрес из источника: у кофе-панели он же имя точки. */
    address: text("address"),
    goodsName: text("goods_name").notNull(),
    flavourName: text("flavour_name"),
    /** Карточка товара, если имя узнано (через product_name_alias). */
    productId: uuid("product_id").references(() => entity.id),
    amount: numeric("amount", { precision: 15, scale: 2 }).default("0").notNull(),
    currency: text("currency").default("UZS").notNull(),
    /** Как в источнике: Paid / Refunded. */
    paymentStatus: text("payment_status"),
    /** Как в источнике: Delivered / Delivery failure / Not delivered … */
    brewStatus: text("brew_status"),
    /** Как в источнике: Cash payment / Custom payment / vip / тестовая выдача. */
    orderResource: text("order_resource"),
    /**
     * Строка идёт в выручку и в расход сырья. Считается на записи, а не на
     * чтении: правило «что считать продажей» должно жить в одном месте, иначе
     * дашборд и отчёт по расходу разойдутся в цифрах.
     */
    countable: boolean("countable").default(true).notNull(),
    importedAt: createdAt(),
  },
  (t) => [
    uniqueIndex("coffee_order_src_key").on(t.source, t.extId),
    index("coffee_order_ts_idx").on(t.ts),
    index("coffee_order_machine_idx").on(t.machineId, t.ts),
    index("coffee_order_countable_idx").on(t.countable, t.ts),
  ],
);

/**
 * Остаток центрального склада кофе-ингредиентов, грамм (тот же приём, что
 * `vending_stock`, — своя таблица, а не общий `entity`/`stock_movement`:
 * движки не сливают базы, а объём и природа расхода тут иные — граммы из
 * бункеров, не штуки/партии общего склада). Одна строка на ингредиент —
 * текущий баланс, вводится инвентаризацией (перезапись, а не леджер), как и
 * у `vending_stock`; заливки бункеров его не списывают автоматически —
 * пересчёт следует за реальностью, а не наоборот.
 */
export const coffeeStock = pgTable("coffee_stock", {
  id: id(),
  ingredientId: uuid("ingredient_id")
    .references(() => coffeeIngredient.id)
    .notNull()
    .unique(),
  quantity: integer("quantity").default(0).notNull(),
  countedAt: timestamp("counted_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

// ── Обслуживание оборудования: журнал работ и узлы автоматов ────────────────
//
// Три вещи, которые нельзя смешивать: НОРМАТИВ (как часто положено),
// ФАКТ (что и когда сделали) и СОСТОЯНИЕ (какой узел сейчас стоит).
// Здесь факт и состояние; норматив — `maintenance_plan` (следующий шаг).
//
// Статус «пора / просрочено» НЕ хранится нигде: он зависит от now() и
// считается на чтении. Хранимый статус — это поле, которое обязательно
// разъедется с реальностью в тот день, когда крон не отработает.
//
// Кофейная мойка (`coffee_wash_log` + `coffee_wash_schedule`) сюда НЕ
// переносится. У неё ключ «точка + позиция бункера 1..8», а здесь «автомат +
// узел»; копия фактов в двух журналах дала бы двойной счёт и разные ответы
// на вопрос «когда мыли».

/** Вид работы. Значения английские, подписи — в @mydon/shared. */
export const maintenanceKindEnum = pgEnum("maintenance_kind", [
  "cleaning", // чистка
  "sanitation", // санобработка
  "service", // плановое ТО
  "part_replace", // замена узла
  "inspection", // технический осмотр
  "calibration", // поверка, калибровка
  "repair", // ремонт по факту поломки
  "other",
  // Установка/снятие узла без пары — «привёз со склада» и «увёз в мойку».
  // Замена остаётся part_replace: это одна работа, а не две.
  "part_install",
  "part_remove",
]);

/**
 * Узлы автомата. Список заполнен с запасом намеренно: парк подтягивается из
 * внешних систем постепенно, и добавить значение сейчас бесплатно, а
 * `ALTER TYPE` на живой базе — нет.
 */
export const partKindEnum = pgEnum("part_kind", [
  "bill_acceptor", // купюроприёмник
  "coin_acceptor", // монетоприёмник
  "brewer", // варочная группа
  "grinder", // кофемолка
  "mixer", // миксер
  "hopper", // бункер
  "water_filter", // фильтр воды
  "pump", // помпа
  "boiler", // бойлер
  "cooling_unit", // холодильный блок
  "compressor", // компрессор
  "payment_terminal", // платёжный терминал
  "display", // дисплей
  "mainboard", // плата управления
  "motor", // мотор
  "valve", // клапан
  "sensor", // датчик
  "lock", // замок, механизм двери
  "spiral", // спираль выдачи (снек)
  "elevator", // лифт выдачи
  "other",
]);

/**
 * Чем кончилась работа. NULL — работа начата и не закрыта: такие строки
 * старше суток отдельно видны владельцу, иначе «начал и забыл» выглядит
 * как «не приходил».
 */
export const maintenanceOutcomeEnum = pgEnum("maintenance_outcome", [
  "done", // сделано
  "partial", // сделано частично
  "failed", // не смог
]);

/** Почему меняли узел — без этого нельзя отличить износ от поломки. */
export const partSwapReasonEnum = pgEnum("part_swap_reason", [
  "failure", // отказ
  "preventive", // профилактика по сроку
  "upgrade", // замена на лучшее
  "warranty", // гарантийная замена
  "moved", // переставили на другой автомат
]);

/**
 * Где узел, когда он НЕ на автомате. `machine` — единственное значение для
 * строк с заполненным `machine_id`; остальные описывают открытый период
 * «лежит вне автомата»: снятый купюроприёмник в ремонте — это узел, который
 * вернётся, и терять его из учёта нельзя.
 */
export const partLocationEnum = pgEnum("part_location", [
  "machine", // стоит на автомате
  "warehouse", // на складе
  "washing", // на мойке
  "drying", // на сушке
  "repair", // в ремонте
]);

/**
 * Факт работы: кто, когда, что и с каким результатом.
 *
 * Дата отдельно от отметки времени: `performed_on` — календарный день по
 * Ташкенту, по нему считаются сроки и строятся сводки. Вычислять день из
 * `performed_at` в запросе значит каждый раз помнить про часовой пояс —
 * и однажды забыть.
 */
export const maintenanceLog = pgTable(
  "maintenance_log",
  {
    id: id(),
    /** Объект: автомат или точка — запись реестра. */
    entityId: uuid("entity_id")
      .references(() => entity.id)
      .notNull(),
    kind: maintenanceKindEnum("kind").notNull(),
    /** Какой узел трогали. NULL для работ по автомату целиком. */
    partKind: partKindEnum("part_kind"),
    /** Кто делал. NULL у записей, внесённых владельцем задним числом. */
    personId: uuid("person_id").references(() => person.id),
    /** Задача, в рамках которой сделано, если была. */
    taskId: uuid("task_id").references(() => task.id),
    /**
     * Норматив, по которому работа сделана. Без него закрытие работы не знает,
     * какой якорь двигать, и график остаётся стоять там же, где был.
     */
    // Ссылка ленивая (() => …): maintenance_plan объявлена ниже по файлу,
    // потому что журнал появился раньше нормативов.
    planId: uuid("plan_id").references(() => maintenancePlan.id),
    /** Календарный день по Ташкенту. */
    performedOn: date("performed_on").notNull(),
    performedAt: timestamp("performed_at", { withTimezone: true }).defaultNow().notNull(),
    /** NULL — работа начата и не закрыта. */
    outcome: maintenanceOutcomeEnum("outcome"),
    note: text("note"),
    /** Показания счётчика автомата на момент работы, если снимались. */
    counterValue: integer("counter_value"),
    /**
     * Ключ идемпотентности от клиента (бот). Повторное нажатие «Готово»
     * после таймаута не должно давать вторую запись — тот же принцип, что
     * у vending_refill. NULL у записей владельца из панели: там повтор — это
     * осознанный второй ввод, а не дрожащая рука на точке.
     */
    clientKey: text("client_key"),
    createdBy: text("created_by"),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("maintenance_log_client_key").on(t.clientKey),
    index("maintenance_log_entity_idx").on(t.entityId, t.performedOn),
    index("maintenance_log_person_idx").on(t.personId, t.performedOn),
    // Под вопрос «когда в последний раз делали это на этом объекте» —
    // основной запрос расчёта сроков. Только закрытые: начатая и брошенная
    // работа сроки не сдвигает.
    index("maintenance_log_done_idx")
      .on(t.entityId, t.kind, t.partKind, t.performedOn)
      .where(sql`outcome is not null`),
    // Под «когда в последний раз делали по этому нормативу» — запрос,
    // с которого начинается каждый расчёт срока.
    index("maintenance_log_plan_done_idx")
      .on(t.planId, t.performedOn)
      .where(sql`outcome is not null`),
    check(
      "maintenance_log_counter_nonneg",
      sql`${t.counterValue} is null or ${t.counterValue} >= 0`,
    ),
  ],
);

/**
 * Экземпляр узла на автомате — периодами, как `coffee_machine_placement`.
 *
 * Не «текущий узел» одной строкой: вопрос «что стояло в марте, когда пошли
 * жалобы» — рабочий, и ответить на него должен не нынешний узел. Замена
 * закрывает старый период и открывает новый одной транзакцией.
 */
export const machinePart = pgTable(
  "machine_part",
  {
    id: id(),
    /** NULL — открытый период «узел вне автомата» (см. `location`). */
    machineId: uuid("machine_id").references(() => entity.id),
    /**
     * Где узел в этом периоде. Для строк с автоматом всегда `machine`;
     * снятие узла открывает период с `machine_id = NULL` и местом
     * склад/мойка/сушка/ремонт — check ниже держит это соответствие.
     */
    location: partLocationEnum("location").notNull().default("machine"),
    partKind: partKindEnum("part_kind").notNull(),
    /** Позиция, если узлов одного вида несколько (бункер 1..8). */
    slot: integer("slot"),
    /** Серийный номер. NULL — не переписали; фото шильдика лежит во вложениях. */
    serialNumber: text("serial_number"),
    model: text("model"),
    installedOn: date("installed_on").notNull(),
    /** NULL — узел стоит сейчас. */
    removedOn: date("removed_on"),
    /** Записи журнала, которыми узел поставлен и снят. */
    installLogId: uuid("install_log_id").references(() => maintenanceLog.id),
    removeLogId: uuid("remove_log_id").references(() => maintenanceLog.id),
    warrantyUntil: date("warranty_until"),
    reason: partSwapReasonEnum("reason"),
    note: text("note"),
    createdBy: text("created_by"),
    createdAt: createdAt(),
  },
  (t) => [
    index("machine_part_machine_idx").on(t.machineId, t.partKind),
    // Одно место — один открытый узел. coalesce обязателен: постгрес считает
    // NULL ≠ NULL, и без него на автомате завелись бы два «текущих»
    // купюроприёмника без слота, оба открытые. Условие по machine_id тоже:
    // вне автомата (machine_id NULL) одинаковых узлов сколько угодно —
    // три бункера на мойке это норма, а не конфликт.
    uniqueIndex("machine_part_open_key")
      .on(t.machineId, t.partKind, sql`coalesce(${t.slot}, 0)`)
      .where(sql`removed_on is null and machine_id is not null`),
    // «Где сейчас узел A7734120» — поиск по серийнику, без индекса seq scan.
    index("machine_part_serial_idx")
      .on(t.serialNumber)
      .where(sql`serial_number is not null`),
    check("machine_part_slot_positive", sql`${t.slot} is null or ${t.slot} > 0`),
    check("machine_part_dates", sql`${t.removedOn} is null or ${t.removedOn} >= ${t.installedOn}`),
    // machine ⟺ на автомате: строка «в мойке, но с автоматом» и «на автомате,
    // но со складом» — обе бессмыслица, и обе рано или поздно появятся без check.
    check(
      "machine_part_location_matches",
      sql`(${t.machineId} is not null and ${t.location} = 'machine') or (${t.machineId} is null and ${t.location} <> 'machine')`,
    ),
  ],
);

/**
 * Одноразовое приглашение сотрудника в бота.
 *
 * Заменяет привязку по @username. Ник в Telegram освобождается после смены,
 * и любой, кто его займёт, получал доступ к карточке сотрудника со всеми его
 * задачами — приглашение закрывает это тем, что секрет знает только тот,
 * кому его дали лично.
 *
 * Хранится ХЕШ кода, а не код: утечка дампа не должна давать работающих
 * приглашений.
 */
export const staffInvite = pgTable(
  "staff_invite",
  {
    id: id(),
    personId: uuid("person_id")
      .references(() => person.id, { onDelete: "cascade" })
      .notNull(),
    /** sha256(перец + код). Перец живёт в окружении, в БД его нет. */
    codeHash: text("code_hash").notNull(),
    /** Роли, которые получит сотрудник при подключении. */
    roles: text("roles")
      .array()
      .default(sql`'{}'::text[]`)
      .notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    /** chat_id, которым приглашение погашено, — для разбора инцидентов. */
    usedByChatId: text("used_by_chat_id"),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdBy: text("created_by"),
    createdAt: createdAt(),
  },
  (t) => [
    // Один код — одно приглашение. Только среди живых: погашенные хеши
    // повторно не встретятся, но и блокировать их незачем.
    uniqueIndex("ux_staff_invite_code")
      .on(t.codeHash)
      .where(sql`used_at is null and revoked_at is null`),
    // Одно живое приглашение на человека: выпуск нового гасит прежнее, иначе
    // по чату гуляли бы две рабочие ссылки и владелец не знал бы, какая.
    uniqueIndex("ux_staff_invite_one_active")
      .on(t.personId)
      .where(sql`used_at is null and revoked_at is null`),
    index("staff_invite_person_idx").on(t.personId),
  ],
);

/**
 * Норматив: как часто работу положено делать.
 *
 * Третья из трёх вещей, которые нельзя смешивать (норматив — факт —
 * состояние). Статус «пора / просрочено» здесь НЕ хранится: он зависит от
 * текущей даты и считается на чтении из `due_on`.
 *
 * `due_on` — это ЯКОРЬ, плановая дата следующей работы, а не «когда сделали
 * плюс период». Разница принципиальна: мойка раз в 30 дней со сроком 1 марта,
 * сделанная 5-го, должна ждать 31 марта, а не 4 апреля. Считая от факта,
 * «ежемесячная» работа за год делается десять раз вместо двенадцати —
 * и никто этого не замечает, потому что каждый отдельный раз выглядит верно.
 */
export const maintenancePlan = pgTable(
  "maintenance_plan",
  {
    id: id(),
    entityId: uuid("entity_id")
      .references(() => entity.id)
      .notNull(),
    kind: maintenanceKindEnum("kind").notNull(),
    /** Узел, если норматив про конкретный узел. NULL — про автомат целиком. */
    partKind: partKindEnum("part_kind"),
    /** Своё название, если «Плановое ТО» недостаточно точно. */
    title: text("title"),
    /** Периодичность: дни, месяцы или счётчик. Хотя бы одно — иначе unknown. */
    everyDays: integer("every_days"),
    everyMonths: integer("every_months"),
    everyCount: integer("every_count"),
    /** Что считаем: «чашек», «продаж», «литров». */
    counterLabel: text("counter_label"),
    /** Плановая дата следующей работы. NULL — норматив есть, срок не назначен. */
    dueOn: date("due_on"),
    /** За сколько дней до срока ставить задачу. */
    taskLeadDays: integer("task_lead_days").default(3).notNull(),
    /** Ставить ли задачу автоматически. */
    autoTask: boolean("auto_task").default(true).notNull(),
    /**
     * Именной график: работу делает только этот человек. По умолчанию пусто —
     * задача уходит в общий пул, потому что закрепления за объектами нет.
     */
    assigneeId: uuid("assignee_id").references(() => person.id),
    isActive: boolean("is_active").default(true).notNull(),
    note: text("note"),
    createdBy: text("created_by"),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    // Основной запрос монитора: что подходит к сроку. Только активные —
    // выключенный норматив не должен занимать место в индексе.
    index("maintenance_plan_due_idx")
      .on(t.dueOn)
      .where(sql`is_active`),
    index("maintenance_plan_entity_idx").on(t.entityId),
    // Один норматив на «объект + вид работ + узел». Дубль означал бы две
    // разные даты для одной обязанности и вечный спор, какая правильная.
    //
    // Два частичных индекса вместо одного с coalesce — потому что постгрес
    // считает NULL ≠ NULL, а свернуть NULL в пустую строку здесь нечем:
    // приведение enum к тексту помечено STABLE (метку значения enum можно
    // переименовать), а в выражении индекса допустимы только IMMUTABLE.
    // `coalesce(part_kind::text, '')` проходит `drizzle-kit push`, но роняет
    // `migrate` на живой базе ошибкой 42P17 — так полевой контур и не
    // развернулся на сервере. Пара индексов даёт ровно ту же гарантию
    // и работает на любой версии постгреса (NULLS NOT DISTINCT — только 15+).
    uniqueIndex("maintenance_plan_key")
      .on(t.entityId, t.kind, t.partKind)
      .where(sql`is_active and part_kind is not null`),
    uniqueIndex("maintenance_plan_key_nopart")
      .on(t.entityId, t.kind)
      .where(sql`is_active and part_kind is null`),
    check(
      "maintenance_plan_period_set",
      sql`${t.everyDays} is not null or ${t.everyMonths} is not null or ${t.everyCount} is not null`,
    ),
    check("maintenance_plan_lead_nonneg", sql`${t.taskLeadDays} >= 0`),
  ],
);

/**
 * Полная схема — для drizzle-клиента.
 *
 * ВСЕ таблицы обязаны быть здесь: этот объект — то, что видит `db.query.*` и
 * интроспекция схемы. Пропущенная таблица экспортируется, но реляционному слою
 * и инструментам невидима — молча неполная схема. Тест `schema.test.ts` держит
 * список в согласии с экспортами, чтобы новая таблица не потерялась.
 */
export const schema = {
  org,
  project,
  entity,
  entityDraft,
  person,
  task,
  taskComment,
  approval,
  event,
  document,
  moneyFlow,
  // Финансовый контур: курс валют к суму (перенос паттерна PROMACH).
  fxRate,
  // Расчётные справочники GLOBERENT: ставки ТН ВЭД и БРВ (перенос PROMACH).
  tnvedRate,
  brvValue,
  // UZS-договоры GLOBERENT: договор и акты приёма-передачи (перенос PROMACH).
  grContract,
  contractAct,
  // Склад техники GLOBERENT: единицы конвейера и резервы (перенос PROMACH).
  globerentUnit,
  unitReserve,
  // Импортные контракты GLOBERENT (перенос import_contracts PROMACH).
  grImportContract,
  // Предзаказы GLOBERENT (перенос pre_orders PROMACH).
  grPreorder,
  note,
  auditLog,
  agent,
  // Операционные таблицы VendHub (движения, сырьё, инкассация).
  collection,
  sale,
  productNameAlias,
  purchase,
  machineStock,
  // Собственный учётный снапшот OurVend (П2 поглощения mydon-stock).
  ourvendSaleSnapshot,
  ourvendStockSnapshot,
  stockBatch,
  stockMovement,
  // Сырой слой источников.
  rawSnapshot,
  rawRow,
  rawSourceDef,
  rawReportDef,
  rawLink,
  // Типизированные точки, вложения, доставка уведомлений.
  geoPoint,
  attachment,
  notificationDelivery,
  // Глобальные тумблеры системы (редактируются из панели).
  systemConfig,
  // Вендинг-операции (§4): слоты, снапшоты, продажи, прайс, алиасы, сбор.
  vendingProduct,
  vendingAlias,
  machineSlot,
  machineCard,
  slotSnapshot,
  productSale,
  machineSale,
  vendingStock,
  vendingRefill,
  vendingRefillEvent,
  vendingPurchaseOrder,
  vendingCashSession,
  vendingUnmatched,
  vendingSyncRun,
  // Кофе-вендинг: бункеры, тара, ежедневная заливка, расходники, мойка.
  coffeeIngredient,
  coffeeBunkerConfig,
  coffeeContainerTare,
  coffeeRefill,
  coffeeContainerReturn,
  coffeeConsumable,
  coffeeConsumableLog,
  coffeeWashLog,
  coffeeWashSchedule,
  coffeeProduct,
  coffeeSale,
  coffeeOrder,
  coffeeStock,
  // Обслуживание: журнал работ и узлы автоматов.
  maintenanceLog,
  machinePart,
  maintenancePlan,
  // Доступ сотрудников: приглашения.
  staffInvite,
  // Места и размещения — общие для всех видов автоматов.
  machinePlacement,
};
