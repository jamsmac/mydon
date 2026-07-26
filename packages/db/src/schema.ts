/**
 * Схема MYDON Core (PostgreSQL / Drizzle).
 * Единый реестр по ТЗ §7: org · project · entity · person · task ·
 * approval · event · document · money_flow · note · audit_log.
 *
 * Принцип: сначала реестр, потом дашборд. Базы движков (VHM24, TRent) — отдельные, здесь не хранятся.
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
export const domainEnum = pgEnum("domain", ["globerent", "vendhub", "trent", "personal", "mydon"]);
export const ownerKindEnum = pgEnum("owner_kind", ["human", "agent"]);
export const taskStatusEnum = pgEnum("task_status", ["todo", "in_progress", "done", "cancelled"]);
export const approvalTierEnum = pgEnum("approval_tier", ["T0", "T1", "T2", "T3", "T4"]);
export const approvalDecisionEnum = pgEnum("approval_decision", [
  "pending",
  "approved",
  "rejected",
  "clarify",
]);
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
export const person = pgTable("person", {
  id: id(),
  orgId: uuid("org_id").references(() => org.id),
  name: text("name").notNull(),
  role: text("role"),
  email: text("email"),
  phone: text("phone"),
  attrs: jsonb("attrs").default({}).notNull(),
  createdAt: createdAt(),
});

// ── task: задачи (владелец — человек или агент) ──
export const task = pgTable("task", {
  id: id(),
  title: text("title").notNull(),
  ownerKind: ownerKindEnum("owner_kind").notNull(),
  ownerRef: text("owner_ref"), // person.id или имя агента
  domain: domainEnum("domain"),
  status: taskStatusEnum("status").default("todo").notNull(),
  due: timestamp("due", { withTimezone: true }),
  source: text("source"), // откуда пришла задача
  createdAt: createdAt(),
});

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
};
