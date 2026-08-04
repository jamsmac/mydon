/**
 * Схема MYDON Core (PostgreSQL / Drizzle).
 * Единый реестр по ТЗ §7: org · project · entity · person · task ·
 * approval · event · document · money_flow · note · audit_log.
 *
 * Принцип: сначала реестр, потом дашборд. Базы движков (VHM24 и др.) — отдельные, здесь не хранятся.
 */
import { sql } from "drizzle-orm";
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
    ownerRef: text("owner_ref"), // person.id или имя агента
    domain: domainEnum("domain"),
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
    /** Когда исполнителю уже напомнили — чтобы не слать одно и то же дважды. */
    remindedAt: timestamp("reminded_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  // Главные запросы: «что у этого исполнителя» и «что горит по срокам».
  (t) => [index("task_owner_idx").on(t.ownerKind, t.ownerRef), index("task_due_idx").on(t.due)],
);

// ── collection: инкассация автоматов (перенос VendCash внутрь MYDON) ──
// Двухэтапный процесс из спецификации VendCash: оператор фиксирует сбор
// (время до секунды), менеджер принимает и вводит сумму.
export const collectionStatusEnum = pgEnum("collection_status", ["collected", "received", "cancelled"]);
export const collectionSourceEnum = pgEnum("collection_source", ["realtime", "manual_history", "import"]);
export const collection = pgTable(
  "collection",
  {
    id: id(),
    /** Автомат — запись реестра (entity типа machine). */
    machineId: uuid("machine_id").references(() => entity.id).notNull(),
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
  (t) => [
    uniqueIndex("purchase_src_key").on(t.source, t.extId),
    index("purchase_dt_idx").on(t.dt),
  ],
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
    createdBy: text("created_by"),
    createdAt: createdAt(),
  },
  (t) => [
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
    customsFeeRate: numeric("customs_fee_rate", { precision: 7, scale: 4 }).default("0.002").notNull(),
    exciseRate: numeric("excise_rate", { precision: 7, scale: 4 }).default("0").notNull(),
    vatRate: numeric("vat_rate", { precision: 7, scale: 4 }).default("0.12").notNull(),
    /** Утильсбор: сколько БРВ (0 — не облагается). */
    utilizationBrvCount: integer("utilization_brv_count").default(0).notNull(),
    /** Доп. пошлина за см³ двигателя, USD (3.36 у тягачей; 0 у погрузчиков). */
    extraDutyPerCcUsd: numeric("extra_duty_per_cc_usd", { precision: 10, scale: 4 }).default("0").notNull(),
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
export const vendingAliasSourceEnum = pgEnum("vending_alias_source", ["ourvend", "warehouse", "manual"]);
export const vendingSyncStatusEnum = pgEnum("vending_sync_status", ["running", "success", "partial", "failed"]);
/** Жизненный цикл накладной закупа: одобрена → заказана → принята | отменена. */
export const vendingOrderStatusEnum = pgEnum("vending_order_status", ["approved", "ordered", "received", "cancelled"]);

/** Справочник товаров вендинга: прайс и кратность (Приложение А ТЗ). */
export const vendingProduct = pgTable("vending_product", {
  id: id(),
  /** Каноническое имя товара. */
  name: text("name").notNull().unique(),
  category: vendingCategoryEnum("category").default("other").notNull(),
  /** Закупочная цена за единицу, сум. Пусто → в сумму закупа не входит. */
  purchasePrice: numeric("purchase_price", { precision: 10, scale: 2 }),
  /** Кратность закупки: напитки 12, снеки 10 (решение владельца 02.08.2026). */
  packSize: integer("pack_size").default(1).notNull(),
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

export const coffeeWashEventKindEnum = pgEnum("coffee_wash_event_kind", ["wash", "clean", "replace", "service"]);

/**
 * Точка (адрес), где стоит кофемашина.
 *
 * `entityId` — связь с карточкой автомата в реестре (`entity`, type=machine):
 * у карточки есть серийник (`externalRef`), координаты и адрес («точка» в
 * attrs), поэтому кофе-точка через неё попадает на карту и в общий учёт.
 * Связь по id, не по имени — переименование ничего не рвёт. Пусто — точка
 * ещё не привязана (автоподбор по названию + ручная привязка в Настройках).
 */
export const coffeeLocation = pgTable("coffee_location", {
  id: id(),
  name: text("name").notNull().unique(),
  sortOrder: integer("sort_order").default(0).notNull(),
  isActive: boolean("is_active").default(true).notNull(),
  entityId: uuid("entity_id").references(() => entity.id),
  createdAt: createdAt(),
});

/** Ингредиент бункера (молоко, кофе, сахар, чай…) — canonical-имя, без алиасов (список закрытый, 8 позиций). */
export const coffeeIngredient = pgTable("coffee_ingredient", {
  id: id(),
  name: text("name").notNull().unique(),
  unit: text("unit").default("g").notNull(),
  /** Закупочная цена за единицу `unit` (обычно за грамм), сум. Пусто — себестоимость расхода не считается (§ reconcile). */
  purchasePrice: numeric("purchase_price", { precision: 10, scale: 4 }),
  createdAt: createdAt(),
});

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
      .references(() => coffeeLocation.id)
      .notNull(),
    position: integer("position").notNull(),
    /** «Набор» — номер физического контейнера, если техник его записал. */
    containerNumber: integer("container_number"),
    ingredientId: uuid("ingredient_id").references(() => coffeeIngredient.id),
    filledWeight: integer("filled_weight").notNull(),
    measuredBefore: integer("measured_before"),
    packageCount: integer("package_count").default(1).notNull(),
    /** «Дата» из формы — календарная дата обхода, без времени. */
    enteredDate: date("entered_date").notNull(),
    createdBy: text("created_by"),
    createdAt: createdAt(),
  },
  (t) => [
    index("coffee_refill_location_position_idx").on(t.locationId, t.position, t.enteredDate),
    check("coffee_refill_position_range", sql`${t.position} between 1 and 8`),
    check("coffee_refill_container_range", sql`${t.containerNumber} is null or ${t.containerNumber} between 1 and 27`),
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
 * открывает новое, история не переписывается. `coffee_location.entity_id`
 * остаётся кэшем текущего аппарата — его ведёт linkLocation() там же,
 * где пишет размещения.
 */
export const coffeeMachinePlacement = pgTable(
  "coffee_machine_placement",
  {
    id: id(),
    locationId: uuid("location_id")
      .references(() => coffeeLocation.id)
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
    index("coffee_machine_placement_location_idx").on(t.locationId, t.startDate),
    index("coffee_machine_placement_entity_idx").on(t.entityId, t.startDate),
    // Физика: на точке не больше одного текущего аппарата, аппарат — не
    // больше чем на одной точке. История (закрытые периоды) не ограничена.
    uniqueIndex("coffee_machine_placement_location_open_key")
      .on(t.locationId)
      .where(sql`${t.endDate} is null`),
    uniqueIndex("coffee_machine_placement_entity_open_key")
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
      .references(() => coffeeLocation.id)
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
 * Мойка/обслуживание бункера или машины целиком (`position: null` — вся
 * точка). Событийный журнал фактов; план обслуживания (частота, срок) —
 * отдельная таблица `coffeeWashSchedule` ниже.
 */
export const coffeeWashLog = pgTable(
  "coffee_wash_log",
  {
    id: id(),
    locationId: uuid("location_id")
      .references(() => coffeeLocation.id)
      .notNull(),
    position: integer("position"),
    kind: coffeeWashEventKindEnum("kind").default("wash").notNull(),
    note: text("note"),
    performedBy: text("performed_by"),
    performedAt: timestamp("performed_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("coffee_wash_log_location_idx").on(t.locationId, t.performedAt),
    check("coffee_wash_log_position_range", sql`${t.position} is null or ${t.position} between 1 and 8`),
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
      .references(() => coffeeLocation.id)
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
    check("coffee_wash_schedule_position_range", sql`${t.position} is null or ${t.position} between 1 and 8`),
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
      .references(() => coffeeLocation.id)
      .notNull(),
    productId: uuid("product_id")
      .references(() => coffeeProduct.id)
      .notNull(),
    loggedDate: date("logged_date").notNull(),
    quantity: integer("quantity").default(0).notNull(),
    createdBy: text("created_by"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("coffee_sale_location_product_date_key").on(t.locationId, t.productId, t.loggedDate)],
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
  note,
  auditLog,
  agent,
  // Операционные таблицы VendHub (движения, сырьё, инкассация).
  collection,
  sale,
  purchase,
  machineStock,
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
  slotSnapshot,
  productSale,
  machineSale,
  vendingStock,
  vendingPurchaseOrder,
  vendingCashSession,
  vendingUnmatched,
  vendingSyncRun,
  // Кофе-вендинг: бункеры, тара, ежедневная заливка, расходники, мойка.
  coffeeLocation,
  coffeeIngredient,
  coffeeBunkerConfig,
  coffeeContainerTare,
  coffeeRefill,
  coffeeContainerReturn,
  coffeeConsumable,
  coffeeWashLog,
  coffeeWashSchedule,
  coffeeProduct,
  coffeeSale,
  coffeeStock,
  coffeeMachinePlacement,
};
