/**
 * Схема MYDON Core (PostgreSQL / Drizzle).
 * Единый реестр по ТЗ §7: org · project · entity · person · task ·
 * approval · event · document · money_flow · note · audit_log.
 *
 * Принцип: сначала реестр, потом дашборд. Базы движков (VHM24 и др.) — отдельные, здесь не хранятся.
 */
import {
  pgTable,
  pgEnum,
  uuid,
  text,
  timestamp,
  jsonb,
  numeric,
  index,
} from "drizzle-orm/pg-core";

// ── Перечисления ──
export const domainEnum = pgEnum("domain", ["globerent", "vendhub", "personal", "mydon"]);
export const ownerKindEnum = pgEnum("owner_kind", ["human", "agent"]);
export const taskStatusEnum = pgEnum("task_status", ["todo", "in_progress", "done", "cancelled"]);
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
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("entity_org_type_idx").on(t.orgId, t.type)],
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
    completedAt: timestamp("completed_at", { withTimezone: true }),
    /** Когда исполнителю уже напомнили — чтобы не слать одно и то же дважды. */
    remindedAt: timestamp("reminded_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  // Главные запросы: «что у этого исполнителя» и «что горит по срокам».
  (t) => [index("task_owner_idx").on(t.ownerKind, t.ownerRef), index("task_due_idx").on(t.due)],
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
    direction: moneyDirectionEnum("direction").notNull(),
    amount: numeric("amount", { precision: 18, scale: 2 }).notNull(),
    currency: text("currency").default("UZS").notNull(),
    date: timestamp("date", { withTimezone: true }).notNull(),
    status: text("status").default("actual").notNull(), // planned | actual | overdue
    createdAt: createdAt(),
  },
  (t) => [index("money_flow_org_date_idx").on(t.orgId, t.date)],
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
    /** Архив: агент убран из работы, но его история сохранена. */
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("agent_status_idx").on(t.status)],
);

/** Полная схема — для drizzle-клиента. */
export const schema = {
  org,
  project,
  entity,
  person,
  task,
  approval,
  event,
  document,
  moneyFlow,
  note,
  auditLog,
  agent,
  taskComment,
};
