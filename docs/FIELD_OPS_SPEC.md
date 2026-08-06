# ТЗ: полевой контур MYDON — бот для сотрудников, журнал обслуживания, графики ТО

Документ самодостаточен. Все пути абсолютные от корня монорепо `/home/user/mydon`. Стек и конвенции — по `CLAUDE.md`: TypeScript strict без `any`, русский в UI, английский в коде, `Asia/Tashkent` везде, тесты на `node:test` рядом с исходником.

---

## 1. Цель и границы

### 1.1 Цель

Дать полевым сотрудникам (операторы-заправщики, техники, инкассаторы, кладовщик) рабочий инструмент в Telegram, а владельцу — достоверную картину состояния парка. Шесть требований владельца:

1. видеть свои задачи и что делать сегодня;
2. регистрировать выполненную работу;
3. регистрировать замену узлов (купюроприёмник, монетоприёмник, варочный блок, кофемолка, фильтр воды и т. п.);
4. прикладывать фото «до/после» как подтверждение;
5. получать напоминания о предстоящих работах;
6. видеть графики ТО / чистки / технического осмотра.

### 1.2 Принципы, которым подчинён весь документ

- **Сначала реестр, потом дашборд.** Сначала техник вводит факты (`maintenance_log`, `machine_part`), потом на них считаются графики. Ни одной таблицы «под экран».
- **Норматив, факт и состояние — три разные вещи.** План (`maintenance_plan`), событие (`maintenance_log`), период (`machine_part`). Статус «пора / просрочено» **не хранится никогда** — он зависит от `now()` и считается на чтении.
- **Базы движков не сливаем.** Кофейная мойка остаётся в своём контуре (`coffee_wash_schedule` + `coffee_wash_log`) и в новый generic-график **не переносится**. Новый график покрывает узлы автомата и технический осмотр. Два журнала одного факта — недопустимо.
- **Не изобретать то, что есть.** Запчасть как карточка — это существующий `entity.type = "component"` (визард `staff-register.ts` уже её заводит). Приход/расход — `stock_movement`. Утверждение карточки сотрудника — существующий контур `createdFrom: "staff:<id>"` → `approvedAt = null` → экран `/queue`, а **не** таблица `approval` (она про агентов, и запись в неё исказит `auditLog.actorKind`).
- **Общий пул вместо закреплений.** Все полевые сотрудники работают по всему парку (подтверждено владельцем), поэтому «ответственного за объект» в данных нет. Задача создаётся свободной, её берёт первый освободившийся. Моделировать закрепление, которого нет в жизни, — значит заставить людей обходить систему вручную.
- **Парк — растущая величина.** Автоматы подтягиваются из внешних систем постепенно. Нигде нельзя закладываться на «объектов мало»: любой список объектов — с поиском и пагинацией, любое перечисление типов узлов — с запасом на будущие модели.
- **Каждая мутация пишет в `auditLog`** (`before`/`after`, `actorKind`/`actorRef`).
- **Кириллица никогда не идёт в `callback_data`.**

### 1.3 Явно НЕ делаем в этой итерации (out of scope)

| Не делаем | Почему |
|---|---|
| **Telegram Mini App** | Требует публичного HTTPS-домена. `deploy/docker-compose.yml` биндит Core и панель на `127.0.0.1`, `telegram.ts:1-6` фиксирует «ноль открытых портов, только Tailscale». Это отмена архитектурного решения, а не фича. `verifyInitData` лежит внутри `@mydon/bot` без `exports` и в панель не импортируется. |
| **Геолокация, `request_location`, живая геопозиция** | `geo_point` у автоматов массово пуст (заполняется руками из `attrs["широта"]`). Живая геопозиция требует `edited_message` в `allowed_updates` — отдельная переделка транспорта. Ценность нулевая, пока нет координат. |
| **`notification_outbox`, адресат в `Rule`, ключ `eventId:ruleId:recipientId`** | Новые уведомления сотруднику идут **через задачи** (`ensureForDay` → `sendReminders`). Правила по-прежнему адресуются только владельцу, значит существующий ключ `${eventId}:${ruleId}` корректен. Переделка контракта уведомлений — отдельная задача. |
| **Модельные шаблоны графиков (`scope_kind='model'`), развёртка, `derived_from_plan_id`** | Карточек `equipment_model` для автоматов нет ни одной. Кнопка «применить план к списку автоматов» решает то же без трёх колонок и правил наследования. |
| **Чек-листы как таблица (`checklist_template` + ответы)** | Каждый пункт = шаг визарда поверх in-memory `Conversations` (TTL 15 мин, умирает при рестарте). Техник в подвале потеряет 12 шагов. В V1: `note` + фото + один вопрос «всё сделал?». |
| **Пополнение снек/дринк-автомата из бота (`fl:`)** | Писать некуда: `machine_slot` — зеркало OurVend (`ingestSlots` перетирает `quantity` по крону `0 */3 * * *`), `vending_stock` — центральный склад по имени товара. Нужна отдельная таблица `vending_refill` и отдельное решение владельца. |
| **Маршрут с порядком объезда (`route_stop`), зоны, `service_route`** | В V1 «мой день» = мои задачи на сегодня, сгруппированные по объекту через `task.entityId`. Оптимизация маршрута — после того, как появятся координаты и подтверждённые маршруты. |
| **Склад ЗИП под отчёт, пломбы, договоры с точками, KPI, партии и даты вскрытия, возвраты денег покупателю** | Доменно нужно (см. §10), но не входит в шесть требований и раздувает итерацию вчетверо. |
| **Голосовые отчёты** | `attachment.kind` не примет аудио как `photo`, как `doc` файл ляжет без расширения, расшифровки нет. |
| **pHash фото, EXIF-проверки** | Telegram вырезает EXIF при отправке как `photo`. Новая нативная зависимость ради «фильтра лени», который обходится пересъёмкой. Дедуп по `file_unique_id` — бесплатно и достаточно. |

---

## 2. Что уже есть

| Возможность | Текущее состояние (проверено по коду) | Что доделать |
|---|---|---|
| Опознание сотрудника | `person.tgChatId` unique, `personByChat` ищет `active='yes'`. `linkTelegram()` привязывает по `@username` на **любое** первое сообщение | **Дыра безопасности:** освободившийся ник даёт доступ к карточке. Закрыть приглашениями + тумблер `STAFF_LINK_BY_USERNAME` |
| Роли | `person.role` — свободный текст, **в боте не читается ни разу** | Колонка `person.roles text[]`, матрица прав в `@mydon/shared`, фильтр меню |
| Задачи сотрудника | `GET /tasks?ownerKind=human&ownerRef=&open=1`, кнопки `▶️ Взял` / `✅ Сделал`, обязательный текстовый отчёт через `AwaitingReport` | Задача не знает объекта (`task.entityId` нет) → нет группировки по точке. Нет фото при закрытии |
| Меню | Меню нет. 8 текстовых триггеров + `HELP_STAFF` списком | Кнопочное меню (reply-клавиатура), единый реестр триггеров |
| Отмена мастера | Только текстом «отмена». `i:cancel`, `n:cancel`, `cf:cancel`, `cw:cancel`, `cc:cancel` **парсятся, но не рендерятся** | Кнопка `✖️ Отмена` на каждом шаге |
| Фото | `TelegramApi.downloadFile()` → `CoreClient.uploadPhoto()` → `POST /attachments` → таблица `attachment`. Подключено **только** к визарду регистрации карточки | Стадия «до/после» (нет поля), привязка к задаче и к записи обслуживания |
| Запчасть как карточка | `entity.type = "component"` уже создаётся визардом `staff-register.ts:20-23` («новая запчасть») | `component` отсутствует в `apps/cc/src/lib/labels.ts` → в реестре видно латиницей. Нет экземпляра узла на автомате (S/N, дата установки) |
| Замена узла | Ничего. `coffee_wash_event_kind` содержит `replace`/`service`, но только для кофе-точки, без указания что заменили | Таблицы `maintenance_log` + `machine_part` |
| График обслуживания | `coffee_wash_schedule` + `washScheduleStatus()` — единственный прототип, привязан к `coffee_location`, только мойка. Дефекты: `toISOString().slice(0,10)` в **UTC** (`coffee.service.ts:1128`), `Math.floor(ms/86_400_000)` вместо календарных дней (`:1121`), чтение всего журнала в память | Generic-график `maintenance_plan` для `entity × part_kind`. Кофейную мойку **не трогаем** |
| Напоминания сотруднику | `sendReminders()` — единственный проактивный push. Окно жёстко `tasksDueSoon(24)`, `remindedAt` ставится один раз навсегда | **Баг:** если сотруднику 403, но задача просрочена и дошла до владельца — `delivered = true`, `markReminded` ставится, сотрудник не узнает никогда (`index.ts:263-278`) |
| Ошибки Telegram | `telegram.ts:66` схлопывает 403 / 429 / 500 в безымянный `Error`. У `sendMessage`/`editMessage`/`answerCallback` **нет таймаута** | `TelegramError` с `error_code`/`retry_after`, таймаут на метод, лимитер исходящих |
| `editMessage` | `telegram.ts:115-121` — без `reply_markup`, то есть **снимает** клавиатуру | Необязательный параметр `keyboard` |
| Клавиатуры | Только `InlineKeyboard`. `ReplyKeyboardMarkup` нет нигде | Тип + поддержка в `sendMessage` |
| Правила уведомлений | 28 правил, `Notification = {ruleId, urgency, text}`, доставка `for (const chatId of allowlist)` — только владелец | Новые правила для эскалации по ТО (владельцу). Контракт не меняем |
| Экраны панели | `/tasks`, `/tasks/[id]`, `/card/[id]` (галерея фото entity), `/team`, `/domain/vendhub` (вкладки vending / coffee / collect / tasks) | Вкладка «Обслуживание», блок «Узлы» в карточке автомата, фото по стадиям в карточке задачи |

---

## 3. Роли и подключение сотрудников

### 3.1 Модель прав

**Решение: статическая матрица `role → permissions` в `packages/shared`, массив ролей на строке `person`. Никакого редактора прав в БД.**

Обоснование: 7 ролей и ~12 сотрудников. Матрица в коде ревьюится в диффе и покрывается тестом; матрица в базе не ревьюится никем. Одна роль на человека ломается на первом же случае «оператор, который сам снимает кассу» — поэтому массив и объединение прав.

`person.role` **остаётся** и меняет смысл: должность словами («старший оператор смены Б»), для глаза. Права — в новой колонке `person.roles`.

#### `/home/user/mydon/packages/shared/src/roles.ts` (новый файл)

```ts
/**
 * Роли и права сотрудников MYDON.
 *
 * Роль — про то, что человек делает руками (заливает бункер, снимает кассу),
 * а не про должность: должность остаётся свободным текстом в person.role.
 * Права выводятся из ролей и НИГДЕ не хранятся на человеке — иначе матрица
 * расползается по базе и её нельзя прочитать в диффе.
 *
 * Один человек носит несколько ролей (оператор, который сам снимает кассу) —
 * права складываются объединением.
 */

export const STAFF_ROLES = [
  "owner",
  "manager",
  "operator",
  "technician",
  "collector",
  "warehouse",
  "accountant",
] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];

export const ROLE_LABELS: Record<StaffRole, string> = {
  owner: "Владелец",
  manager: "Менеджер",
  operator: "Оператор",
  technician: "Техник",
  collector: "Инкассатор",
  warehouse: "Кладовщик",
  accountant: "Бухгалтер-кассир",
};

/** Одна строка «чем занимается» — показывается владельцу при выборе роли. */
export const ROLE_HINTS: Record<StaffRole, string> = {
  owner: "Всё: согласования, деньги, доступы, система.",
  manager: "Ставит задачи, принимает работу, ведёт нормативы, принимает инкассацию.",
  operator: "Ездит по точкам: заливка бункеров, расходники, чистка.",
  technician: "Ремонт и замена узлов, технический осмотр, санобработка.",
  collector: "Снимает выручку с автоматов и везёт в офис.",
  warehouse: "Приход сырья, выдача комплектов, инвентаризация.",
  accountant: "Принимает и пересчитывает инкассацию, сводки по деньгам.",
};

/** Права — про возможности в боте и панели. Список закрытый. */
export const PERMISSIONS = [
  "tasks.own",
  "tasks.assign",
  "tasks.rate",
  "coffee.refill",
  "coffee.wash",
  "coffee.consumable",
  "parts.replace",
  "maintenance.view",
  "maintenance.plan",
  "cash.collect",
  "cash.receive",
  "stock.intake",
  "stock.count",
  "registry.propose",
  "registry.approve",
  "reports.domain",
  "people.manage",
  "system.admin",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

/**
 * Право, которое есть у всех подключённых, даже с ненастроенными ролями:
 * иначе новый сотрудник не увидит вообще ничего и решит, что бот сломан.
 */
const BASELINE: readonly Permission[] = ["tasks.own"];

/** Владельцу выдаётся весь список ссылкой: забыть право — значит запереть его снаружи. */
export const ROLE_PERMISSIONS: Record<StaffRole, readonly Permission[]> = {
  owner: PERMISSIONS,
  manager: [
    "tasks.own", "tasks.assign", "tasks.rate", "maintenance.view", "maintenance.plan",
    "cash.receive", "stock.count", "registry.propose", "reports.domain",
  ],
  operator: [
    "tasks.own", "coffee.refill", "coffee.wash", "coffee.consumable",
    "maintenance.view", "registry.propose",
  ],
  technician: [
    // Техник доливает по ходу ремонта — запрещать нечего.
    "tasks.own", "coffee.refill", "coffee.wash", "parts.replace",
    "maintenance.view", "registry.propose",
  ],
  collector: ["tasks.own", "cash.collect"],
  warehouse: ["tasks.own", "stock.intake", "stock.count", "registry.propose"],
  accountant: ["tasks.own", "cash.receive", "reports.domain"],
};

export function isStaffRole(value: unknown): value is StaffRole {
  return typeof value === "string" && (STAFF_ROLES as readonly string[]).includes(value);
}

/**
 * Приводит то, что лежит в базе, к списку известных ролей.
 * Неизвестное молча отбрасывается: «непонятная роль» не должна ни давать
 * прав, ни ронять обработчик.
 */
export function normalizeRoles(raw: unknown): StaffRole[] {
  if (!Array.isArray(raw)) return [];
  const out = new Set<StaffRole>();
  for (const item of raw) if (isStaffRole(item)) out.add(item);
  return STAFF_ROLES.filter((r) => out.has(r)); // стабильный порядок для UI и аудита
}

export function can(roles: readonly string[] | null | undefined, perm: Permission): boolean {
  if (BASELINE.includes(perm)) return true;
  for (const role of normalizeRoles(roles)) {
    if ((ROLE_PERMISSIONS[role] as readonly string[]).includes(perm)) return true;
  }
  return false;
}

/** Роли не заданы — это НЕ «наблюдатель», а «доступ ещё не настроен». */
export function isUnconfigured(roles: readonly string[] | null | undefined): boolean {
  return normalizeRoles(roles).length === 0;
}

/** Человеку — списком через запятую: «Оператор, Инкассатор». */
export function rolesLabel(roles: readonly string[] | null | undefined): string {
  const list = normalizeRoles(roles);
  return list.length === 0 ? "роль не задана" : list.map((r) => ROLE_LABELS[r]).join(", ");
}

/**
 * Как владелец мог назвать роль руками — для разового переноса person.role.
 * Только точное совпадение нормализованной строки: угадывать по подстроке
 * опасно — «водитель-экспедитор склада» получил бы права кладовщика.
 */
export const ROLE_ALIASES: Record<string, StaffRole> = {
  владелец: "owner", хозяин: "owner", boss: "owner",
  менеджер: "manager", менежер: "manager", супервайзер: "manager",
  руководитель: "manager", управляющий: "manager", manager: "manager",
  оператор: "operator", заправщик: "operator", operator: "operator",
  мерчендайзер: "operator", "оператор кофе": "operator", "оператор автоматов": "operator",
  техник: "technician", механик: "technician", мастер: "technician",
  сервис: "technician", "сервисный инженер": "technician", texnik: "technician",
  инкассатор: "collector", кассир: "collector", "сбор наличных": "collector",
  кладовщик: "warehouse", склад: "warehouse", завсклад: "warehouse", ombor: "warehouse",
  бухгалтер: "accountant", бух: "accountant", buxgalter: "accountant",
};

export function guessRole(freeText: string | null | undefined): StaffRole | null {
  if (typeof freeText !== "string") return null;
  // ё→е делаем ДО поиска, поэтому в словаре ключей с «ё» быть не должно.
  const key = freeText.trim().toLowerCase().replace(/ё/g, "е").replace(/\s+/g, " ");
  if (key.length === 0) return null;
  if (isStaffRole(key)) return key;
  return ROLE_ALIASES[key] ?? null;
}
```

Экспорт добавить в `/home/user/mydon/packages/shared/src/index.ts`: `export * from "./roles";`

### 3.2 Принуждение прав

**Основная точка принуждения — бот:** пункт меню не показывается, текстовый триггер отбивается вежливым отказом.

**Core проверяет только там, где цена ошибки реальна:** `POST /stock/movement`, `POST /stock/stocktake`, `POST /maintenance/log` (для `kind='part_replace'`). В `POST /collections` проверка бессмысленна — контроллер конструирует actor-строку из тела запроса. В `POST /approvals/:id/decide` сотрудников нет вовсе.

Нужно добавить в `/home/user/mydon/apps/core/src/people/people.service.ts`:

```ts
  /** Разбор actor-строки бота: "person:<uuid>" | "owner" | "agent:<имя>". */
  static personIdOf(actorRef: string | null | undefined): string | null {
    const m = /^person:([0-9a-f-]{36})$/.exec(actorRef ?? "");
    return m ? m[1] : null;
  }

  /**
   * Тумблер читаем прямо из systemConfig — синхронного геттера у SystemService
   * нет, а импортировать SystemModule в PeopleModule ради одного значения дорого.
   * Тот же приём уже применён в units.service.ts.
   */
  private enforceCache: { value: boolean; at: number } | null = null;

  private async enforcing(): Promise<boolean> {
    if (this.enforceCache && Date.now() - this.enforceCache.at < 60_000) {
      return this.enforceCache.value;
    }
    const [row] = await this.db
      .select().from(systemConfig).where(eq(systemConfig.key, "ROLES_ENFORCE")).limit(1);
    const value = (row?.value ?? process.env.ROLES_ENFORCE ?? "0") === "1";
    this.enforceCache = { value, at: Date.now() };
    return value;
  }

  /**
   * Мягкий режим (ROLES_ENFORCE=0) только пишет отказ в журнал и пропускает:
   * включать принуждение раньше, чем проставлены роли, — значит одномоментно
   * выключить всю смену.
   */
  async assertCan(actorRef: string | null | undefined, perm: Permission): Promise<void> {
    const personId = PeopleService.personIdOf(actorRef);
    if (personId === null) return; // владелец / агент / система ходят по service-token
    const [row] = await this.db
      .select({ roles: person.roles }).from(person).where(eq(person.id, personId)).limit(1);
    if (row && can(row.roles, perm)) return;
    const enforced = await this.enforcing();
    await this.db.insert(auditLog).values({
      actorKind: "human", actorRef, action: "access.denied", target: perm,
      after: { roles: row?.roles ?? [], enforced },
    });
    if (enforced) throw new ForbiddenException(`Нет права «${perm}»: ${rolesLabel(row?.roles)}`);
  }
```

Тумблеры в `/home/user/mydon/apps/core/src/system/config-spec.ts`:

```ts
  {
    key: "ROLES_ENFORCE",
    label: "Проверять права сотрудников",
    kind: "bool",
    fallback: "0",
    help: "0 — только пишем отказы в журнал (обкатка). 1 — реально запрещаем.",
    validate: oneOf(["0", "1"]),
  },
  {
    key: "STAFF_LINK_BY_USERNAME",
    label: "Привязка по @username (старый способ)",
    kind: "bool",
    fallback: "0",
    help: "0 — только по приглашению. 1 — старое поведение, небезопасно: чужой ник даёт доступ.",
    validate: oneOf(["0", "1"]),
  },
```

### 3.3 Порядок раскатки ролей

1. Деплой `schema` + `shared` + Core с `ROLES_ENFORCE=0`. Все `roles` пусты, но `BASELINE` даёт «свои задачи» — бот не замолкает.
2. `pnpm --filter @mydon/db db:backfill:roles` — сухой прогон, показать владельцу список.
3. То же с `-- --apply`.
4. Владелец в `/team` дозаполняет непознанных и добавляет вторые роли.
5. Через неделю смотрим `audit_log` где `action = 'access.denied'` — это список того, что матрица режет напрасно. Правим матрицу.
6. `ROLES_ENFORCE=1`.

Скрипт `/home/user/mydon/packages/db/src/backfill-roles.ts` пишется по образцу `packages/db/src/seed.ts`: `loadEnv` из корня → `createDb(process.env.DATABASE_URL)` → цикл → `process.exit(0)`. Синглтона `db` в `packages/db/src/index.ts` **нет**, экспортируется только `createDb(connectionString)`. Скрипт `"db:backfill:roles": "node dist/backfill-roles.js"` добавить в `packages/db/package.json`.

Правило переноса: **неопознанное → пустой массив, никогда не догадка.** Каждая проставленная роль — строка в `auditLog` с `action: "person.roles_changed"`, `actorRef: "backfill-roles"`.

### 3.4 Подключение сотрудника: приглашение

#### Проблема, которую закрываем

`people.service.ts:126-135` — `linkTelegram()` ищет `or(eq(person.tgUsername, uname), eq(person.tgChatId, chatId))` при `active='yes'` и вызывается на **любое** первое сообщение от незнакомого чата. Telegram-ники освобождаются и перерегистрируются: сегодня доступ «оператора Рустама» получает любой, кто занял его освободившийся ник.

#### Процедура

**а) Владелец в панели `/team`** заполняет форму (компонент `apps/cc/src/components/person-new.tsx`): имя, телефон, направление, должность словами, чипы ролей. Нажимает «Создать и выдать доступ».

**б) Панель показывает карточку приглашения** — единственный момент, когда секрет виден:

```
✅ Рустам Тошматов создан. Роли: Оператор, Инкассатор.

Ссылка для подключения — отправь Рустаму в личку:
  https://t.me/mydon_bot?start=k7Qm2xR9vT4bN1pL8sW3dF6h
                                         [Скопировать]

Если ссылка не доходит — продиктуй код:  MQPT-4K7H

⏳ Живёт 48 часов, срабатывает один раз.
⚠️ Не отправляй в группу: кто первый перейдёт — тот и станет Рустамом.
                                    [Выпустить новый] [Отозвать]
```

**в) Сотрудник переходит по ссылке** → бот получает `/start k7Qm...` → `POST /people/invites/redeem` → привязка `tgChatId`, приветствие, меню.

**г) Владельцу немедленно уходит уведомление** с кнопкой отзыва:

```
🔑 Рустам Тошматов подключился к боту.
   @rustam_t · chat 5544332211
   Роли: Оператор, Инкассатор

   [ Это не он — отозвать ]
```

#### Генерация секретов: `/home/user/mydon/packages/shared/src/invite.ts` (новый)

```ts
/**
 * Приглашения сотрудников: секрет для диплинка и короткий код на голос.
 *
 * Формат секрета — base64url: Telegram пускает в start-payload только
 * [A-Za-z0-9_-] и не больше 64 символов. 24 байта = 32 символа, запас есть.
 */
import { createHash, randomBytes } from "node:crypto";

export const INVITE_TTL_HOURS = 48;

/** Алфавит без пар, которые путают на слух и на глаз: O/0, I/1, S/5, B/8, Z/2. */
const CODE_ALPHABET = "ACDEFGHJKLMNPQRTUVWXY34679";
const CODE_LEN = 8;

export function newInviteToken(): string {
  return randomBytes(24).toString("base64url");
}

/** Короткий код вида «MQPT-4K7H»: 26^8 ≈ 2·10^11 вариантов. */
export function newInviteCode(): string {
  const max = 256 - (256 % CODE_ALPHABET.length);
  let out = "";
  while (out.length < CODE_LEN) {
    for (const b of randomBytes(CODE_LEN)) {
      // Хвост диапазона отбрасываем: иначе первые буквы алфавита выпадают чаще.
      if (b >= max) continue;
      out += CODE_ALPHABET[b % CODE_ALPHABET.length];
      if (out.length === CODE_LEN) break;
    }
  }
  return `${out.slice(0, 4)}-${out.slice(4)}`;
}

/** Человек напишет с пробелами, в нижнем регистре и без дефиса — это одно и то же. */
export function normalizeInviteCode(raw: string): string | null {
  const clean = raw.toUpperCase().split("").filter((ch) => CODE_ALPHABET.includes(ch)).join("");
  return clean.length === CODE_LEN ? clean : null;
}

/**
 * Хеш секрета. HMAC с перцем из env, а не голый sha256: у 8-символьного кода
 * всего 2·10^11 вариантов, и при утечке дампа голый sha256 перебирается за минуты.
 */
export function hashInviteSecret(secret: string, pepper: string): string {
  return createHash("sha256").update(`${pepper}\u0000${secret}`, "utf8").digest("hex");
}

/** Форма секрета до похода в базу: мусор отсеиваем, не тратя запрос. */
export function isInviteTokenShape(value: string): boolean {
  return /^[A-Za-z0-9_-]{22,64}$/.test(value);
}

export function inviteDeepLink(botUsername: string, token: string): string {
  return `https://t.me/${botUsername.replace(/^@/, "")}?start=${token}`;
}
```

Перец — новая переменная `INVITE_PEPPER` в `.env.example` и в `deploy/docker-compose.yml` (блок `mydon-core.environment`). При пустом перце сервис бросает на старте.

#### Погашение: `/home/user/mydon/apps/core/src/people/invites.service.ts` (новый)

Ключевые инварианты:

- Поиск по `codeHash` — **только среди живых** (`used_at is null and revoked_at is null`) и с `orderBy(desc(createdAt))`: уникальность кода частичная, исторические строки с тем же кодом законны.
- Захват — условием в `UPDATE … WHERE used_at IS NULL … RETURNING`: гонку решает база.
- Неактивная карточка — **откат транзакции через `throw`**, а не `return`: возврат из колбэка drizzle коммитит, и приглашение сгорело бы впустую.
- Секрет **никогда** не попадает в `auditLog`.

```ts
export type RedeemFail = "not_found" | "expired" | "used" | "revoked" | "inactive";
export type RedeemResult =
  | { ok: true; person: PersonRow; firstTime: boolean }
  | { ok: false; reason: RedeemFail };

/** Служебная: нужна, чтобы выйти из транзакции откатом, а не коммитом. */
class InviteInactive extends Error {}

  async redeem(input: {
    token?: string; code?: string; chatId: string; username: string | null;
  }): Promise<RedeemResult> {
    const byToken = typeof input.token === "string" && isInviteTokenShape(input.token);
    const normalized = input.code ? normalizeInviteCode(input.code) : null;
    if (!byToken && normalized === null) return this.fail(null, input, "not_found");

    const hash = hashInviteSecret(byToken ? input.token! : normalized!, this.pepper);
    const live = and(isNull(staffInvite.usedAt), isNull(staffInvite.revokedAt));
    const [inv] = await this.db
      .select().from(staffInvite)
      .where(byToken ? eq(staffInvite.tokenHash, hash) : and(eq(staffInvite.codeHash, hash), live))
      .orderBy(desc(staffInvite.createdAt))
      .limit(1);

    if (!inv) return this.fail(null, input, "not_found");
    if (inv.revokedAt !== null) return this.fail(inv.id, input, "revoked");
    if (inv.usedAt !== null) return this.fail(inv.id, input, "used");
    if (inv.expiresAt.getTime() <= Date.now()) return this.fail(inv.id, input, "expired");

    try {
      return await this.db.transaction(async (tx) => {
        const [claimed] = await tx.update(staffInvite)
          .set({ usedAt: new Date(), usedByChatId: input.chatId })
          .where(and(
            eq(staffInvite.id, inv.id),
            isNull(staffInvite.usedAt), isNull(staffInvite.revokedAt),
            gt(staffInvite.expiresAt, new Date()),
          ))
          .returning();
        if (!claimed) return { ok: false as const, reason: "used" as const };

        const [target] = await tx.select().from(person).where(eq(person.id, inv.personId)).limit(1);
        if (!target || target.active !== "yes") throw new InviteInactive();

        // Один Telegram — один сотрудник: чужую привязку снимаем, и это видно в журнале.
        const stolen = await tx.update(person).set({ tgChatId: null })
          .where(and(eq(person.tgChatId, input.chatId), ne(person.id, target.id)))
          .returning({ id: person.id });

        const [linked] = await tx.update(person)
          .set({ tgChatId: input.chatId, tgUsername: normalizeUsername(input.username) ?? target.tgUsername })
          .where(eq(person.id, target.id)).returning();

        await tx.insert(auditLog).values({
          actorKind: "system", actorRef: `telegram:${input.chatId}`,
          action: "person.access_granted", target: target.id,
          before: { tgChatId: target.tgChatId },
          after: {
            inviteId: inv.id, chatId: input.chatId, username: input.username,
            roles: linked.roles, detachedFrom: stolen.map((s) => s.id),
          },
        });
        return { ok: true as const, person: linked, firstTime: target.tgChatId === null };
      });
    } catch (e) {
      if (e instanceof InviteInactive) return { ok: false, reason: "inactive" };
      throw e;
    }
  }
```

REST (объявить **выше** параметрических маршрутов, как уже сделано для `link` в `people.controller.ts`):

- `POST /people/:id/invite` → `{ inviteId, token, code, expiresAt, deepLink }`
- `POST /people/invites/redeem` `{ token?, code?, chatId, username? }`
- `POST /people/:id/invite/revoke` `{ reason }`
- `POST /people/invites/active` — список непогашенных для брифинга. Именно `POST`, а не `GET`: `ServiceTokenGuard` (`common/service-token.guard.ts:38`) пропускает все `GET` без токена, а ручка отдаёт имена сотрудников.
- `POST /people/:id/deactivate` `{ reassignTo?, reason? }`

#### Тексты бота при погашении

```ts
/**
 * «Не найдено» — намеренно безликое: подтверждать существование кода тому,
 * кто его подбирает, не надо. Остальные случаи означают, что секрет человек
 * всё-таки знал — там честный текст полезнее.
 */
const REDEEM_FAIL: Record<RedeemFail, string> = {
  not_found: "Ссылка не подошла. Попроси владельца прислать новую.",
  expired: "Срок ссылки вышел (она живёт 48 часов). Попроси владельца выпустить новую.",
  used: "Эта ссылка уже сработала. Если заходил не ты — срочно скажи владельцу.",
  revoked: "Ссылку отозвали. Попроси владельца выпустить новую.",
  inactive: "Карточка сотрудника отключена. Обратись к владельцу.",
};
```

Ветка `/start <payload>` в `index.ts` идёт **до** `isAllowed(chatId)`: у нового сотрудника чата в allowlist нет и быть не может. Payload в лог **не пишем**.

Ограничитель попыток `InviteLimiter` в `apps/bot/src/security/access.ts`: 5 неудач/час на чат, 30/час глобально; **успешное погашение попыток не тратит** — наказываем подбор, а не человека, перешедшего по ссылке дважды. Плюс счётчик `attempts` на самой строке приглашения.

### 3.5 Отзыв доступа ≠ увольнение

| Операция | `active` | `tgChatId` | Приглашения | Задачи | Закрепления |
|---|---|---|---|---|---|
| Отзыв доступа (потерян телефон, подозрение) | `yes` | → `null` | гасятся | не трогаем | не трогаем |
| Увольнение (`deactivate`) | → `no` | → `null` | гасятся | распускаются | закрываются датой |

`deactivate()` в `PeopleService` — одной транзакцией, **массовыми** UPDATE (без N+1):

```ts
      // Открытые задачи распускаются: висеть на человеке, который не увидит
      // бота, они не должны. remindedAt сбрасывается, иначе задача больше
      // никогда не всплывёт — dueSoon() требует remindedAt is null.
      const open = await tx.update(task)
        .set({
          ownerRef: opts.reassignTo ?? null,
          remindedAt: null,
          redoNotifiedAt: null,
        })
        .where(and(
          eq(task.ownerKind, "human"), eq(task.ownerRef, personId),
          ne(task.status, "done"), ne(task.status, "cancelled"),
        ))
        .returning({ id: task.id, title: task.title });

      if (open.length > 0) {
        await tx.insert(taskComment).values(open.map((t) => ({
          taskId: t.id, authorRef: actorRef,
          body: opts.reassignTo
            ? `${before.name} отключён — задача передана другому исполнителю.`
            : `${before.name} отключён — задача осталась без исполнителя.`,
        })));
      }
```

Инкассации, заливки, записи обслуживания **не трогаем никогда**: это история, а не назначение.

### 3.6 Владелец и `TELEGRAM_ALLOWED_CHAT_IDS`

**Не мигрируем и не удаляем.** Allowlist понижается до аварийного контура:

```ts
// Порядок важен. Сначала база (там роли и объекты), allowlist — страховка.
const person = await personOf(chatId);
if (person !== null && can(person.roles, "system.admin")) return handleOwner(chatId, text, person);
if (person !== null) return handleStaff(chatId, text, person);
if (isAllowed(chatId, allowlist)) return handleOwnerFallback(chatId, text);
return; // посторонний — молчим, как и раньше
```

Три причины оставить allowlist: `personOf()` возвращает `null` при **любой** ошибке Core (`index.ts:114-121`) — при упавшей базе владелец потерял бы бота именно тогда, когда он нужен; инфраструктурные тревоги (`infra.disk`, watchdog) обязаны доходить при недоступной базе; владелец, случайно снявший себе роль, чинится через allowlist, а не через psql на проде.

В `.env.example` комментарий переписать: «аварийный доступ владельца, **НЕ** список сотрудников».

### 3.7 Аудит

| `action` | Когда | `actorKind` / `actorRef` | `target` |
|---|---|---|---|
| `person.roles_changed` | изменён набор ролей | human/owner, system/backfill-roles | personId |
| `person.invite_issued` / `_reissued` / `_revoked` | жизненный цикл приглашения | human/owner | personId |
| `person.invite_redeem_failed` | неудачное предъявление (агрегировать: `not_found` логировать только со 2-й попытки чата) | system/`telegram:<chatId>` | inviteId \| null |
| `person.access_granted` | привязка создана | system/`telegram:<chatId>` | personId |
| `person.access_revoked` | отзыв доступа | human/owner | personId |
| `person.deactivated` | увольнение | human/owner | personId |
| `task.claimed` | сотрудник взял свободную задачу из общего пула | human | personId |
| `access.denied` | отказ по праву | human/`person:<id>` | код права |
| `maintenance.log_created` | запись обслуживания | human/`person:<id>` | logId |
| `maintenance.part_swapped` | закрытие/открытие периода узла | human/`person:<id>` | machineId |
| `maintenance.plan_changed` | правка норматива | human/owner | planId |
| `staff.bot_blocked` | Telegram вернул 403 | system/bot | personId |

Регулярные вопросы к `/audit`: `person.invite_redeem_failed` >3 за час с одного чата (подбор); `person.access_granted` с непустым `detachedFrom` (аккаунт переехал); `access.denied` в мягком режиме (материал для правки матрицы).

---

## 4. Модель данных

### 4.1 Общее

Все определения — в `/home/user/mydon/packages/db/src/schema.ts`, **перед** объектом `export const schema` (сейчас строка ~1683). Хелперы `id()` и `createdAt()` уже объявлены (`:43-44`). Импорты `pgEnum`, `date`, `check`, `uniqueIndex`, `boolean` уже есть.

**Обязательный шаг:** каждую новую таблицу внести в `export const schema = {...}`. Комментарий там предупреждает прямо: «Пропущенная таблица экспортируется, но реляционному слою и инструментам невидима — молча неполная схема». Тест `packages/db/src/schema.test.ts` это ловит рефлексией.

### 4.2 Новые перечисления

```ts
// ── Обслуживание оборудования: узлы, работы, графики ──
//
// Три уровня, намеренно разделённые:
//   норматив  (maintenance_plan) — «менять фильтр раз в 90 дней»
//   факт      (maintenance_log)  — «12.03 Рустам заменил, фото до/после»
//   состояние (machine_part)     — «на автомате X сейчас стоит купюроприёмник S/N 456»
//
// Статус «пора/просрочено» НЕ хранится: он считается из норматива и факта на
// чтении. Хранится только то, что человек ввёл, — иначе кэш разойдётся с
// правдой, как это уже случалось с кэшем остатка (см. stock_movement).
//
// Кофейная мойка сюда НЕ переносится: у неё свой контур
// (coffee_wash_schedule + coffee_wash_log) с ключом «точка × позиция 1..8»,
// свой экран и свои тесты. Копия фактов в двух журналах дала бы двойной счёт
// и разные ответы на вопрос «когда мыли».

/** Что за работа. Один список на все направления: у ТО автомата и техосмотра одна форма. */
export const maintenanceKindEnum = pgEnum("maintenance_kind", [
  "inspection",   // технический осмотр
  "cleaning",     // чистка (не кофе-бункер)
  "sanitation",   // санобработка
  "service",      // регламентное ТО
  "part_replace", // замена узла
  "repair",       // ремонт по поломке (вне графика)
  "calibration",  // калибровка / поверка
  "other",
]);

/** Чем кончилось. «Приехал и не смог» — это не «сделано», отчётность должна их различать. */
export const maintenanceOutcomeEnum = pgEnum("maintenance_outcome", [
  "done",       // сделано полностью
  "partial",    // сделано частично (не было запчасти, не хватило времени)
  "failed",     // не сделано: не попал, автомат недоступен, обнаружена поломка
  "not_needed", // приехал — делать было нечего
]);

/**
 * Узел автомата. Enum, а не справочник в БД: список закрытый и меняется раз
 * в год, а TS ловит опечатку на компиляции. Значения латиницей — идут прямо
 * в callback_data без индексов (pt:u:bill_acceptor = 20 байт из 64), потому
 * что индекс хрупок: ALTER TYPE ... ADD VALUE в середину сдвинул бы нумерацию.
 * Уточнение модели — в machine_part.title / part_model_id.
 */
export const partKindEnum = pgEnum("part_kind", [
  "bill_acceptor",    // купюроприёмник (он же «купюрник», «банкнотник»)
  "coin_acceptor",    // монетоприёмник
  "coin_hopper",      // хоппер выдачи сдачи
  "payment_terminal", // платёжный терминал / QR-модуль
  "brewer",           // варочный блок
  "grinder",          // кофемолка
  "burrs",            // жернова
  "mixer",            // миксер / венчик
  "pump",             // помпа
  "boiler",           // бойлер / ТЭН
  "valve",            // клапан
  "water_filter",     // фильтр воды
  "compressor",       // компрессор (снек/дринк)
  "condenser",        // радиатор холодильника (конденсатор)
  "spiral",           // пружина / спираль слота
  "cup_dispenser",    // выдача стаканов
  "display",          // дисплей
  "mainboard",        // плата управления
  "modem",            // модем / модуль связи
  "lock",             // замок
  "other",
]);

/** Почему узел сняли. Без этого не отличить «сломался за 3 месяца» от плановой замены. */
export const partRemovalReasonEnum = pgEnum("part_removal_reason", [
  "failure",    // вышел из строя
  "preventive", // плановая замена по регламенту
  "upgrade",    // замена на лучшую модель
  "warranty",   // отправлен по гарантии
  "moved",      // переставлен на другой автомат
  "unknown",
]);
```

### 4.3 `maintenance_log` — факт

```ts
/**
 * Журнал выполненных работ. Append-only: ошибку исправляют новой записью или
 * мягким удалением через сервис, а не правкой прошлого.
 *
 * `performed_on` — календарная дата обхода в Asia/Tashkent, отдельно от
 * `performed_at`. Именно по ней считаются интервалы: washScheduleStatus режет
 * ISO-строку в UTC (coffee.service.ts:1128) и для работы после 19:00 по
 * Ташкенту берёт вчерашний день — здесь этот дефект закрыт на уровне типа
 * колонки (как в coffee_refill.entered_date).
 *
 * `outcome` НУЛЛЯБЕЛЬНО без default: null = «работа начата, не завершена».
 * Так запись существует ДО съёмки фото «до» (attachment.owner_id — @IsUUID()
 * существующей строки, привязать фото «в воздух» нельзя), и при этом
 * незавершённая работа не двигает last_done_on и не гасит план.
 *
 * Фото — в attachment с owner_type='maintenance_log', owner_id=<id>,
 * stage='before'|'after'|'plate'. Ни новой таблицы вложений, ни нового kind.
 *
 * FK на machine_part здесь НЕТ намеренно: хватает part_kind, а экземпляр
 * восстанавливается по (entity_id, part_kind, дата внутри периода). Взаимные
 * FK усложняют вставку и ничего не дают.
 */
export const maintenanceLog = pgTable(
  "maintenance_log",
  {
    id: id(),
    /** Объект работы: автомат, техника, объект недвижимости. */
    entityId: uuid("entity_id").references(() => entity.id).notNull(),
    domain: domainEnum("domain").default("vendhub").notNull(),
    kind: maintenanceKindEnum("kind").notNull(),
    partKind: partKindEnum("part_kind"),
    /** Задача, по которой работали: отчёт и фото должны быть на одной нитке. */
    taskId: uuid("task_id").references(() => task.id),
    /** null — работа начата и не завершена. Заполняется на шаге подтверждения. */
    outcome: maintenanceOutcomeEnum("outcome"),
    /** Показание счётчика с дисплея автомата — для планов «раз в N порций». */
    counterValue: integer("counter_value"),
    /** Кто делал, если это сотрудник: нужен FK, иначе не посчитать нагрузку
     *  (в coffee_wash_log.performed_by лежит свободный текст — так делать не надо). */
    performedById: uuid("performed_by_id").references(() => person.id),
    /** Кто делал, если это не сотрудник: "owner" | подрядчик словами. */
    performedByRef: text("performed_by_ref"),
    performedAt: timestamp("performed_at", { withTimezone: true }).defaultNow().notNull(),
    /** Календарная дата в Asia/Tashkent — по ней и только по ней считаются интервалы. */
    performedOn: date("performed_on").notNull(),
    /** Введено задним числом: отчёт должен это показывать. */
    backdated: boolean("backdated").default(false).notNull(),
    note: text("note"),
    createdBy: text("created_by"),
    createdAt: createdAt(),
  },
  (t) => [
    index("maintenance_log_entity_idx").on(t.entityId, t.performedOn),
    index("maintenance_log_person_idx").on(t.performedById, t.performedOn),
    index("maintenance_log_kind_idx").on(t.kind, t.performedOn),
    check("maintenance_log_counter_range", sql`${t.counterValue} is null or ${t.counterValue} >= 0`),
  ],
);
```

Колонка `plan_id` добавляется миграцией `0042` вместе с таблицей планов (FK нельзя объявить раньше цели).

### 4.4 `machine_part` — экземпляр узла

```ts
/**
 * Экземпляр узла на автомате — история периодами.
 *
 * Модель ровно как у coffee_machine_placement и по той же причине: один и тот
 * же купюроприёмник переезжает между автоматами, а на одном автомате в разное
 * время стоят разные. Открытый период (removed_on IS NULL) — «стоит сейчас»;
 * замена ЗАКРЫВАЕТ старую строку и открывает новую, прошлое не переписывается.
 *
 * install/removal ссылаются на ОДНУ И ТУ ЖЕ запись maintenance_log — так
 * «12.03 заменили S/N 123 на S/N 456» это одно событие с исполнителем, фото и
 * причиной, а не две несвязанные строки.
 *
 * installed_on может быть NULL — «стоял с неизвестной даты» (то же решение,
 * что при бэкфилле размещений: история начинается с текущего факта).
 */
export const machinePart = pgTable(
  "machine_part",
  {
    id: id(),
    machineId: uuid("machine_id").references(() => entity.id).notNull(),
    partKind: partKindEnum("part_kind").notNull(),
    /** Где именно: "3" для бункера, "A1" для слота. Пусто — узел один на автомат. */
    slotRef: text("slot_ref"),
    /** Карточка модели запчасти — существующий entity с type='component'. */
    partModelId: uuid("part_model_id").references(() => entity.id),
    /** Свободное название, когда карточку модели заводить не стали. */
    title: text("title"),
    serialNumber: text("serial_number"),
    installedOn: date("installed_on"),
    removedOn: date("removed_on"),
    removalReason: partRemovalReasonEnum("removal_reason"),
    /** До какой даты гарантия — чтобы «сломался» и «сломался по гарантии» различались. */
    warrantyUntil: date("warranty_until"),
    installedLogId: uuid("installed_log_id").references(() => maintenanceLog.id),
    removedLogId: uuid("removed_log_id").references(() => maintenanceLog.id),
    note: text("note"),
    createdBy: text("created_by"),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("machine_part_machine_idx").on(t.machineId, t.partKind),
    // «Где сейчас стоит S/N 123» — вопрос владельца при разборе гарантии.
    index("machine_part_serial_idx").on(t.serialNumber).where(sql`serial_number is not null`),
    // На одном месте автомата не может стоять два узла одновременно.
    // NULL в unique различны, поэтому два частичных индекса — приём coffee_wash_schedule.
    uniqueIndex("machine_part_open_slot_key")
      .on(t.machineId, t.partKind, t.slotRef)
      .where(sql`removed_on is null and slot_ref is not null`),
    uniqueIndex("machine_part_open_key")
      .on(t.machineId, t.partKind)
      .where(sql`removed_on is null and slot_ref is null`),
    check(
      "machine_part_dates",
      sql`${t.removedOn} is null or ${t.installedOn} is null or ${t.removedOn} >= ${t.installedOn}`,
    ),
    // Узел без имени и без карточки — мусор в отчёте.
    check("machine_part_named", sql`${t.partModelId} is not null or ${t.title} is not null`),
  ],
);
```

### 4.5 `maintenance_plan` — норматив

```ts
/**
 * График работ: «что, на чём, как часто, кому».
 *
 * Четыре триггера, объединённых ИЛИ (идиома washScheduleStatus: dueByDays ||
 * dueByCups) — сработал любой, значит пора:
 *   every_days   — раз в N дней
 *   every_months — раз в N календарных месяцев; отдельно от дней, потому что
 *                  квартал ≠ 90 дней и конец месяца должен считать Postgres,
 *                  а не мы делением на 86400000
 *   every_count  — раз в N единиц наработки (counter_label: «порций», «литров»).
 *                  Факт берётся из maintenance_log.counter_value — техник
 *                  вводит показание с дисплея. Внешние ленты (product_sale,
 *                  machine_sale) НЕ используются: это перекрывающиеся
 *                  снапшот-окна, суммировать их нельзя (см. vending.service.ts:326).
 *   due_on       — жёсткий срок: техосмотр, поверка. ЯКОРЬ обязательства:
 *                  при выполнении сервис двигает его на every_months вперёд,
 *                  поэтому годовщина не сползает на дату исполнения.
 *
 * task_lead_days — за сколько дней ДО срока создать задачу. Честное имя:
 * push всё равно уйдёт за ≤ REMIND_LOOKAHEAD_HOURS до task.due, потому что
 * доставка идёт через существующий sendReminders().
 *
 * Статус (ok | soon | due | overdue | unknown) НЕ колонка: он зависит от now()
 * и протух бы между тиками монитора. Не задано ни одного триггера → "unknown",
 * не "ok" — молчаливое «всё хорошо» опаснее честного «не знаю»
 * (тест coffee.service.test.ts:557 закрепляет тот же принцип).
 */
export const maintenancePlan = pgTable(
  "maintenance_plan",
  {
    id: id(),
    domain: domainEnum("domain").default("vendhub").notNull(),
    /** Объект: карточка автомата (entity type='machine') или иное оборудование. */
    targetId: uuid("target_id").references(() => entity.id).notNull(),
    kind: maintenanceKindEnum("kind").notNull(),
    /** Узел, если график про узел («фильтр раз в 90 дней»). Пусто — автомат целиком. */
    partKind: partKindEnum("part_kind"),
    /** Различитель: «to-3m» и «to-12m» — два разных плана одного kind на объекте. */
    code: text("code").default("main").notNull(),
    title: text("title"),

    // ── триггеры ──
    everyDays: integer("every_days"),
    everyMonths: integer("every_months"),
    everyCount: integer("every_count"),
    /** Единица наработки словами: «порций», «литров», «кг». Для UI и для отчёта. */
    counterLabel: text("counter_label"),
    /** Жёсткий срок-якорь. Двигается сервисом на every_months при выполнении. */
    dueOn: date("due_on"),
    /** День постановки плана на учёт: даёт срок плану, который не выполняли ни разу. */
    activatedOn: date("activated_on").defaultNow().notNull(),
    /** За сколько дней до срока СОЗДАТЬ ЗАДАЧУ. 0 — в день срока. */
    taskLeadDays: integer("task_lead_days").default(3).notNull(),

    // ── адресация ──
    /** Кому ставится задача. Пусто — задача уходит владельцу и в брифинг. */
    assigneeId: uuid("assignee_id").references(() => person.id),
    autoTask: boolean("auto_task").default(true).notNull(),

    // ── кэш последнего факта ──
    /** Кэш для дешёвой выборки, а не источник истины: сервис всегда может
     *  пересчитать из maintenance_log. Пишется в одной транзакции со вставкой
     *  факта, через greatest() — иначе запись задним числом сдвинет срок в прошлое. */
    lastDoneOn: date("last_done_on"),
    lastDoneCounter: integer("last_done_counter"),
    lastLogId: uuid("last_log_id"),

    /**
     * Дата следующего срока — GENERATED STORED из полей ЭТОЙ ЖЕ строки.
     * Считает Postgres, поэтому колонка физически не может разойтись с
     * нормативом: правка every_days пересчитывает её тем же UPDATE, а записать
     * руками её нельзя.
     *
     * NULL здесь только у чисто счётчиковых планов (задан один every_count и
     * работа уже делалась) — у наработки нет календарной даты, и врать
     * проекцией мы не будем. Монитор такие планы забирает отдельным запросом.
     */
    nextDueOn: date("next_due_on").generatedAlwaysAs(
      // ВНИМАНИЕ: только ГОЛЫЕ имена колонок. ${t.col} в drizzle разворачивается
      // в "maintenance_plan"."col", а квалифицированная ссылка в GENERATED-выражении
      // недопустима. Не «причёсывать под единообразие с CHECK» — сломается миграция.
      sql`case
            when "due_on" is not null then "due_on"
            when "last_done_on" is null then "activated_on"
            when "every_days" is not null then "last_done_on" + "every_days"
            when "every_months" is not null
              then ("last_done_on" + make_interval(months => "every_months"))::date
            else null
          end`,
    ),

    isActive: boolean("is_active").default(true).notNull(),
    notes: text("notes"),
    createdBy: text("created_by"),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("maintenance_plan_target_idx").on(t.targetId, t.kind),
    // Главный запрос монитора: «что горит».
    index("maintenance_plan_due_idx").on(t.nextDueOn).where(sql`is_active`),
    index("maintenance_plan_assignee_idx").on(t.assigneeId).where(sql`is_active`),
    // Уникальность только среди АКТИВНЫХ: «исключение = деактивированный план»
    // иначе разбилось бы о собственное ограничение.
    uniqueIndex("maintenance_plan_part_key")
      .on(t.targetId, t.kind, t.partKind, t.code)
      .where(sql`part_kind is not null and is_active`),
    uniqueIndex("maintenance_plan_whole_key")
      .on(t.targetId, t.kind, t.code)
      .where(sql`part_kind is null and is_active`),
    check(
      "maintenance_plan_trigger_set",
      sql`${t.everyDays} is not null or ${t.everyMonths} is not null
          or ${t.everyCount} is not null or ${t.dueOn} is not null`,
    ),
    check(
      "maintenance_plan_period_exclusive",
      sql`${t.everyDays} is null or ${t.everyMonths} is null`,
    ),
    check(
      "maintenance_plan_positive",
      sql`(${t.everyDays} is null or ${t.everyDays} > 0)
          and (${t.everyMonths} is null or ${t.everyMonths} > 0)
          and (${t.everyCount} is null or ${t.everyCount} > 0)
          and ${t.taskLeadDays} >= 0`,
    ),
  ],
);
```

> **Риск и запасной ход.** Если конкретная сборка Postgres или drizzle-kit не примет generated-выражение — откат тривиален: обычная колонка `next_due_on date` + пересчёт в `MaintenanceService` в той же транзакции, где меняется норматив или пишется факт. Поведение прикладного кода не меняется. Отдельно: drizzle-kit **не умеет** генерировать `ALTER` для выражения generated-колонки — любая правка формулы делается вручную (`DROP COLUMN` + `ADD COLUMN`) в новой миграции.

### 4.6 Правки существующих таблиц

```ts
// в task, после domain:
  /**
   * Объект работы: автомат, техника, объект. Без него задача «замени фильтр»
   * не знает, ЧТО чинить, список не группируется по точкам, а закрытие задачи
   * нечем связать с maintenance_log. Пусто у задач, не привязанных к железу.
   */
  entityId: uuid("entity_id").references(() => entity.id),

// в список индексов task:
    index("task_entity_idx").on(t.entityId),
    // Идемпотентность повторяющихся задач держится на source = "<код>:<день>".
    // Без уникального индекса ensureForDay() — гонка select-then-insert:
    // два тика монитора создадут две задачи на один срок.
    uniqueIndex("task_source_key").on(t.source).where(sql`source is not null`),

// в attachment, после kind:
  /**
   * Стадия съёмки: before | after | plate | counter. Отдельно от `kind`,
   * потому что kind управляет проверкой MIME (photo → только изображения),
   * а стадия — это подпись момента. Пусто — стадия не указана.
   */
  stage: text("stage"),

// в person, после role:
  /**
   * Роли доступа. Пустой массив — «доступ не настроен»: человек видит только
   * свои задачи (BASELINE), а владелец видит в /team метку. Это не
   * «наблюдатель»: молча выдать минимальные права — значит спрятать недонастройку.
   */
  roles: text("roles").array().$type<StaffRole[]>().notNull().default(sql`'{}'::text[]`),
```

> `text().array()` — первый массив в схеме (grep по `schema.ts` пуст). Перед тем как класть в одну миграцию с другими объектами, прогнать `db:generate` отдельно и проверить снапшот.

### 4.7 Таблицы доступа

```ts
/*
 * Перечисления `staff_scope` нет: закрепление сотрудников за объектами в V1
 * не моделируется. Владелец подтвердил — все полевые сотрудники работают по
 * всему парку. Таблица «кто за что отвечает», в которой у каждой строки один
 * и тот же ответ, не данные, а накладной расход. Вместо неё — общий пул
 * задач (§6.4). Причина отказа и условие возврата — в §10.
 */

/**
 * Приглашение сотрудника в бот.
 *
 * Секрет не хранится — только HMAC-хеш с перцем из env. Потерялась ссылка —
 * перевыпуск, а не «посмотреть в базе». Живых приглашений на человека всегда
 * одно: две рабочие ссылки означают, что непонятно, какую отзывать.
 */
export const staffInvite = pgTable(
  "staff_invite",
  {
    id: id(),
    personId: uuid("person_id").references(() => person.id, { onDelete: "cascade" }).notNull(),
    tokenHash: text("token_hash").notNull(),
    /** Хеш короткого кода — его диктуют голосом, когда ссылка не дошла. */
    codeHash: text("code_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    usedByChatId: text("used_by_chat_id"),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedBy: text("revoked_by"),
    /** Неудачные предъявления именно этого кода — сигнал подбора. */
    attempts: integer("attempts").default(0).notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    // Токен уникален глобально: по нему различаем «не найден» и «уже использован».
    uniqueIndex("ux_staff_invite_token").on(t.tokenHash),
    // Код — только среди живых: у отработавших он может повториться, и это неважно.
    uniqueIndex("ux_staff_invite_code").on(t.codeHash)
      .where(sql`used_at is null and revoked_at is null`),
    uniqueIndex("ux_staff_invite_one_active").on(t.personId)
      .where(sql`used_at is null and revoked_at is null`),
    index("staff_invite_person_idx").on(t.personId),
  ],
);

/*
 * Таблицы `staff_assignment` («кто за какой объект отвечает») в V1 НЕТ.
 * Все полевые сотрудники закреплены за всем парком, поэтому строка
 * «человек × объект» несла бы одно и то же значение для всех пар и только
 * притворялась бы данными. Кто фактически делал работу — видно из
 * `maintenance_log.person_id`, а это факт, а не декларация.
 */
```

**Что занимает место закрепления.** Один атомарный захват свободной задачи — без новой таблицы:

```ts
  /**
   * Взять свободную задачу. Атомарно: гонка двух техников, нажавших «Беру»
   * одновременно, разрешается БД, а не порядком чтения. Проигравший получает
   * не ошибку, а перерисованную карточку с именем победителя.
   */
  async claim(taskId: string, personId: string): Promise<TaskRow | null> {
    const [claimed] = await this.db
      .update(task)
      .set({ ownerKind: "human", ownerRef: personId, updatedAt: new Date() })
      .where(and(eq(task.id, taskId), isNull(task.ownerRef)))
      .returning();
    return claimed ?? null;
  }
```

### 4.8 Регистрация в `schema`

```ts
  // Обслуживание: журнал работ, узлы автоматов, графики.
  maintenanceLog,
  machinePart,
  maintenancePlan,
  // Доступ сотрудников: приглашения.
  staffInvite,
```

### 4.9 Порядок миграций

Последняя существующая — `0039_freezing_ricochet`. Журнал: `packages/db/drizzle/meta/_journal.json`, `version 7`, `idx: 39`.

**Процедура для каждой миграции обязательна:** правка `schema.ts` → `pnpm --filter @mydon/db db:generate` → переименовать сгенерированный файл в осмысленное имя → **исправить запись в `_journal.json`** (`tag`) → при необходимости дописать ручной SQL внутрь файла (прецедент — бэкфилл в конце `0033_coffee_machine_placement.sql`). Файл, положенный руками без записи в журнале, `drizzle-kit migrate` **не выполнит**, а следующий `db:generate` сгенерирует дифф повторно.

| № | Имя | Содержимое |
|---|---|---|
| 0040 | `0040_task_entity_photo_stage` | `ALTER TABLE task ADD COLUMN entity_id uuid` + FK `NOT VALID` + `VALIDATE`; `CREATE INDEX task_entity_idx`; `CREATE UNIQUE INDEX task_source_key ... WHERE source IS NOT NULL`; `ALTER TABLE attachment ADD COLUMN stage text` |
| 0041 | `0041_maintenance_log` | enum'ы `maintenance_kind`, `maintenance_outcome`, `part_kind`, `part_removal_reason`; таблицы `maintenance_log`, затем `machine_part` (FK на лог) |
| 0042 | `0042_maintenance_plan` | таблица `maintenance_plan` (в т. ч. GENERATED-колонка — единственное место с нетривиальным SQL, проверить на staging); `ALTER TABLE maintenance_log ADD COLUMN plan_id uuid` + FK + `CREATE INDEX maintenance_log_plan_done_idx ON maintenance_log (plan_id, performed_on) WHERE outcome IS NOT NULL` |
| 0043 | `0043_staff_roles` | `ALTER TABLE person ADD COLUMN roles text[] DEFAULT '{}' NOT NULL`; таблица `staff_invite` |

**Риск для существующих данных — нулевой.** Только `CREATE TABLE` и `ADD COLUMN`. `roles` добавляется с `DEFAULT '{}' NOT NULL` — в PostgreSQL 11+ это правка каталога без переписывания таблицы. FK на `task` объявлять `NOT VALID` + отдельным `VALIDATE CONSTRAINT`: обычный `ADD CONSTRAINT ... FOREIGN KEY` берёт `SHARE ROW EXCLUSIVE` и сканирует таблицу.

**Бэкфилл: не делаем нигде, и в трёх местах он вреден.**

- `coffee_wash_log → maintenance_log` — **не переносить**. Кофейный контур остаётся своим.
- `task.entity_id` — **не восстанавливать эвристикой** из `title`/`source`. Ложная привязка задачи к чужому автомату хуже пустого поля.
- `machine_part` — бэкфиллить нечего: данных о железе нет нигде (OurVend здоровье оборудования не отдаёт, коннектор VHM24 — заглушка). Первое заполнение — руками через визард «перепись узлов» с `installed_on = NULL` («стоит с неизвестной даты»), как бэкфилл `coffee_machine_placement`.
- `attachment.stage` — старые строки остаются с `NULL`, читатели отсутствие стадии терпят.

### 4.10 Расчёт срока: `packages/shared/src/maintenance-due.ts` (новый)

Одни и те же числа нужны Core, агенту и панели. Разъедутся — сотрудник и владелец увидят разные сроки.

```ts
/**
 * Расчёт «когда следующая работа» и «пора ли». Локальная зона процесса здесь
 * не используется НИГДЕ — только TZ. dayStart() в packages/shared/src/tasks.ts
 * опирается на setHours() и работает лишь потому, что контейнер живёт в
 * Asia/Tashkent; в CI и в тестах это неверно, и повторять это нельзя.
 */
import { TZ } from "./index";

/** День в поясе проекта, YYYY-MM-DD. Единственный способ говорить о «сутках». */
export type DayKey = string;

export function dayKeyOf(d: Date = new Date()): DayKey {
  return d.toLocaleDateString("en-CA", { timeZone: TZ });
}

export function addDays(day: DayKey, n: number): DayKey {
  // Полдень UTC: ни одна граница суток и ни один перевод часов сюда не дотянется.
  const t = new Date(`${day}T12:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}

/** Разница в КАЛЕНДАРНЫХ днях (b − a), а не в «полных сутках по 86400 с».
 *  Именно на этом ошибается washScheduleStatus: Math.floor(ms / 86_400_000). */
export function diffDays(a: DayKey, b: DayKey): number {
  return Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86_400_000);
}

/** Прибавить N календарных месяцев (для сдвига якоря due_on в сервисе). */
export function addMonths(day: DayKey, n: number): DayKey {
  const [y, m, d] = day.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1 + n, d, 12));
  return t.toISOString().slice(0, 10);
}

export type DueStatus = "ok" | "soon" | "due" | "overdue" | "unknown";

export interface DueInput {
  /** Из maintenance_plan: то, что посчитал Postgres. null у счётчиковых планов. */
  nextDueOn: DayKey | null;
  everyCount: number | null;
  lastDoneCounter: number | null;
  /** Текущее показание счётчика — последний известный counter_value. */
  currentCounter: number | null;
  taskLeadDays: number;
  hasAnyTrigger: boolean;
}

export interface DueResult {
  status: DueStatus;
  /** Отрицательное — просрочено на столько календарных дней. */
  daysLeft: number | null;
  /** Сколько единиц наработки осталось до срока. Отрицательное — перебрано. */
  countLeft: number | null;
  /** Что назначило срок — это идёт словами сотруднику. */
  reason: "date" | "counter" | null;
}

export function computeDue(input: DueInput, today: DayKey = dayKeyOf()): DueResult {
  // Норматив не задан — честное «неизвестно». Молчаливое "ok" опаснее тишины:
  // владелец решит, что всё под контролем.
  if (!input.hasAnyTrigger) {
    return { status: "unknown", daysLeft: null, countLeft: null, reason: null };
  }

  const countLeft =
    input.everyCount !== null && input.currentCounter !== null
      ? input.everyCount - (input.currentCounter - (input.lastDoneCounter ?? 0))
      : null;
  const byCounter = countLeft !== null && countLeft <= 0;

  const daysLeft = input.nextDueOn !== null ? diffDays(today, input.nextDueOn) : null;

  // Счётчик перебран — пора, независимо от календаря.
  if (byCounter) return { status: "overdue", daysLeft, countLeft, reason: "counter" };

  if (daysLeft === null) {
    // Чисто счётчиковый план, счётчик не перебран или не введён ни разу.
    return countLeft === null
      ? { status: "unknown", daysLeft: null, countLeft: null, reason: null }
      : { status: "ok", daysLeft: null, countLeft, reason: "counter" };
  }

  const status: DueStatus =
    daysLeft < 0 ? "overdue"
    : daysLeft === 0 ? "due"
    : daysLeft <= input.taskLeadDays ? "soon"
    : "ok";
  return { status, daysLeft, countLeft, reason: "date" };
}
```

Тесты (`maintenance-due.test.ts`, названия — утверждения на русском): «работа в 23:40 по Ташкенту засчитана сегодняшним днём»; «не делали ни разу → срок = день постановки на учёт, а не «через интервал»»; «норматив не задан → unknown, а не ok»; «счётчик перебран раньше календаря → reason=counter»; «квартал считается календарно, а не как 90 дней».

---

## 5. UX бота

### 5.1 Клавиатуры: разделение ролей

| | Reply-клавиатура (постоянная внизу) | Inline-кнопки (под сообщением) |
|---|---|---|
| Что несёт | **Точки входа**: пункты меню | **Выбор внутри сценария**: автомат, узел, подтверждение |
| Почему | Всегда на экране, не надо скроллить вверх; крупные кнопки; **переживает перезапуск бота** (живёт на клиенте, а не в памяти процесса) | Привязана к конкретному сообщению → нельзя нажать «Бункер 3» от вчерашней точки; несёт id в `callback_data`; гасится через `editMessage` |
| Цена промаха | уход в другой раздел — обратимо | запись в БД — необратимо |

**Техническое ограничение, которое надо помнить:** одно сообщение Telegram несёт **ровно один** `reply_markup`. Значит `/start` — это **два** сообщения: сначала приветствие с reply-клавиатурой, потом список задач с inline-кнопками. Порядок именно такой.

Транспорт (`apps/bot/src/telegram.ts`) расширяется:

```ts
export interface InlineKeyboard {
  inline_keyboard: { text: string; callback_data: string }[][];
}

/** Постоянное меню внизу экрана. Отдельный тип: reply и inline
 *  взаимоисключающи в одном сообщении — Telegram примет только один. */
export interface ReplyKeyboard {
  keyboard: { text: string }[][];
  resize_keyboard: true;
  is_persistent: true;
  input_field_placeholder?: string;
}

export type ReplyMarkup = InlineKeyboard | ReplyKeyboard;

async sendMessage(chatId: number, text: string, markup?: ReplyMarkup): Promise<void>;

/** Без reply_markup Telegram СНИМАЕТ кнопки — для чекбоксов их надо слать заново. */
async editMessage(chatId: number, messageId: number, text: string, keyboard?: InlineKeyboard): Promise<void>;

async answerCallback(id: string, text?: string, showAlert?: boolean): Promise<void>;
```

### 5.2 Главное меню

```
┌──────────────────────────┬──────────────────────────┐
│  📋 Мои задачи           │  🗓 Графики              │
├──────────────────────────┼──────────────────────────┤
│  🔧 Замена детали        │  🛠 Технический осмотр   │
├──────────────────────────┼──────────────────────────┤
│  🧼 Почистил             │  ⚠️ Поломка              │
├──────────────────────────┼──────────────────────────┤
│  ☕ Заливка бункера      │  💧 Расходники           │
├──────────────────────────┼──────────────────────────┤
│  📥 Инкассация           │  📦 Приход               │
├──────────────────────────┼──────────────────────────┤
│  📋 Инвентаризация       │  🆕 Новая карточка       │
├──────────────────────────┴──────────────────────────┤
│  ↩️ Ошибся — исправить                              │
└─────────────────────────────────────────────────────┘
```

Меню фильтруется по правам **и по готовности флоу**. Кнопка, которая ничего не делает, для полевого сотрудника хуже отсутствующей.

#### `/home/user/mydon/apps/bot/src/menu.ts` (новый)

```ts
/**
 * Меню сотрудника. Один источник правды: и кнопки, и текстовые триггеры
 * проверяются по одному праву — иначе спрятанный пункт остаётся доступен
 * словом, и вся модель прав становится косметикой.
 *
 * Регексы триггеров НЕ переписываются: переиспользуются существующие
 * is*Trigger() из модулей визардов. Каждая «причёсанная» копия теряет
 * формулировки, которыми сотрудники реально пишут («залил кофе»,
 * «почистил бункер», «ошиблась», «поступил товар»).
 *
 * В callback_data идёт короткий id пункта, не подпись: кириллица съедает
 * лимит 64 байта. Префикс «m:» свободен.
 */
import type { Permission } from "@mydon/shared";
import { can } from "@mydon/shared";
import { isRegisterTrigger } from "./staff-register";
import { isIntakeTrigger } from "./staff-intake";
import { isInventoryTrigger } from "./staff-inventory";
import { isCoffeeRefillTrigger, isCoffeeWashTrigger } from "./coffee-refill";
import { isCoffeeConsumableTrigger } from "./coffee-returns";
import { isCoffeeFixTrigger } from "./coffee-fix";

export interface MenuItem {
  id: string;
  label: string;
  perm: Permission;
  /** Готов ли флоу. false — пункт не показываем и триггер не ловим. */
  ready: boolean;
  match: (text: string) => boolean;
}

/** «задачи», «дела», «что делать» — вынесено из staff.ts:301 дословно. */
export const isTasksTrigger = (t: string): boolean => /задач|дела|что делать|мои/i.test(t);
/** Вынесено из staff.ts:307 дословно. */
export const isCollectTrigger = (t: string): boolean => /инкасс|выручк|сдать деньги/i.test(t);

export const STAFF_MENU: readonly MenuItem[] = [
  { id: "tasks",  label: "📋 Мои задачи",          perm: "tasks.own",         ready: true, match: isTasksTrigger },
  { id: "sched",  label: "🗓 Графики",             perm: "maintenance.view",  ready: true, match: (t) => /^(график|графики|то|обслуживани)/i.test(t) },
  { id: "part",   label: "🔧 Замена детали",       perm: "parts.replace",     ready: true, match: (t) => /^(замен|поменял|поставил нов)/i.test(t) },
  { id: "insp",   label: "🛠 Технический осмотр",  perm: "maintenance.view",  ready: true, match: (t) => /^(техосмотр|технический осмотр|осмотр)/i.test(t) },
  { id: "clean",  label: "🧼 Почистил",            perm: "coffee.wash",       ready: true, match: isCoffeeWashTrigger },
  { id: "issue",  label: "⚠️ Поломка",             perm: "tasks.own",         ready: true, match: (t) => /^(поломк|сломал|не работает|авария)/i.test(t) },
  { id: "refill", label: "☕ Заливка бункера",     perm: "coffee.refill",     ready: true, match: isCoffeeRefillTrigger },
  { id: "cons",   label: "💧 Расходники",          perm: "coffee.consumable", ready: true, match: isCoffeeConsumableTrigger },
  { id: "coll",   label: "📥 Инкассация",          perm: "cash.collect",      ready: true, match: isCollectTrigger },
  { id: "intake", label: "📦 Приход",              perm: "stock.intake",      ready: true, match: isIntakeTrigger },
  { id: "count",  label: "📋 Инвентаризация",      perm: "stock.count",       ready: true, match: isInventoryTrigger },
  { id: "new",    label: "🆕 Новая карточка",      perm: "registry.propose",  ready: true, match: isRegisterTrigger },
  { id: "fix",    label: "↩️ Ошибся — исправить",  perm: "tasks.own",         ready: true, match: isCoffeeFixTrigger },
];

export function menuFor(roles: readonly string[] | null | undefined): MenuItem[] {
  return STAFF_MENU.filter((i) => i.ready && can(roles, i.perm));
}

/** Две кнопки в ряд: на телефоне это предел, при котором подпись не режется. */
export function menuKeyboard(roles: readonly string[] | null | undefined): ReplyKeyboard {
  const rows: { text: string }[][] = [];
  menuFor(roles).forEach((item, i) => {
    if (i % 2 === 0) rows.push([]);
    rows[rows.length - 1].push({ text: item.label });
  });
  return {
    keyboard: rows,
    resize_keyboard: true,
    is_persistent: true,
    input_field_placeholder: "Жми кнопки снизу 👇",
  };
}

/** Точное совпадение с подписью меню. Проверяется РАНЬШЕ активного визарда. */
export function matchMenuLabel(text: string): MenuItem | null {
  const t = text.trim();
  return STAFF_MENU.find((i) => i.label === t) ?? null;
}

/** Слово попало в пункт: возвращаем пункт, чтобы объяснить, что человек не сломался. */
export function matchTrigger(text: string): MenuItem | null {
  return STAFF_MENU.find((i) => i.ready && i.match(text)) ?? null;
}
```

### 5.3 Порядок разбора входящего текста (`handleStaffMessage`)

Порядок критичен — его нельзя «упростить в один проход».

```
1. Отмена: /^(отмена|стоп|cancel)$/i  → clear визарда              (как сейчас)
2. Точное совпадение с подписью МЕНЮ (matchMenuLabel)              ← НОВОЕ, ДО визарда
     если визард активен и незакончен — бросаем его с пояснением
3. Активный визард забирает ввод по шагу                            (как сейчас)
4. tryParseContainerReturns («1. 027. 787»)                         (как сейчас)
5. Триггеры визардов: matchTrigger, КРОМЕ id "tasks" и "coll"       ← реестр вместо цепочки
6. deps.awaiting.take(chatId) — отчёт после «Сделал»                (ОБЯЗАТЕЛЬНО ЗДЕСЬ)
7. /start, привет
8. Триггер "tasks"
9. Триггер "coll"
10. Комментарий к единственной задаче                               (как сейчас)
```

**Почему `awaiting.take()` обязан стоять после триггеров визардов, но до «задач» и «инкассации»:** регекс задач `/задач|дела|что делать|мои/i` не имеет якорей. Отчёт «сделал заливку» содержит подстроку `дела` — если проверять «задачи» раньше, отчёт не запишется, задача не закроется, а `awaiting` съест следующее сообщение. Это ежедневный сценарий.

Пункт 2, при активном незаконченном визарде:

```
Бросил незаконченную «Заливку» (Kaffit-04, бункер 2 — вес не введён).
Открываю «Замена детали».
```

Без вопроса «вы уверены?»: сотрудник нажал осознанно, лишний диалог его только злит.

При отказе по праву (пункт 5/8/9):

```
«🔧 Замена детали» — не твой участок. Если это ошибка, напиши владельцу.
```

### 5.4 Реестр `callback_data`

Занято до этой итерации: `ap:` `t:` `c:` `r:` `i:` `n:` `cf:` `cw:` `cc:` `fx:`.
Берём свободные: `m:` `mp:` `dn:` `pt:` `sv:` `cl:` `pr:` `sc:` `nv:` `sa:`.

Все существующие парсеры используют якорные регексы (`^…$`), поэтому `c:` не съест `cl:`, а `n:` не съест `nv:`.

**Соглашения.** `<u>` = uuid 36 символов, `[0-9a-f-]{36}`. `<s8>` = первые 8 hex-символов id объекта, к которому привязан мастер: обработчик сверяет его с `conv.data.entityId`; не совпало → `answerCallback("Эта карточка устарела")`. Без `<s8>` кнопка со вчерашнего сообщения применится к текущему визарду, каким бы он ни был.

| Префикс | Формат | Смысл | Байт |
|---|---|---|---|
| `m:` | `m:<id>` (`tasks`, `sched`, `part`, …) | пункт меню (для inline-дубля) | ≤ 9 |
| `mp:` | `mp:e:<u>` | выбран объект в общем пикере | 41 |
| | `mp:pg:<n>` · `mp:q` · `mp:x` | страница / поиск / отмена | ≤ 9 |
| `t:` | `t:<u>:<progress\|done\|open\|claim\|free>` | задача (расширяем существующий регекс). `claim` — взять из общего пула, `free` — вернуть в пул | 47 |
| `dn:` | `dn:ok:<s8>` · `dn:np:<s8>` · `dn:ph:<s8>` · `dn:x` | закрытие задачи: отправить / без фото / к фото / отмена | ≤ 15 |
| `pt:` | `pt:u:<part_kind>:<s8>` | узел выбран | ≤ 30 |
| | `pt:s0` · `pt:n0` | «не знаю старый / новый S/N» | 5 |
| | `pt:r:<failure\|preventive\|upgrade\|warranty\|moved>` | причина | ≤ 14 |
| | `pt:ph` · `pt:np` · `pt:ok` · `pt:x` | к фото / без фото / записать / отмена | 5 |
| `sv:` | `sv:t:<plan\|elec\|sani\|metr>:<s8>` | вид осмотра | ≤ 20 |
| | `sv:r:<ok\|note\|fail>` · `sv:nx:<3\|6\|12\|own>` · `sv:ok` · `sv:x` | результат / следующий / запись / отмена | ≤ 12 |
| `cl:` | `cl:w:<part_kind\|all>:<s8>` · `cl:ok` · `cl:np` · `cl:x` | что чистил | ≤ 30 |
| `pr:` | `pr:s:<dead\|bill\|coin\|leak\|heat\|cool\|jam\|err\|noise\|oth>:<s8>` | симптом | ≤ 22 |
| | `pr:u:<1\|2\|3>` · `pr:ph` · `pr:np` · `pr:ok` · `pr:x` | срочность / фото / запись | ≤ 8 |
| `sc:` | `sc:d:<7\|14\|30>` · `sc:card:<u>` · `sc:do:<u>` · `sc:od` | горизонт / карточка / «сделал сейчас» / просроченное | ≤ 44 |
| `nv:` | `nv:noop:<n>` | индикатор страницы, отвечает `answerCallback` | ≤ 11 |
| `sa:` | `sa:role:<индекс STAFF_ROLES>` · `sa:done` · `sa:cancel` · `sa:revoke:<u>` | визард владельца «новый сотрудник» | ≤ 46 |
| `fx:` | `fx:del:<r\|c\|s\|m>:<u>` — добавлен код `m` (maintenance_log) | удаление своей записи | 46 |

Максимум по всей схеме — 47 байт (`t:<uuid>:progress`), запас 17 байт.

**Инженерная правка:** цепочка `if (parseX(data))` в `handleStaffCallback` (`staff.ts:335-416`) вырастет с 8 до 15 ветвей. Заменить на реестр `Record<string, Handler>` по префиксу до первого `:`, оставив `parseTaskCallback` последним фолбэком (сейчас именно он выдаёт «Не понял кнопку»).

### 5.5 Общий пикер объекта (`mp:`)

`/home/user/mydon/apps/bot/src/machine-picker.ts` (новый). Три уровня, каждый отсекает большинство:

**Уровень 1 — недавние (MRU), 5 штук.** Источник: `maintenance_log(performed_by_id, entity_id, performed_on desc)` + `collection(operator_id, machine_id, collected_at desc)`. Нужно добавить в Core `GET /maintenance/recent-objects?personId=&limit=5` и метод `CoreClient.recentObjects(personId)`.

Это единственный механизм, который сокращает список, — закрепления за объектами нет, формально каждому доступен весь парк. MRU работает не потому, что человек закреплён, а потому что маршрут одного дня повторяется: техник возвращается на те же точки. По мере роста парка (объекты подтягиваются из систем постепенно) ценность MRU только растёт, а уровни 2 и 3 остаются запасным выходом.

**Уровень 2 — поиск подстрокой.** `GET /entities?type=machine&q=…` уже работает (`nameMatches`, `entities.service.ts:406`).

**Уровень 3 — все, один экран, `.slice(0, 30)`** — как в существующем `machinesKeyboard`.

```
Шаг 1 — какой автомат?

🕐 Недавно у тебя:
```
```
[Kaffit-04 · БЦ «Пойтахт»]
[Snack-11 · БЦ «Пойтахт»]
[Kaffit-01 · ТЦ «Компас»]
[🔎 Найти по названию]  [⋯ Все (47)]
[✖️ Отмена]
```

Поиск:
```
Напиши часть названия или номер: «компас», «kaffit», «04».
```
Ничего не нашлось:
```
По «компос» ничего. Проверь букву или жми «⋯ Все» и листай.
```
Ровно одно совпадение поиска — шаг пропускается:
```
Kaffit-04, БЦ «Пойтахт». Что менял?
```
+ кнопка `[⬅️ Не тот автомат]`.

### 5.6 Сценарий: 📋 Мои задачи

**Экран 1 — одно сообщение вместо десяти.** Сейчас `index.ts:154-156` шлёт до 10 отдельных сообщений с клавиатурами: 10 запросов к Bot API подряд при персональном лимите Telegram ~1 msg/s и 10 всплывающих уведомлений на телефоне.

Порядок строк: `groupByUrgency()` из `@mydon/shared` (просрочено → сегодня → неделя → позже → без срока), внутри группы — **группировка по объекту** (`task.entityId`), чтобы техник не мотался туда-сюда.

```
🌅 Доброе утро, Рустам!
Четверг, 6 августа.

На сегодня 7 дел на 4 объектах:

1 🔴 Kaffit-01 · ТЦ «Компас»
   ☕ Пополнить бункеры 1–3 · просрочено на 1 дн.

2 🟡 Kaffit-04 · БЦ «Пойтахт»
   🧼 Санобработка кофемашины · сегодня до 14:00

3 🟡 Kaffit-04 · БЦ «Пойтахт»
   🔧 Замена купюроприёмника · сегодня до 14:00

4 🟢 Snack-07 · Метро «Буюк Ипак Йули»
   🛠 Технический осмотр · сегодня до 18:00

5 🟢 Склад «Центральный»
   📋 Пересчёт остатков · сегодня

6 ⚪ Kaffit-09 · ТЦ «Пойтахт», 2 этаж
   💧 Поменять фильтр воды · без срока

Сделано сегодня: 0 из 7

🆓 Свободные — кто возьмёт:

7 🔴 Kaffit-12 · ТЦ «Самарканд Дарвоза»
   💧 Поменять фильтр воды · просрочено на 2 дн.

8 🟡 Snack-03 · БЦ «Пойтахт»
   🛠 Технический осмотр · сегодня
```

Клавиатура (`t:<uuid>:open` — расширяем существующий регекс `(progress|done)` до `(progress|done|open)`):

```
[1 · Kaffit-01 · ТЦ «Компас»]
[2 · Kaffit-04 · БЦ «Пойтахт»]
[3 · Kaffit-04 · БЦ «Пойтахт»]
[4 · Snack-07 · Метро БИЙ]
[5 · Склад «Центральный»]
[6 · Kaffit-09 · ТЦ «Пойтахт»]
[✋ Взять 7 · Kaffit-12]
[✋ Взять 8 · Snack-03]
[🔄 Обновить]  [🗓 Что ещё предстоит]
```

**Блок «Свободные».** Закрепления за объектами нет (§6.4), поэтому свободные задачи видят все сотрудники с соответствующим правом. Кнопка `✋ Взять N` (`t:<uuid>:claim`) вызывает атомарный `TasksService.claim()`. Успех — задача переезжает в личный список, сообщение перерисовывается целиком. Неуспех (успел другой) — `answerCallbackQuery` всплывашкой «Уже взял Рустам» и перерисовка без ошибки в чат.

Блок не показывается, если свободных задач нет, — пустой заголовок «Свободные:» читается как поломка. Больше 5 строк в блоке сворачивается в `[📋 Ещё 6 свободных]`.

Счётчик «Сделано сегодня: 0 из 7» требует нового метода: **нужно добавить в `TasksService`** метод `periodStats(ownerRef, from, to)` с окном `filter (where completed_at >= from and completed_at < to)`. Существующий `workload()` (`tasks.service.ts:367-398`) считает `excellent`/`redo` **за всю историю** и для дневного счётчика непригоден. Границы дня считать через `dayKeyOf()`, не через `setHours(0,0,0,0)`.

Пусто:
```
Рустам, задач на тебе нет. Отдыхай 👌

Если что-то сделал по своей инициативе — запиши кнопками снизу,
чтобы это не потерялось.
```

**Экран 2 — карточка задачи** (`t:<uuid>:open`):

```
📌 Задача 2 из 7

🧼 Санобработка кофемашины
🏷 Kaffit-04 · БЦ «Пойтахт», холл
⏰ Сегодня до 14:00
❗ Важно

Что нужно:
Полная санобработка: бункеры, капучинатор, варочный блок.
Средство взять на складе «Центральный».
Фото «после» обязательно.
```
```
[▶️ Взял в работу]
[✅ Выполнил]
[⬅️ К списку]
```

**Экран 3 — «Взял в работу».** Всплывашка `answerCallbackQuery`: `Отметил: в работе`. Карточка редактируется на месте, старые кнопки гаснут:

```
📌 🔵 В РАБОТЕ с 09:42

🧼 Санобработка кофемашины
🏷 Kaffit-04 · БЦ «Пойтахт»
⏰ Сегодня до 14:00

Как закончишь — жми «✅ Выполнил».
Сфоткай «до» сейчас, пока не начал — потом пригодится.
```
```
[📷 Фото «до»]
[✅ Выполнил]
[⬅️ К списку]
```

### 5.7 Сценарий: закрытие задачи мастером (`dn:`)

Flow `task-done`, шаги `photo_before → note → photo_after → confirm`.

**Важно про порядок:** `attachment.ownerId` — `@IsUUID()` существующей записи, фото нельзя привязать «в воздух». Поэтому фото вешается на **саму задачу** (`ownerType: "task"`, `ownerId: task.id`) — задача уже существует, дополнительной записи создавать не надо. Стадия — в `attachment.stage`.

**Шаг «фото до»** (`dn:pb`, необязательный):
```
📷 Пришли фото «до» — как сейчас выглядит.
Просто сфоткай и отправь сюда, можно несколько.

Когда хватит — жми «Готово».
```
```
[✅ Готово, снял]  [⏭ Пропустить]
```
После каждого снимка сообщение редактируется:
```
📷 Принял «до»: 2 фото. Ещё? Или «Готово».
```

**Шаг 1 из 3 — отчёт:**
```
✅ Закрываем: «Санобработка кофемашины»
Шаг 1 из 3 — напиши одной строкой, что сделано.

Например: «Полная санобработка, заменил уплотнитель бункера 2, всё работает».
```
```
[✖️ Отмена]
```

**Шаг 2 из 3 — фото «после»:**
```
Шаг 2 из 3 — фото «после».
Сфоткай результат и отправь сюда.
```
```
[✅ Готово, снял]  [⏭ Без фото]
[✖️ Отмена]
```
После каждого:
```
📷 Принял «после»: 1 фото. Ещё? Или «Дальше».
```

**Шаг 3 из 3 — сводка:**
```
Шаг 3 из 3 — проверь и отправляй.

📌 Санобработка кофемашины
🏷 Kaffit-04 · БЦ «Пойтахт»
📷 Фото: 1 «до», 2 «после»
📝 «Полная санобработка, уплотнитель бункера 2 заменил»
🕐 09:42 → 10:15 (33 мин)
```
```
[✅ Отправить]
[✏️ Поправить отчёт]  [✖️ Отмена]
```

**Финал** (сообщение редактируется, кнопки гаснут — повторно нажать нечего):
```
✅ Задача закрыта. Отчёт ушёл владельцу.

Сделано сегодня 3 из 7. Осталось 4.
Следующая на том же объекте — «Замена купюроприёмника», Kaffit-04, до 14:00.
```
```
[➡️ Следующая: Kaffit-04]
[📋 Все задачи]
```

### 5.8 Сценарий: 🔧 Замена детали (`pt:`)

**Порядок шагов перевёрнут против интуитивного:** сначала все данные, потом **создание записи**, и только потом фото — иначе фото некуда привязать. Ровно так уже сделано в `staff-register.ts:117-121` («фото нужно к чему привязывать»).

```
🔧 Замена детали.
Шаг 1 — какой автомат?
```
(общий пикер `mp:`)

```
Шаг 2 — Kaffit-04, БЦ «Пойтахт».
Что менял?
```
```
[💵 Купюроприёмник]     [🪙 Монетоприёмник]
[☕ Варочный блок]       [⚙️ Кофемолка]
[🌀 Жернова]             [💧 Фильтр воды]
[🌡 Бойлер / ТЭН]        [🥛 Миксер]
[🔌 Плата управления]    [📶 Модем / связь]
[🧊 Компрессор]          [🚪 Замок]
[⋯ Ещё узлы]
[⬅️ Назад]              [✖️ Отмена]
```

```
Шаг 3 — 💵 купюроприёмник.
Номер СТАРОЙ детали (серийник с шильдика)?

Напиши текстом. Не разобрать — жми «Не знаю номер».
```
```
[⏭ Не знаю номер]
[⬅️ Назад]  [✖️ Отмена]
```

```
Шаг 4 — номер НОВОЙ детали? Тот, что поставил.
```
```
[⏭ Не знаю номер]
[⬅️ Назад]  [✖️ Отмена]
```

```
Шаг 5 — почему меняли?
```
```
[🔨 Сломалось]        [🕒 По регламенту]
[🔧 Профилактика]     [📄 По гарантии]
[➡️ Переставил на другой]
[⬅️ Назад]  [✖️ Отмена]
```

Сводка перед записью:
```
Проверь:

🔧 Замена: 💵 купюроприёмник
🏷 Автомат: Kaffit-04 · БЦ «Пойтахт»
⬅️ Снял: №A7734120
➡️ Поставил: №A8891455
🔨 Причина: сломалось
🕐 6 августа, 10:41
```
```
[✅ Записать]
[✏️ Поправить]  [✖️ Отмена]
```

После `✅ Записать` — **запись создаётся** (`maintenance_log` с `outcome='done'`, закрытие старого `machine_part`, открытие нового), сообщение редактируется:
```
✅ Замена записана в 10:41.

Теперь фото — лучше два: снятая деталь и то, как стоит новая.
Сфоткай шильдик так, чтобы читался номер.
```
```
[✅ Готово, снял]  [⏭ Без фото]
```
Если пропускают фото:
```
Без фото замену придётся принимать на слово. Точно без фото?
```
```
[📷 Сейчас сфоткаю]
[Да, без фото]
```

Финал:
```
✅ Готово. Владельцу ушло на утверждение карточки детали.

Если снятая деталь ремонтопригодна — подпиши её и сдай на склад.
```
```
[🔧 Ещё замена на этом автомате]
```

Карточка детали заводится существующим механизмом: `createEntity({ type: "component", createdFrom: "staff:<id>" })` → `approvedAt = null` → экран `/queue`.

### 5.9 Сценарий: 🧼 Почистил (`cl:`)

Первый вопрос отделяет кофейный контур (уходит в существующий `cw:` без изменений) от нового:

```
🧼 Что чистил?
```
```
[☕ Кофейный бункер]  [🥤 Автомат целиком / узел]
[✖️ Отмена]
```

`☕` → существующий мастер `cw:` (точка → бункер / вся машина), ничего не переписываем.

`🥤` → пикер объекта, затем:
```
Шаг 2 — Kaffit-04, БЦ «Пойтахт».
Что именно чистил?
```
```
[🧊 Радиатор холодильника]  [🥛 Миксер]
[☕ Варочный блок]           [💵 Тракт купюроприёмника]
[🪙 Тракт монетоприёмника]   [🚪 Корпус снаружи]
[🧴 Полная санобработка]
[⬅️ Назад]  [✖️ Отмена]
```

Санобработка требует фото (кнопки пропуска нет):
```
Шаг 3 — санобработка требует фото.
Пришли снимок «после» — одного хватит.
```
Иначе:
```
Шаг 3 — фото приложишь? Необязательно, но с ним вопросов не будет.
```
```
[✅ Готово, снял]  [⏭ Без фото]
```

Финал:
```
✅ Чистка отмечена: Kaffit-04, радиатор холодильника. 6 августа 11:35.

🗓 Следующая по графику — 20 августа (через 14 дней).
```

Строка «следующая по графику» показывается **только если** у объекта есть активный план и `nextDueOn` посчитан. Если плана нет — строки нет; писать «график не задан» сотруднику незачем, это дело владельца.

### 5.10 Сценарий: 🛠 Технический осмотр (`sv:`)

> Терминология: в UI пишем **«технический осмотр»**, а не «техосмотр» — «техосмотр» это про автомобили. Триггер распознаёт оба.

```
🛠 Технический осмотр.
Шаг 1 — какой объект?
```
(пикер)

```
Шаг 2 — какой осмотр?
```
```
[📋 Плановое ТО]         [⚡ Электробезопасность]
[🧴 Санитарный]           [⚖️ Поверка / калибровка]
[⬅️ Назад]  [✖️ Отмена]
```

```
Шаг 3 — результат?
```
```
[✅ Годен]
[⚠️ С замечаниями]
[🚫 Не годен, снять с работы]
[⬅️ Назад]  [✖️ Отмена]
```

При `⚠️` и `🚫` — обязательный текстовый шаг:
```
Что за замечания? Напиши коротко — владелец прочтёт сегодня же.
```

```
Шаг 4 — показание счётчика с дисплея, если есть.
Число порций или литров. Нет счётчика — «⏭ Пропустить».
```
```
[⏭ Пропустить]
```

```
Шаг 5 — когда следующий?
```
```
[3 мес]  [6 мес]  [12 мес]
[📅 Своя дата]
```
`📅 Своя дата` → `Напиши дату: 15.11.2026 или 15.11`

Запись создана → просим фото акта:
```
✅ Осмотр записан.

Теперь сфоткай акт или протокол — снимай так, чтобы читались дата и печать.
```
```
[✅ Готово, снял]  [⏭ Без акта]
```

Финал:
```
✅ Технический осмотр записан.

🛠 Плановое ТО · Kaffit-04, БЦ «Пойтахт»
✅ Годен
📄 Акт приложен (1 фото)
🗓 Следующий: 6 февраля 2027

Задачу поставлю за 3 дня до срока.
```

При `🚫 Не годен` дополнительно эмитится событие `maintenance.blocked` → правило `immediate` → владельцу немедленно.

### 5.11 Сценарий: ⚠️ Поломка (`pr:`)

Заявка «снизу»: техник увидел проблему, которую не может решить сейчас.

```
⚠️ Что сломалось?
Шаг 1 — какой автомат?
```
(пикер + кнопка `[🏢 Не про автомат]`)

```
Шаг 2 — Kaffit-04. Что не так?
```
```
[🚫 Не работает совсем]   [💵 Не берёт деньги]
[🪙 Не даёт сдачу]         [💧 Течёт вода]
[🌡 Не греет]              [🧊 Не холодит]
[🥤 Не выдаёт товар]       [🖥 Ошибка на экране]
[🔊 Шумит]                 [✏️ Другое]
[⬅️ Назад]  [✖️ Отмена]
```

```
Шаг 3 — насколько срочно?
```
```
[🔥 Стоит, простой]
[⚠️ Работает частично]
[🟢 Мелочь, не срочно]
```

```
Шаг 4 — опиши в двух словах, что происходит.
Или жми «Готово» — симптома хватит.
```
```
[✅ Готово]
```

Запись создана (`maintenance_log` c `kind='repair'`, `outcome='failed'` + задача `task` с `entityId`), затем фото:
```
✅ Записал.

Сфоткай проблему: экран с ошибкой, потёк, сломанный узел — что видно.
```
```
[✅ Готово, снял]  [⏭ Без фото]
```

Финал при `🔥`:
```
🚨 Отправил владельцу немедленно.

⚠️ Kaffit-04 · БЦ «Пойтахт»
💵 Не берёт деньги · 🔥 автомат стоит
📷 1 фото
🕐 6 августа 12:04

Создал задачу — она уже у тебя в списке.
Как починишь, закрой её обычным способом.
```
```
[📋 Открыть задачу]
```

При `🟢`:
```
✅ Записал. Владелец увидит в утреннем брифинге.
Автомат работает — задачу поставил без срочности.
```

### 5.12 Сценарий: 🗓 Графики (`sc:`)

Ограничения рендера: 4096 символов на сообщение, `parse_mode` в проекте не используется нигде → нет жирного и нет таблиц с моноширинным выравниванием (пробелы «плывут» на разных клиентах). Значит: заголовки секций — КАПС + цветной кружок, элементы — маркер `•`, вторая строка с отступом в три пробела.

**Четыре цвета, ноль оттенков:** 🔴 просрочено · 🟡 ≤ `task_lead_days` · 🟢 дальше · ⚪ `unknown` (норматив не задан). Молча красить `unknown` зелёным нельзя.

**Дата всегда в двух формах:** абсолютная («11 авг») и относительная («через 5 дн.»). Абсолютную техник сверяет с календарём, относительную — с ощущением срочности.

```
🗓 ЧТО ПРЕДСТОИТ — 14 ДНЕЙ
Рустам · 6 августа, четверг

🔴 ПРОСРОЧЕНО — 2

• 💧 Замена фильтра воды
   Kaffit-01 · ТЦ «Компас»
   было 3 авг · просрочено на 3 дн.

• 🧴 Санобработка
   Kaffit-04 · БЦ «Пойтахт»
   было 5 авг · просрочено на 1 дн.

🟡 БЛИЖАЙШИЕ 3 ДНЯ — 2

• 🧼 Чистка радиатора
   Snack-07 · Метро «Буюк Ипак Йули»
   сегодня, 6 авг

• 🛠 Технический осмотр (плановое ТО)
   Склад «Центральный»
   пятница, 8 авг · через 2 дн.

🟢 ДАЛЬШЕ — 3

• ☕ Замена варочного блока
   Kaffit-01 · 11 авг · через 5 дн.
• 💵 Профилактика купюроприёмника
   Snack-07 · 16 авг · через 10 дн.
• ⚖️ Поверка весов
   Склад «Центральный» · 19 авг · через 13 дн.

⚪ НОРМАТИВ НЕ ЗАДАН — 1

• 🌀 Смазка механики слотов
   Snack-07 · спроси владельца

━━━━━━━━━━━━━━━━━━
Всего 8 работ · просрочено 2
```

```
[🔴 Разобрать просроченное (2)]
[📅 30 дней]  [🔄 Обновить]
[1 · Фильтр воды Kaffit-01]
[2 · Санобработка Kaffit-04]
[3 · Чистка радиатора Snack-07]
[⋯ Ещё 5 работ]
```

Не больше 12 позиций в сообщении: дальше строка `…и ещё 5 работ` + кнопка. Так сообщение никогда не упрётся в 4096.

Пустой график — **новость, а не ошибка**:
```
🗓 На ближайшие 14 дней ничего не подходит.
Всё сделано, ничего не просрочено. 👌
```

**Чем ограничен список.** Закрепления за объектами нет — формально «объекты сотрудника» это весь парк, и показывать технику все 47 автоматов значит гарантировать, что раздел перестанут открывать. Поэтому фильтр не по людям, а **по состоянию**: в раздел попадают только планы со статусом `overdue` / `due` / `soon` (горизонт 14 дней), отсортированные по срочности, по 8 строк на страницу. Зелёные и «норматив не задан» не показываются вовсе — техник смотрит сюда, чтобы узнать, что горит, а не чтобы читать реестр. Полный список остаётся у владельца в панели (§7.1).

Карточка работы (`sc:card:<u>`):
```
🔴 ПРОСРОЧЕНО на 3 дня

💧 Замена фильтра воды
🏷 Kaffit-01 · ТЦ «Компас»
🕐 Прошлый раз: 3 мая (95 дней назад)
📏 Норматив: каждые 90 дней
```
```
[✅ Сделал сейчас]
[⬅️ К графику]
```
`✅ Сделал сейчас` (`sc:do:<u>`) запускает соответствующий мастер с уже подставленными объектом и узлом — техник только фоткает и подтверждает.

### 5.13 Сценарий: ↩️ Ошибся — исправить (`fx:`)

Сейчас показывается ровно одна последняя запись (`coffee-fix.ts:41`, `lastEntry()` — три параллельных `limit(1)`). Полевая реальность — «я три записи назад перепутал автомат». Расширяем до списка за сутки (три `limit(20)` + слияние + записи `maintenance_log`).

```
↩️ Твои записи за сегодня. Какую поправить?
```
```
[12:04 · ⚠️ Поломка Kaffit-04]
[11:35 · 🧼 Чистка Kaffit-04]
[10:41 · 🔧 Замена купюроприёмника]
[09:15 · ☕ Бункер 2, 1200 г]
[✖️ Ничего, закрыть]
```

```
Запись от 10:41:

🔧 Замена · 💵 купюроприёмник
Kaffit-04 · БЦ «Пойтахт»
Снял №A7734120, поставил №A8891455

Удалить? Потом внесёшь правильную.
```
```
[Оставить как есть]
[🗑 Да, удалить]
```

**Опасная кнопка одна и отдельным нижним рядом** — в перчатке промах вбок стоит дешевле промаха вниз. Это отличие от нынешнего `coffee-fix.ts:50-56`, где обе кнопки в одном ряду.

Окно правки — **на сервере, а не в UI**: сообщение в Telegram живёт вечно, кнопка, пролистанная через сутки, сработала бы. Во всех `delete*`-методах Core:
```ts
if (Date.now() - row.createdAt.getTime() > DELETE_WINDOW_MS) {
  throw new BadRequestException("Запись старше 60 минут — правку делает владелец");
}
```
Сотруднику:
```
Эта запись старше часа — сам удалить не могу.
Напиши владельцу, что поправить, я передам.
```
```
[💬 Написать владельцу]
```

Удаление `maintenance_log` — **мягкое**: `outcome` не трогаем, ставим `deleted_at`? Нет, лишняя колонка. Решение: физическое удаление строки в транзакции + `auditLog` с полным `before`, при этом откат `maintenance_plan.last_done_on` пересчитывается из журнала (не «минус один», а честный пересчёт максимума). Если у лога есть связанные `machine_part` — удаление запрещается, ответ: `Эту замену уже не отменить — она изменила состав узлов. Скажи владельцу.`

### 5.14 Подсказки, отмена, устойчивость

**Подсказки** — в уже сложившейся форме `(step: string) => string`, `switch` с обязательным `default` (пять существующих реализаций):

```ts
export function partStepHint(step: string): string {
  switch (step) {
    case "machine": return "Выбери автомат кнопкой. Не видишь нужный — жми «🔎 Найти» и напиши часть названия.";
    case "unit":    return "Выбери узел кнопкой. Нет в списке — «⋯ Ещё узлы».";
    case "old_sn":  return "Напиши номер снятой детали текстом. Не разобрать — «⏭ Не знаю номер».";
    case "new_sn":  return "Напиши номер новой детали. Или «⏭ Не знаю номер».";
    case "reason":  return "Выбери причину кнопкой.";
    case "confirm": return "Проверь сводку и жми «✅ Записать».";
    case "photo":   return "Пришли фото. Когда хватит — «✅ Готово, снял».";
    default:        return "Продолжай по кнопкам снизу.";
  }
}
```
То же для `cleanStepHint`, `serviceStepHint`, `problemStepHint`, `taskDoneStepHint`.

**Отмена — четыре способа, все работают всегда:**

| Способ | Где | Поведение |
|---|---|---|
| Кнопка `✖️ Отмена` | на **каждом** шаге **каждого** мастера | «Отменил, ничего не записал.» Обрабатывается ДО проверки живости визарда — работает и на протухшем |
| Слово «отмена» / «стоп» / «cancel» | текстом, всегда | уже есть (`staff.ts:190-196`) |
| Reply-кнопка другого раздела | всегда | бросает визард с пояснением (§5.3, пункт 2) |
| `⬅️ Назад` | на шагах 2+ | возврат на шаг, введённое не теряется |

**Оживить мёртвый код:** `i:cancel`, `n:cancel`, `cf:cancel`, `cw:cancel`, `cc:cancel` парсятся, но ни разу не рендерятся кнопкой. Добавить `✖️ Отмена` в клавиатуры существующих мастеров — правка на пять строк, ощутимая сразу.

**TTL визарда** поднять с 15 до 45 минут (`conversation.ts:26`): техник открыл автомат, полез внутрь, вернулся к телефону через 20 минут. Дополнительный «толчок» через 5 минут **не делаем**: `sweep()` вызывается раз в 10 минут (`index.ts:111`), реальный разброс был бы 5–15 мин, а `Conversations` пришлось бы дать доступ к `TelegramApi`, ломая его чистоту и 7 существующих тестов.

При истечении:
```
Замену не закончил, отложил её.
Начни заново — автомат подставлю сразу.
```
```
[🔧 Продолжить: Kaffit-04]
```

**Честно про рестарт:** `Conversations` — `Map` в памяти без сериализации (док-коммент `conversation.ts:1-9` фиксирует размен явно). При перезапуске бота шаг мастера теряется. Reply-клавиатура при этом **цела** — она живёт на клиенте. Обещать восстановление незаконченного мастера мы не будем; мастера держим короткими (≤5 шагов).

**Фото не туда.** Сейчас фото вне визарда регистрации молча исчезает — для техника это «бот сломался». Новое поведение: если активного визарда нет, но есть задача в статусе `in_progress`:
```
📷 Фото получил. Приложить к задаче «Санобработка кофемашины»?
```
```
[✅ Да, к этой задаче]  [🗑 Убрать, не нужно]
```
Если контекста нет:
```
📷 Фото получил, но не понял, к чему его приложить.
Начни сценарий кнопкой снизу и пришли фото на шаге «Фото».
```

Смежное: **читать `message.caption`** (объявлен в `TgUpdate`, но нигде не используется) как текстовый ввод текущего шага — техник фоткает шильдик и подписывает «A7734120» одним действием. **Медиагруппа**: `media_group_id` добавить в `TgUpdate` и отвечать один раз (`📷 Принял 3 фото.`) вместо трёх сообщений.

**Не изображение** (документ, PDF): Core вернёт `Не изображение: …`. Сотруднику — по-человечески:
```
Это не фото, а файл. Сфоткай камерой — так надёжнее.
```

### 5.15 Идемпотентность и плохая связь

**Слой 1 — гасим кнопки сразу.** После терминального действия — `editMessage` с новым текстом и **без** клавиатуры. Нажать повторно физически нечего. Требует расширения `editMessage` (см. §5.1).

**Слой 2 — ключ операции.** Только для `pt:` (замена детали) и `sv:` (осмотр) — там цена дубля высока. Мастер при старте кладёт `opId` (uuid) в `conv.data`, терминальный вызов Core идёт с ним, Core делает `onConflictDoNothing`. Для остальных мастеров слоя 1 достаточно.

**Слой 3 — ответ на устаревшее нажатие.** Мастера уже нет, `<s8>` не совпал:
```
answerCallbackQuery: «Уже записано ✅»
```
Не «ошибка», не «кнопка устарела» — техник должен понять, что всё в порядке.

**Порядок «сохранить → ответить», а не наоборот.** Если Core записал, а Telegram-ответ не ушёл — техник повторит и получит «Уже записано ✅». Обратный порядок сделал бы потерянную запись похожей на успешную.

При недоступности Core:
```
⚠️ Связь с системой пропала — запись не ушла.
Данные не потерял, они у меня. Нажми «Повторить», когда появится сеть.
```
```
[🔄 Повторить]  [✖️ Бросить]
```
Мастер остаётся в шаге `confirm`, TTL продлевается.

**Фото не блокирует работу.** `uploadPhoto` идёт мимо общего `request()` с таймаутом 10 с — на 3G это регулярный провал. Отдельный таймаут для фото — 60 с (`CoreClient.uploadPhoto` получает собственный `photoTimeoutMs`). При провале:
```
📷 Фото не залилось — связь плохая. Работа записана, пришли фото ещё раз, когда сеть выправится.
```
Очередь дозагрузки с бэкоффом **не делаем**: она живёт в памяти и теряется при рестарте, то есть решает не ту проблему.

**Дубли по смыслу.** Совпадение (сотрудник, вид работы, объект) в окне 2 часов:
```
Ты уже отмечал чистку Kaffit-04 сегодня в 11:35 (12 минут назад).
Записать ещё раз?
```
```
[Нет, это дубль]
[Да, чистил дважды]
```

**Долгий ответ.** Цикл `for(;;)` в `index.ts:355` строго последователен — одно медленное сообщение держит всех. Перед работой, заведомо дольше 2 секунд (загрузка фото, список из 47 автоматов), сначала `answerCallbackQuery("Секунду…")`, потом работа: спиннер гаснет сразу, техник не жмёт второй раз.

---

## 6. Графики и уведомления

### 6.1 Архитектура: три слоя

```
apps/core    — СЧИТАЕТ. MaintenanceService.dueList() — чистая функция от БД.
               Никаких таймеров. Один ответ читают панель, бот и агент.
apps/agents  — ТРИГГЕРИТ. maintenance-monitor.ts + один croner-job.
               Ничего не решает и не форматирует: читает посчитанное,
               ставит задачи и эмитит события.
apps/bot     — ВОЗИТ. Существующий sendReminders() доставляет задачи.
```

Почему монитор в `apps/agents`, а не в боте: там уже три таких монитора (`coffee:monitor`, `globerent:monitor`, `fx:refresh`) с croner + `{timezone: TZ}` + env-override + значение `"off"`; они тестируются как чистые функции от узкого интерфейса (`CoffeeMonitorCoreClient`); и — важно — hardcoded-мониторы в `apps/agents/src/index.ts:331-432` **не уважают** тумблер `AGENTS_SCHEDULES_PAUSED`. Это ровно то, что нужно графику ТО: пауза навыков агентов не должна гасить напоминания о работах.

Почему не cron в Core: Core должен отвечать на вопросы, а не тикать. Существующие крон-ы в Core — ingest внешних выгрузок, другой класс.

### 6.2 Доставка сотруднику: через задачи, не через правила

**Ключевое решение.** Правила (`apps/core/src/rules/rules.ts`) физически не могут дойти до сотрудника: `Notification = {ruleId, urgency, text}` не имеет адресата, доставка — `for (const chatId of allowlist)` (`index.ts:335`). Переделка контракта — это четыре согласованных изменения, включая расширение ключа `notificationDelivery` до `${eventId}:${ruleId}:${recipientId}` (иначе `ack` владельца погасит уведомление сотруднику).

Вместо этого используем существующий канал:

```
maintenance-monitor (cron 0 6 * * *, timezone: Asia/Tashkent)
  → GET /maintenance/due
  → для планов со статусом soon/due/overdue и autoTask=true:
      TasksService.ensureForDay({
        source: `maint:${planId}`,
        dayKey: nextDueOn,
        title, description, entityId: plan.targetId,
        // null у именного графика не проставлен → задача свободная,
        // её разбирают из общего пула через дайджест (§6.4).
        ownerKind: "human", ownerRef: plan.assigneeId,
        due: instantAt(nextDueOn, 18),
        priority, createdBy: "agent:maintenance-monitor",
      })
  → sendReminders() в боте сам доставит задачу в чат техника с taskKeyboard
  → task.remindedAt защищает от дублей
```

Идемпотентность `ensureForDay` — по `source = "${source}:${dayKey}"`, уже реализована (`tasks.service.ts:237-242`). Гонку select-then-insert закрывает **новый уникальный индекс** `task_source_key` (миграция 0040) плюс переписывание метода:

```ts
  /**
   * Идемпотентная постановка повторяющейся задачи.
   *
   * Было select-then-insert — на двух тиках монитора это гонка. Теперь ставку
   * делает БД: уникальный частичный индекс task_source_key + onConflictDoNothing.
   */
  async ensureForDay(input: CreateTaskInput & { dayKey: string }): Promise<TaskRow | null> {
    const source = `${input.source ?? "recurring"}:${input.dayKey}`;
    const [created] = await this.db
      .insert(task)
      .values({ /* … */ source })
      .onConflictDoNothing({ target: task.source })
      .returning();
    return created ?? null;
  }
```

**Ограничение канала, которое надо признать честно.** `sendReminders()` берёт `tasksDueSoon(24)` — push уйдёт за ≤24 часа до `task.due`, а не за `task_lead_days`. Поэтому семантика поля — «за сколько дней **создать задачу**», и задача создаётся с `due` = дата срока. Дополнительно вводим env:

```ts
// apps/bot/src/index.ts
const lookaheadHours = Number(process.env.REMIND_LOOKAHEAD_HOURS ?? 24);
const due = await deps.core.tasksDueSoon(lookaheadHours);
```

### 6.3 `MaintenanceService.dueList()` — read-model

```ts
export interface MaintenanceDueRow {
  planId: string;
  targetId: string;
  targetName: string;
  kind: MaintenanceKind;
  kindLabel: string;
  partKind: string | null;
  partLabel: string | null;
  title: string | null;
  nextDueOn: string | null;
  lastDoneOn: string | null;
  taskLeadDays: number;
  everyDays: number | null;
  everyMonths: number | null;
  everyCount: number | null;
  counterLabel: string | null;
  countLeft: number | null;
  daysLeft: number | null;
  status: DueStatus;
  assigneeId: string | null;
  assigneeName: string | null;
  autoTask: boolean;
}
```

Реализация — **без N+1** (это тот же дефект, который есть в `washScheduleStatus()`):

1. Одна выборка активных планов.
2. Одна выборка имён объектов через `inArray(entity.id, targetIds)`.
3. Одна выборка последних фактов: `DISTINCT ON (plan_id) ... ORDER BY plan_id, performed_on DESC` по `maintenance_log WHERE outcome IS NOT NULL` (индекс `maintenance_log_plan_done_idx` создан ровно под это).
4. Одна выборка `people.linked()`.
5. Дальше — `computeDue()` в памяти по `Map`.

`washScheduleStatus()` тянет весь `coffee_wash_log` и всю `coffee_sale` в память и полагается на порядок перезаписи `Map` — этот приём **не копировать**.

### 6.4 Общий пул: задача без исполнителя, кто взял — того и работа

**Исходное условие, подтверждённое владельцем:** все полевые сотрудники работают по всему парку. Закрепления «объект → человек» не существует, и придумывать его нельзя — иначе система будет назначать работу по правилу, которого в жизни нет, и техники начнут переназначать друг другу задачи вручную.

Отсюда простая механика вместо тиров разрешения ответственного:

```
монитор создаёт задачу свободной (owner_ref = null)
  → утренний дайджест уходит ВСЕМ активным сотрудникам с нужным правом
  → блок «🆓 Свободные — кто возьмёт»
  → первый нажавший «✋ Беру» становится исполнителем (атомарный claim)
  → остальным карточка перерисовывается: «Взял Рустам, 07:14»
```

`resolveAssignees()` не нужен. Вместо него — одно необязательное поле:

```ts
/**
 * plan  — у графика явно проставлен maintenance_plan.assignee_id
 *         (именной график: «поверку кассы всегда делает Рустам»);
 * pool  — исполнителя нет, задача свободная. Это НОРМАЛЬНОЕ состояние
 *         при создании, а не дефект настройки.
 */
export type AssigneeSource = "plan" | "pool";
```

`maintenance_plan.assignee_id` остаётся в схеме и по умолчанию `null`. Одна nullable-колонка стоит дёшево и закрывает будущий случай «эту работу делает только вот этот человек», не заставляя заводить таблицу закреплений.

**Что считается проблемой.** Не отсутствие исполнителя при создании — теперь это норма. Проблема — **никто не взял задачу к сроку**. Монитор проверяет это отдельно:

- задача свободна и `due` наступает сегодня → событие `maintenance.unclaimed`, правило `urgency: "briefing"` — строка в утреннем брифинге владельца;
- задача свободна и просрочена на 1, 3, 7 дней → `maintenance.overdue` с `assigneeId: null`, правило бьёт владельцу пушем.

**Захват и гонка.** Двое нажали «Беру» одновременно — это не редкий случай, а обычное утро при двух техниках и одном дайджесте. Разрешает БД (`TasksService.claim()`, §4.7): `UPDATE … WHERE owner_ref IS NULL RETURNING`. Проигравший получает не ошибку, а обновлённую карточку:

```
🔧 Замена фильтра воды
🏷 Kaffit-01 · ТЦ «Компас»

✋ Уже взял Рустам в 07:14.
```
```
[📋 Другие свободные]  [⬅️ Меню]
```

**Отказ от взятой задачи.** Кнопка `↩️ Не смогу` возвращает задачу в пул (`owner_ref = null`), пишет `auditLog` и, если задача просрочена, событие владельцу. Без этого техник, взявший задачу и застрявший, молча блокирует её до срока.

**Доставка свободных задач.** `sendReminders()` ходит по `ownerRef` и свободную задачу доставить не может — она уходит только владельцу. Поэтому свободные задачи доставляет **утренний дайджест** (§6.6), который рассылается по списку активных сотрудников, а не по владельцу задачи. Это разделение обязанностей: дайджест — про пул, `sendReminders` — про то, что уже на человеке.

### 6.5 Замыкание цикла «сделал → план сдвинулся»

Без этого график молча висит просроченным навсегда: `dayKey = nextDueOn` не меняется, `source:dayKey` занят, новая задача не создастся.

В той же транзакции, где создаётся `maintenance_log` с непустым `planId` и `outcome IS NOT NULL`:

```ts
      // greatest(): performed_on — свободная дата, техник вносит задним числом.
      // Простой set сдвинул бы срок в ПРОШЛОЕ.
      await tx.update(maintenancePlan).set({
        lastDoneOn: sql`greatest(${maintenancePlan.lastDoneOn}, ${log.performedOn}::date)`,
        lastDoneCounter: log.counterValue ?? undefined,
        lastLogId: log.id,
        // Якорь обязательства двигаем по календарю, а не по дате исполнения:
        // техосмотр 20.08 при сроке 01.09 не должен сдвинуть годовщину на 20.08.
        dueOn: plan.dueOn !== null && plan.everyMonths !== null
          ? nextAnchor(plan.dueOn, plan.everyMonths, log.performedOn)
          : plan.dueOn,
        updatedAt: new Date(),
      }).where(eq(maintenancePlan.id, plan.id));

      if (log.taskId !== null) {
        await this.tasks.setStatus(log.taskId, "done", `person:${personId}`, log.note ?? "Работа записана");
      }
```

где

```ts
/** Сдвигает якорь на N месяцев вперёд, пока он не окажется позже даты выполнения. */
function nextAnchor(anchor: DayKey, everyMonths: number, doneOn: DayKey): DayKey {
  let a = anchor;
  // Потолок 200 итераций — защита от порченых данных, а не от бизнес-случая.
  for (let i = 0; i < 200 && diffDays(doneOn, a) <= 0; i += 1) a = addMonths(a, everyMonths);
  return a;
}
```

**Обратное направление.** Закрытие задачи с `source LIKE 'maint:%'` через обычный `✅ Выполнил` без записи `maintenance_log` — не тихое закрытие, а перенаправление:

```
Эта задача из графика обслуживания. Чтобы она засчиталась, запиши, что сделал:
```
```
[🔧 Замена детали]  [🧼 Почистил]
[🛠 Технический осмотр]
```

### 6.6 Политика упреждения

**Плановое никогда не идёт отдельным пушем.** Всё со статусом `soon`/`due` попадает в утренний дайджест 07:00 и в задачи. Событий в шину по ним не пишется вообще — иначе `pending(limit 500)` захлебнётся, а сотрудник получит пять сообщений подряд в шесть утра.

**Горизонты по видам работ** (`packages/shared/src/roles.ts` соседом или в `maintenance-due.ts`):

```ts
/**
 * Дефолтный task_lead_days по виду работ. Горизонт равен времени, которое
 * человеку нужно НА ПОДГОТОВКУ, и ничему больше. Предупреждение раньше, чем
 * можно начать готовиться, — шум, а шум учит игнорировать бота целиком.
 */
export const DEFAULT_LEAD_DAYS: Record<MaintenanceKind, number> = {
  cleaning: 0,     // 20 минут и вода на точке — готовиться нечему
  sanitation: 1,   // нужна химия с собой и окно без продаж
  service: 3,      // нужны запчасти со склада, местный срок поставки
  part_replace: 3, // то же
  inspection: 7,   // подрядчик, документы, иногда вывоз аппарата
  calibration: 7,  // поверка — та же логика
  repair: 0,       // реактивная работа, планового горизонта нет
  other: 3,
};
```

**Отдельным пушем идёт ровно три вещи:** просрочка на ступенях 1 / 3 / 7 дней (дальше молчим — вопрос уже не к боту); задача, назначенная лично в течение дня (существующие `sendReminders` / `sendRedoNotices`); авария по объекту.

**Утренний дайджест сотрудника, 07:00** (раньше владельческого брифинга 07:30 — владелец должен видеть, что люди уже получили). Строится из `myTasks` + свободных задач + `dueList`, группируется **по объекту**, а не по виду работ: техник ездит по точкам, а не по видам.

Дайджест — единственный канал доставки свободных задач (§6.4), поэтому рассылается по списку `people.linked()` с фильтром по правам, а не по владельцу задачи. Блок «🆓 Свободные» в дайджесте одинаков у всех получателей на момент рассылки; расходятся они после первого `claim`, и это нормально — карточка перерисовывается по кнопке `🔄 Обновить`.

Идемпотентность дайджеста — по ключу `staff-digest:<dayKey>:<personId>`. Для этого **нужно добавить в Core** маленький сервис поверх существующей таблицы `notification_delivery`:

```ts
  /**
   * Атомарная заявка на одноразовое действие. Вернёт true ровно один раз
   * на ключ — insert … onConflictDoNothing … returning решает гонку в БД.
   */
  async claim(key: string): Promise<boolean> {
    const rows = await this.db
      .insert(notificationDelivery).values({ key })
      .onConflictDoNothing({ target: notificationDelivery.key })
      .returning({ key: notificationDelivery.key });
    return rows.length > 0;
  }
```
REST: `POST /notify/claim { key }` → `{ claimed: boolean }`. Клиент: `CoreClient.claimNotification(key)`.

Вечерний итог, недельная статистика, «прошу перенести» — **отложены** (§10).

### 6.7 Монитор: `apps/agents/src/maintenance-monitor.ts`

```ts
/** Узкий контракт Core-клиента — как CoffeeMonitorCoreClient, ради тестов. */
export interface MaintenanceMonitorCoreClient {
  maintenanceDue(): Promise<MaintenanceDueRow[]>;
  ensureTaskForDay(input: EnsureTaskInput): Promise<{ created: boolean; taskId?: string }>;
  recordEvent(input: { source: string; type: string; payload?: Record<string, unknown> }): Promise<unknown>;
}

/** Ступени напоминания о просрочке: 1-й, 3-й и 7-й день. */
const OVERDUE_STEPS = [1, 3, 7] as const;

/**
 * Один проход. Монитор ничего не решает и ничего не форматирует: Core уже
 * посчитал статусы, правила уже знают тексты. Здесь — только «что из этого
 * достойно задачи и что достойно шины».
 *
 * Крон — раз в сутки. Именно суточная периодичность делает дедупликацию
 * событий бесплатной: daysOverdue принимает значение 3 ровно один день,
 * значит и событие уйдёт ровно один раз. Ручной повторный запуск в тот же
 * день задвоит событие — это осознанный размен на отсутствие outbox.
 */
export async function runMaintenanceMonitor(
  core: MaintenanceMonitorCoreClient,
  now = new Date(),
): Promise<{ tasks: number; overdue: number; unclaimed: number; errors: string[] }>
```

Логика на строку:

- `status === "unknown"` → пропустить (это дефект настройки, о нём владелец узнаёт на экране, а не пушем в 6 утра).
- `status ∈ {soon, due, overdue}` и `autoTask` → `ensureTaskForDay`.
- задача свободна (`ownerRef === null`) и срок наступает сегодня → событие `maintenance.unclaimed`. Свободная задача со сроком в будущем — норма, события не даёт.
- `daysOverdue ∈ {1,3,7}` → событие `maintenance.overdue`.
- `daysLeft === 0` (срок сегодня) просрочкой **не считается**: техник закроет вечером.

Каждый источник — в своём `try/catch`, ошибки копятся в `errors[]` (образец — `runCoffeeMonitor`).

Расписание в `apps/agents/src/index.ts` по образцу строк 356-379:

```ts
// Графики обслуживания. 06:00 — ДО дайджеста сотрудникам (07:00) и до
// брифинга владельца (07:30): к моменту рассылки задачи уже стоят.
const maintCron = process.env.MAINTENANCE_MONITOR_CRON ?? "0 6 * * *";
if (maintCron.toLowerCase() !== "off") {
  new Cron(maintCron, { timezone: TZ, name: "maintenance:monitor" }, () => { /* … */ });
}
```

Плюс `MAINTENANCE_MONITOR_CRON`, `REMIND_LOOKAHEAD_HOURS`, `STAFF_DIGEST_CRON`, `INVITE_PEPPER` в `/home/user/mydon/.env.example` (рядом с `COFFEE_MONITOR_CRON`) и в `/home/user/mydon/deploy/docker-compose.yml` (блоки `mydon-agents.environment` и `mydon-bot.environment`).

### 6.8 Новые события и правила

| type | source | payload | кто эмитит |
|---|---|---|---|
| `maintenance.overdue` | `maintenance-monitor` | `{planId, kind, kindLabel, targetId, targetName, partLabel, dueDate, daysOverdue, assigneeId, assigneeName}` | агент |
| `maintenance.unclaimed` | `maintenance-monitor` | `{taskId, planId, kind, kindLabel, targetName, dueDate}` | агент |
| `maintenance.blocked` | `core` | `{logId, kind, kindLabel, targetName, personId, personName, reason, day}` | Core при `outcome='failed'` или осмотре «не годен» |
| `maintenance.done` | `core` | `{logId, planId, kind, kindLabel, targetName, partLabel, personId, personName, at}` | Core при записи факта |
| `staff.bot_blocked` | `bot` | `{personId, personName, reason, day}` | бот при 403 |

Событий `maintenance.due` / `soon` **нет намеренно**.

Правила — в конец массива `RULES` в `/home/user/mydon/apps/core/src/rules/rules.ts`, в существующем стиле, **без изменения контракта `Rule`/`Notification`** (все адресуются владельцу):

```ts
/** Подузел словами, если он есть: «, бункер 3», «, купюроприёмник». */
const partPart = (v: unknown): string =>
  v === undefined || v === null || v === "" ? "" : `, ${String(v)}`;

{
  id: "maintenance.overdue.owner",
  eventType: "maintenance.overdue",
  urgency: "immediate",
  // Владельцу — только когда исполнитель уже получил напоминание и не сделал.
  // Раньше это шум: техник в дороге, работа будет закрыта к вечеру.
  when: (c) => num(c.payload.daysOverdue) >= 3,
  format: (c) =>
    `🛠🔴 ${str(c.payload.kindLabel)} не сделана ${num(c.payload.daysOverdue)} дн.: ` +
    `${str(c.payload.targetName)}${partPart(c.payload.partLabel)}. ` +
    `Ответственный: ${str(c.payload.assigneeName, "не назначен")}.`,
},
{
  id: "maintenance.inspection.overdue.owner",
  eventType: "maintenance.overdue",
  urgency: "immediate",
  // Технический осмотр — это допуск, а не уборка: один день просрочки уже
  // риск, поэтому порог отдельный и куда ниже общего.
  when: (c) => c.payload.kind === "inspection" && num(c.payload.daysOverdue) >= 1,
  format: (c) =>
    `📋🔴 Просрочен технический осмотр: ${str(c.payload.targetName)} — ` +
    `срок был ${str(c.payload.dueDate)} (${num(c.payload.daysOverdue)} дн. назад).`,
},
{
  id: "maintenance.unclaimed",
  eventType: "maintenance.unclaimed",
  urgency: "briefing",
  format: (c) =>
    `🙋 Никто не взял: ${str(c.payload.kindLabel)} — ${str(c.payload.targetName)}, ` +
    `срок сегодня (${str(c.payload.dueDate)}).`,
},
{
  id: "maintenance.blocked",
  eventType: "maintenance.blocked",
  urgency: "immediate",
  format: (c) =>
    `🚫 ${str(c.payload.personName)} не смог сделать: ${str(c.payload.kindLabel)}, ` +
    `${str(c.payload.targetName)}.\nПричина: ${str(c.payload.reason, "не указана")}`,
},
{
  id: "staff.bot_blocked",
  eventType: "staff.bot_blocked",
  urgency: "immediate",
  format: (c) =>
    `📵 До сотрудника не доходят сообщения: ${str(c.payload.personName)} — ${str(c.payload.reason)}.\n` +
    `Задачи и график он не видит; свяжитесь другим каналом.`,
},
```

> Проверить `apps/core/src/rules/rules.test.ts` после правки: тест `:94-101` требует ровно одно правило на `coffee.underfill` при `fillRatio < 0.3`. Новые правила его не задевают (другие `eventType`), но прогон обязателен.

### 6.9 Ошибки Telegram: 403, 429, таймауты

Сегодня `telegram.ts:66` схлопывает всё в безымянный `Error`. Последствия реальны: `sendRedoNotices` пытается доставить возврат на доработку **бесконечно** (`markRedoNotified` внутри `try` после `sendMessage`), а `sendReminders` при 403 сотруднику + успешной доставке владельцу ставит `markReminded` — и **сотрудник не узнает о задаче никогда**.

```ts
/** Ошибка Bot API с разобранным кодом. Без неё 403 неотличим от 500,
 *  и заблокировавший бота техник молча уводит все напоминания в пустоту. */
export class TelegramError extends Error {
  constructor(
    readonly method: string,
    readonly errorCode: number | null,
    readonly description: string,
    readonly retryAfterSec: number | null,
  ) {
    super(`Telegram ${method}: ${description}`);
  }
}

private async call<T>(method: string, body: unknown, timeoutMs = 15_000): Promise<T> {
  const res = await fetch(this.url(method), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (res.status === 401 || res.status === 404) throw new InvalidTokenError(/* как было */);
  const json = (await res.json()) as {
    ok: boolean; result?: T; description?: string;
    error_code?: number; parameters?: { retry_after?: number };
  };
  if (!json.ok) {
    throw new TelegramError(
      method, json.error_code ?? res.status,
      json.description ?? "неизвестная ошибка",
      json.parameters?.retry_after ?? null,
    );
  }
  return json.result as T;
}

async getUpdates(): Promise<TgUpdate[]> {
  // Long poll держится timeoutSec секунд по контракту Bot API — общий таймаут
  // отправки его бы обрывал, превращая опрос в тесную переподключалку с
  // ошибкой в лог каждые 15 секунд.
  const updates = await this.call<TgUpdate[]>(
    "getUpdates",
    { offset: this.offset, timeout: this.timeoutSec, allowed_updates: ["message", "callback_query"] },
    (this.timeoutSec + 10) * 1_000,
  );
  /* … */
}
```

Распознавание недостижимости:

```ts
/** Формулировки Telegram для «этот чат больше не примет сообщений». */
const UNREACHABLE = [
  /bot was blocked by the user/i,
  /user is deactivated/i,
  /bot can't initiate conversation/i,
  /have no rights to send/i,
];

export function isUnreachable(err: unknown): boolean {
  if (!(err instanceof TelegramError)) return false;
  // «chat not found» НЕ включаем: Telegram отдаёт его и на транзиентных сбоях,
  // а последствие отвязки — бот полностью замолкает для человека (index.ts:139).
  return err.errorCode === 403 && UNREACHABLE.some((re) => re.test(err.description));
}
```

Что делает бот при `isUnreachable`:

1. `POST /people/:id/telegram-unreachable { reason }` — **нужно добавить метод** `PeopleService.markUnreachable(personId, reason)`: пишет `person.attrs.tgBlockedAt` (нужно расширить `UpdatePersonDto` полем `attrs` либо сделать отдельный узкий эндпойнт — предпочтительно второе), `auditLog` с `action: "person.telegram_unreachable"`. **`person.active` НЕ трогаем** — `people.service.ts:170` ищет по `active='yes'`, и пометка «неактивен» стёрла бы человека из всех списков из-за того, что он нажал «блок».
2. Событие `staff.bot_blocked` → правило `immediate` → владельцу.
3. Прекратить попытки: в `sendReminders`/`sendRedoNotices` пропускать людей с `tgBlockedAt`.

**Правка бага «напомнили, но не дошло»** (`index.ts:262-276`):

```ts
  // Доставка владельцу — это НЕ доставка исполнителю. Если задача на человеке,
  // а до человека не дошло, отметку не ставим: иначе dueSoon() (remindedAt is null)
  // никогда её больше не вернёт, и исполнитель не узнает о задаче вообще.
  const needsAssignee = t.ownerKind === "human" && t.ownerRef !== null;
  if (deliveredToAssignee || (!needsAssignee && deliveredToOwner)) {
    await deps.core.markReminded(t.id);
  }
```

**Ограничитель исходящих** — внутрь `TelegramApi`, а не в один из вызывающих: тогда он покроет и `sendReminders` (до 50 задач × чат исполнителя + весь allowlist), и 10 карточек задач подряд, и брифинг.

```ts
/**
 * Ограничитель исходящих. Telegram лимиты договором не публикует; на практике
 * рвёт на ~30 сообщениях/с глобально и ~1/с в один чат. Берём с запасом.
 * 429 тормозит ВСЮ отправку, а не одно сообщение: иначе следующие добивают
 * уже перегруженную квоту и получают такой же 429.
 */
export class OutRate {
  async take(chatId: number): Promise<void>;
  pause(ms: number): void;
  sweep(): void; // иначе карта чатов растёт вместе со штатом и не уменьшается
}
```
`await this.rate.take(chatId)` — первой строкой в `sendMessage`/`sendDocument`; при `TelegramError` c `errorCode === 429` — `this.rate.pause((retryAfterSec ?? 5) * 1000 + 1000)`.

---

## 7. Экраны в `apps/cc`

Конвенция проекта: каждая фича бота дублируется экраном в панели. Владелец должен уметь всё то же самое мышкой.

### 7.1 `/domain/vendhub?tab=maintenance` — «Обслуживание» (новая вкладка)

Добавить в список вкладок `apps/cc/src/app/domain/[domain]/page.tsx` (строки 261-283), рядом с `vending` и `coffee`. Три блока:

**Блок «Графики» (верх).** Таблица планов: объект · вид работ · узел · периодичность · последний раз · следующий срок · статус · «уведомлён» (иконка — есть ли задача с `source LIKE 'maint:<planId>:%'`) · кто взял (имя исполнителя или «свободна» — колонка «ответственный» заменена на фактического исполнителя задачи, потому что закреплений нет). Цвета — те же четыре: 🔴 / 🟡 / 🟢 / ⚪. Счётчик в шапке: `Просрочено N · Скоро M · Норматив не задан K`.

Действия: «Новый график» (объект, вид, узел, периодичность, `task_lead_days`, необязательный именной исполнитель — по умолчанию пусто, задача уходит в общий пул), «Правка», «Выключить» (`is_active = false`, а не удаление — исключение для отдельного автомата выражается именно так), «Применить к списку объектов» (массовое создание планов по шаблону — заменяет модельные шаблоны).

**⚪ обязательно отдельно от 🔴.** Если при запуске все 40 автоматов покажут «просрочено», в график перестанут смотреть на второй день. Поэтому `activated_on` по умолчанию = день заведения плана: «считаем, что базовое обслуживание выполнено в день постановки на учёт».

**Блок «Журнал работ».** Лента `maintenance_log` за период: дата · объект · вид · узел · исполнитель · результат · заметка · миниатюры фото (стадии «до»/«после» разными подписями). Фильтры: объект, исполнитель, вид, `outcome`. Строки с `outcome IS NULL` старше суток — отдельным предупреждением «начато и не закрыто».

**Блок «Замены узлов».** Лента `machine_part`: автомат · узел · S/N · установлен · снят · причина · наработка (дней) · гарантия. Фильтр по S/N («где сейчас стоит A7734120»). Сводка «MTBF по моделям» — средняя наработка `removed_on − installed_on` с группировкой по `part_model_id`.

### 7.2 `/card/[id]` — карточка автомата, два новых блока

**«Узлы сейчас»** — открытые периоды `machine_part` (`removed_on IS NULL`): узел, модель/название, S/N, стоит с, гарантия до. Кнопка «Добавить узел» (первичная перепись) и «Заменить».

**«Обслуживание»** — последние 10 записей `maintenance_log` по этому объекту + список активных планов со статусом.

### 7.3 `/tasks/[id]` — галерея фото по стадиям

Сейчас фото задачи не показываются вовсе. Добавить блок: `core.attachments("task", id)`, сгруппировать по `stage` — «До», «После», «Прочее». Владелец должен видеть подтверждение, ради которого всё и делалось.

### 7.4 `/team` и `/team/[id]` — роли и доступ

- В списке: чипы ролей, красная метка «роль не задана», метка «доступ не выдан» (нет `tgChatId` и нет живого приглашения), метка «бот заблокирован» (`attrs.tgBlockedAt`).
- Форма создания (`apps/cc/src/components/person-new.tsx`): + телефон, + чипы ролей с подсказками `ROLE_HINTS`, кнопка «Создать и выдать доступ».
- Карточка сотрудника: блок «Доступ» (статус привязки, «Выпустить приглашение» / «Отозвать доступ» / «Уволить»), блок «Работы за 30 дней» (число записей `maintenance_log`, доля `outcome='done'`, разбивка по видам работ). Блока «Закреплённые объекты» нет: все работают по всему парку, и список из 47 одинаковых строк у каждого сотрудника — не информация.

Новые компоненты: `apps/cc/src/components/person-roles.tsx`, `person-invite.tsx`, `person-assignments.tsx`.

### 7.5 `/registry` — починить подпись `component`

`apps/cc/src/lib/labels.ts` не содержит `component` ни в `TYPE_LABELS`, ни в `TYPE_ONE` — карточки запчастей, которые уже заводит визард бота, показываются латиницей. Добавить:

```ts
  component: "запчасти",   // в TYPE_LABELS
  component: "запчасть",   // в TYPE_ONE
```

### 7.6 `/mydon` — брифинг владельца

Добавить строки в утренний брифинг (`apps/bot/src/briefing.ts` + соответствующий блок панели):

```
🛠 Обслуживание: просрочено 3, скоро 5, норматив не задан 2.
🔑 Приглашений не использовано: 2 (Рустам, Азиз).
📵 Бот заблокирован: 1 (Азиз) — задачи не доходят.
```

---

## 8. Этапы работ

Каждый PR должен собираться, проходить `pnpm lint && pnpm typecheck && pnpm test` и деплоиться самостоятельно.

---

### PR 1 — `feat(bot): кнопочное меню сотрудника, отмена в каждом мастере, один список задач`

**Объём: M. Зависимости: нет.**

Первый PR даёт видимую ценность без единой миграции: сотрудник получает постоянное меню внизу экрана, кнопку «Отмена» на каждом шаге и один список задач вместо десяти сообщений.

**Создать:**
- `apps/bot/src/menu.ts`, `apps/bot/src/menu.test.ts`

**Изменить:**
- `apps/bot/src/telegram.ts` — типы `ReplyKeyboard`/`ReplyMarkup`, `sendMessage(chatId, text, markup?)`, `editMessage(..., keyboard?)`, `answerCallback(..., showAlert?)`; в `TgUpdate` — `media_group_id`
- `apps/bot/src/staff.ts` — порядок разбора по §5.3, реестр триггеров вместо цепочки `if`, `HELP_STAFF` строится из `menuFor()`
- `apps/bot/src/index.ts` — `/start` отправляет два сообщения (приветствие с reply-меню, затем список задач), `routeStaffMessage` больше не шлёт по сообщению на задачу
- `apps/bot/src/staff-inventory.ts`, `staff-intake.ts`, `coffee-refill.ts`, `coffee-returns.ts` — отрендерить кнопку `✖️ Отмена` (парсеры `i:cancel`/`n:cancel`/`cf:cancel`/`cw:cancel`/`cc:cancel` уже существуют)
- `apps/bot/src/coffee-fix.ts` — «🗑 Да, удалить» вынести в отдельный нижний ряд
- `apps/bot/src/staff.ts:135-139` — `formatCollectedAt` переписать через `toLocaleString("ru-RU", { timeZone: TZ })`: сейчас `d.getDate()/getHours()` работает только потому, что в контейнере `TZ: Asia/Tashkent`
- `apps/bot/src/conversation.ts` — TTL 15 → 45 мин

**Критерии приёмки:**
- После `/start` внизу экрана постоянное меню; оно переживает перезапуск бота.
- Нажатие кнопки меню посреди мастера бросает мастер с пояснением, а не отвечает «Выбери точку кнопкой».
- Отчёт «сделал заливку» после «✅ Сделал» закрывает задачу, а не открывает список задач.
- Список задач приходит одним сообщением с номерными кнопками.
- В каждом мастере на каждом шаге есть `✖️ Отмена`, она работает и на протухшем визарде.

**Тесты:**
- `menu.test.ts`: `matchMenuLabel` ловит только точную подпись; `matchTrigger` не ловит пункты с `ready: false`; `menuFor` при пустых `roles` (пока фильтра нет — все пункты).
- `staff.test.ts` (дополнить): «отчёт «сделал заливку» закрывает задачу, а не открывает список задач»; «кнопка меню бросает активный визард»; «`✖️ Отмена` на истёкшем визарде не падает».
- `coffee-refill.test.ts`, `staff-inventory.test.ts`: клавиатура содержит кнопку отмены.

---

### PR 2 — `feat(core): задача знает объект, вложение знает стадию съёмки`

**Объём: M. Зависимости: PR 1 (не жёсткая, можно параллельно).**

**Создать:**
- `packages/db/drizzle/0040_task_entity_photo_stage.sql` (через `db:generate`, затем переименовать + поправить `_journal.json`; FK на `task` оформить как `NOT VALID` + `VALIDATE CONSTRAINT`)

**Изменить:**
- `packages/db/src/schema.ts` — `task.entityId`, `task_entity_idx`, `task_source_key`, `attachment.stage`
- `apps/core/src/tasks/tasks.service.ts` — `entityId?: string` в `CreateTaskInput`, проброс в `create()`; `ensureForDay` переписать на `insert … onConflictDoNothing({ target: task.source }).returning()`; **общий пул** — `claim(taskId, personId)` (атомарный `UPDATE … WHERE owner_ref IS NULL RETURNING`, §4.7), `release(taskId, personId)` и `unassigned(limit)` для выборки свободных
- `apps/core/src/tasks/tasks.controller.ts` — `@IsOptional() @IsUUID() entityId?: string` в `CreateTaskDto` и в `EditTaskDto`, маппинг; `POST /tasks/:id/claim`, `POST /tasks/:id/release`, `GET /tasks?unassigned=1`
- `apps/core/src/attachments/attachments.controller.ts` — `@IsOptional() @IsIn(["before","after","plate","counter"]) stage?: string`
- `apps/core/src/attachments/attachments.service.ts` — `stage` в сигнатуре `upload()`, в `insert().values()`, в `AttachmentMeta` и в `toMeta()`
- `apps/bot/src/core-client.ts` — `entityId: string | null` в `TaskRow`; `uploadPhoto(input: { …; stage?: string })` → `form.append("stage", …)`; отдельный `photoTimeoutMs = 60_000` вместо общего 10 с
- `apps/cc/src/lib/core.ts` — `entityId`, `stage` в соответствующих типах

**Критерии приёмки:**
- `POST /tasks { entityId }` сохраняет объект, `GET /tasks/:id` его отдаёт.
- Две одновременные попытки `ensureForDay` с одним `source:dayKey` дают одну задачу.
- `POST /attachments` с `stage=before` сохраняет стадию, `GET /attachments?...` её возвращает.
- Загрузка фото на 3G (эмуляция задержки 30 с) не отваливается по таймауту.
- `POST /tasks/:id/claim` на свободной задаче назначает исполнителя; на уже взятой возвращает 409 и не меняет исполнителя.

**Тесты:**
- `packages/db/src/schema.test.ts` — проходит (новых таблиц нет, но колонки в снапшоте).
- `apps/core/src/tasks/tasks.service.test.ts`: «повторный ensureForDay на тот же день не создаёт вторую задачу»; «entityId сохраняется и возвращается»; «два `claim` подряд: второй возвращает null, исполнитель остаётся первым»; «`release` возвращает задачу в пул и пишет `auditLog`».
- `apps/core/src/attachments/attachments.service.test.ts`: «stage сохраняется»; «неизвестный stage отвергается DTO»; «kind=photo по-прежнему требует изображение».

---

### PR 3 — `feat(bot): закрытие задачи мастером — фото «до/после» и отчёт`

**Объём: M. Зависимости: PR 1, PR 2.**

**Создать:**
- `apps/bot/src/task-done.ts` (namespace `dn:`), `apps/bot/src/task-done.test.ts`

**Изменить:**
- `apps/bot/src/staff.ts` — ветка `conv?.flow === "task-done"` в блоке визардов; `parseTaskDoneCallback` в `handleStaffCallback`; кнопка `t:<u>:open` (расширить регекс `parseTaskCallback` до `(progress|done|open)`)
- `apps/bot/src/index.ts` — `routeStaffPhoto` маршрутизирует фото в активный визард `task-done`, а не только в `handleRegisterPhoto`; читать `message.caption`; ответ на медиагруппу один раз
- `apps/bot/src/core-client.ts` — `attachmentsOfOwner(ownerType, ownerId)` (нужен для сводки «Фото: 1 «до», 2 «после»»)

**Критерии приёмки:**
- «▶️ Взял в работу» редактирует карточку на месте, старые кнопки гаснут.
- «✅ Выполнил» ведёт по шагам «отчёт → фото после → сводка → отправить».
- Фото «до» и «после» лежат в `attachment` с `ownerType='task'` и разными `stage`.
- Фото, присланное вне визарда при задаче `in_progress`, предлагается приложить к ней.
- После отправки сообщение редактируется без клавиатуры — повторно нажать нечего.

**Тесты:**
- `task-done.test.ts`: парсер `dn:` отвергает чужой и подделанный payload; сквозной проход с проверкой `conversations.get(chatId)?.step` после каждого шага; отмена очищает визард; кнопка на истёкшем визарде зовёт начать заново; закрытие чужой задачи невозможно.

---

### PR 4 — `feat(core): журнал обслуживания и узлы автоматов`

**Объём: L. Зависимости: PR 2 (нужен `attachment.stage`).**

**Создать:**
- `packages/db/drizzle/0041_maintenance_log.sql`
- `apps/core/src/maintenance/maintenance.module.ts`
- `apps/core/src/maintenance/maintenance.service.ts`, `maintenance.service.test.ts`
- `apps/core/src/maintenance/maintenance.controller.ts`

**Изменить:**
- `packages/db/src/schema.ts` — 4 enum'а, `maintenanceLog`, `machinePart`, регистрация в `export const schema`
- `apps/core/src/app.module.ts` — подключить `MaintenanceModule`
- `apps/cc/src/lib/labels.ts` — `component: "запчасти"` / `"запчасть"`

**REST:**
- `POST /maintenance/log` — создание записи (`outcome` может быть `null` = «начата»)
- `PATCH /maintenance/log/:id` — закрытие (`outcome`, `note`, `counterValue`)
- `DELETE /maintenance/log/:id?actor=&by=` — только автор, окно 60 минут, запрет при связанных `machine_part`
- `GET /maintenance/log?entityId=&personId=&from=&to=`
- `POST /maintenance/part-swap` — атомарная замена: закрыть старый период, открыть новый, обе строки ссылаются на один `logId`
- `GET /maintenance/parts?machineId=` — узлы автомата (открытые + история)
- `GET /maintenance/recent-objects?personId=&limit=` — MRU для пикера бота (union `maintenance_log` + `collection`)

**Критерии приёмки:**
- `part-swap` одной транзакцией закрывает `removed_on` старого узла и открывает новый; частичный unique не даёт двум узлам занять одно место.
- Каждая мутация пишет `auditLog` (`maintenance.log_created`, `maintenance.part_swapped`).
- `kind='part_replace'` проходит через `assertCan(actor, "parts.replace")` (в мягком режиме только пишет `access.denied`).
- Удаление записи старше 60 минут отвергается с человеческим текстом.

**Тесты (`maintenance.service.test.ts`):**
- «замена закрывает старый период и открывает новый одной транзакцией»;
- «два открытых узла на одном месте невозможны»;
- «удаление записи откатывает `machine_part` — запрещено»;
- «запись без `outcome` не считается выполненной работой»;
- «`performed_on` берётся по Ташкенту: работа в 23:40 — сегодняшняя»;
- «каждая мутация оставляет строку в `auditLog`».
- `packages/db/src/schema.test.ts` — падает, если таблицы не внесены в `schema`.

---

### PR 5 — `feat(bot): мастера «Замена детали», «Почистил», «Технический осмотр», «Поломка»`

**Объём: L. Зависимости: PR 4.**

**Создать:**
- `apps/bot/src/machine-picker.ts` + `.test.ts` (namespace `mp:`)
- `apps/bot/src/part-replace.ts` + `.test.ts` (`pt:`)
- `apps/bot/src/clean.ts` + `.test.ts` (`cl:`)
- `apps/bot/src/service-check.ts` + `.test.ts` (`sv:`)
- `apps/bot/src/problem.ts` + `.test.ts` (`pr:`)
- `packages/shared/src/part-labels.ts` — `PART_LABELS: Record<PartKind, string>` и `MAINT_KIND_LABELS`, чтобы бот и панель писали одинаково

**Изменить:**
- `apps/bot/src/staff.ts` — четыре ветки визардов, четыре парсера в реестре callback
- `apps/bot/src/menu.ts` — `part`/`clean`/`insp`/`issue` → `ready: true`
- `apps/bot/src/core-client.ts` — `createMaintenanceLog`, `closeMaintenanceLog`, `partSwap`, `machineParts`, `recentObjects`
- `apps/bot/src/coffee-fix.ts` — код `m` в `fx:del`, список записей за сутки вместо одной
- `apps/bot/src/index.ts` — маршрутизация фото в новые визарды

**Критерии приёмки:**
- Замена детали проходит целиком: пикер → узел → два S/N → причина → сводка → **запись** → фото → финал.
- Фото привязывается к уже созданной записи (`ownerType='maintenance_log'`), а не «в воздух».
- `<s8>` защищает от нажатия кнопки со вчерашнего сообщения.
- «🚫 Не годен» при осмотре эмитит `maintenance.blocked`.
- «⚠️ Поломка» с 🔥 создаёт задачу и уведомляет владельца немедленно.
- «↩️ Ошибся» показывает список записей за сутки, включая записи обслуживания.

**Тесты:** для каждого модуля обязательный минимум по образцу существующих — (1) парсер принимает только свой формат; (2) триггер не срабатывает на постороннем; (3) сквозной проход с проверкой шага; (4) отмена очищает визард; (5) кнопка на истёкшем визарде не падает; (6) кнопка с чужим `<s8>` отвечает «карточка устарела».

---

### PR 6 — `feat(core): графики обслуживания — нормативы и расчёт срока`

**Объём: L. Зависимости: PR 4.**

**Создать:**
- `packages/shared/src/maintenance-due.ts` + `.test.ts`
- `packages/db/drizzle/0042_maintenance_plan.sql` (GENERATED-колонка — проверить на staging до прода)

**Изменить:**
- `packages/db/src/schema.ts` — `maintenancePlan`, `maintenanceLog.planId` + FK + `maintenance_log_plan_done_idx`, регистрация в `schema`
- `packages/shared/src/index.ts` — реэкспорт
- `apps/core/src/maintenance/maintenance.service.ts` — `dueList()`, `plans()`, `upsertPlan()`, `deactivatePlan()`; замыкание цикла в `closeMaintenanceLog` (`greatest()`, сдвиг якоря `due_on`, закрытие связанной задачи)
- `apps/core/src/maintenance/maintenance.controller.ts` — `GET /maintenance/due`, `GET /maintenance/plans`, `POST /maintenance/plans`, `PATCH /maintenance/plans/:id`, `POST /maintenance/plans/bulk` (применить шаблон к списку объектов)

**Критерии приёмки:**
- `GET /maintenance/due` возвращает четыре статуса; «норматив не задан» — `unknown`, не `ok`.
- План, не выполнявшийся ни разу, имеет `next_due_on = activated_on` и **находится** индексом (никаких NULL в горячем пути).
- Годовой осмотр, сделанный 20.08 при сроке 01.09, получает следующий срок 01.09 следующего года, а не 20.08.
- `dueList()` на 200 планах делает ≤5 запросов (проверяется счётчиком запросов в тесте).
- Запись факта задним числом не сдвигает `last_done_on` назад.

**Тесты:**
- `maintenance-due.test.ts` — по списку из §4.10.
- `maintenance.service.test.ts` (дополнить): «правка every_days пересчитывает next_due_on тем же UPDATE»; «якорь due_on не сползает на дату исполнения»; «счётчиковый план без показаний — unknown»; «закрытие лога с planId двигает last_done_on и закрывает задачу».

---

### PR 7 — `feat(agents): монитор графиков — задача исполнителю к сроку`

**Объём: M. Зависимости: PR 6.**

**Создать:**
- `apps/agents/src/maintenance-monitor.ts` + `maintenance-monitor.test.ts`

**Изменить:**
- `apps/agents/src/core-client.ts` — `maintenanceDue()`, `ensureTaskForDay()`, рядом с `coffeeFillStatus`
- `apps/agents/src/index.ts` — блок `new Cron(maintCron, { timezone: TZ, name: "maintenance:monitor" }, …)` по образцу строк 356-379
- `apps/core/src/rules/rules.ts` — пять новых правил (§6.8)
- `apps/core/src/tasks/tasks.controller.ts` — `POST /tasks/ensure-for-day`
- `.env.example`, `deploy/docker-compose.yml` — `MAINTENANCE_MONITOR_CRON`

**Критерии приёмки:**
- Прогон монитора создаёт задачу на каждый план со статусом `soon`/`due`/`overdue` и `autoTask=true`; повторный прогон в тот же день не создаёт дублей.
- Задача имеет `entityId`, `due` = дата срока и `ownerRef = null` (свободная), если у графика не задан именной исполнитель.
- Просрочка на 3-й и 7-й день даёт событие владельцу; на 2-й и 4-й — нет.
- Свободная задача со сроком сегодня даёт `maintenance.unclaimed` ровно один раз за день.
- `status='unknown'` не порождает ни задачи, ни события.
- `POST /rules/dry-run` с payload `maintenance.overdue` отдаёт ожидаемый текст.

**Тесты:**
- `maintenance-monitor.test.ts` со stub-клиентом-накопителем вызовов (образец — `staff-register.test.ts:26-45`): «unknown пропускается»; «срок сегодня просрочкой не считается»; «просрочка 3 дня даёт событие, 4 дня — нет»; «свободная задача со сроком сегодня даёт `maintenance.unclaimed`»; «свободная задача со сроком через неделю события не даёт»; «ошибка одного плана не роняет остальные».
- `apps/core/src/rules/rules.test.ts` (дополнить): пороги эскалации, отдельный порог для `inspection`.

---

### PR 8 — `feat(bot): раздел «Графики» и утренний дайджест сотрудника`

**Объём: M. Зависимости: PR 6, PR 7.**

**Создать:**
- `apps/bot/src/schedules.ts` + `.test.ts` (namespace `sc:`)
- `apps/bot/src/staff-digest.ts` + `.test.ts`

**Изменить:**
- `apps/bot/src/index.ts` — таймер дайджеста 07:00 по образцу брифинга (`setTimeout` + самоперепланирование, `msUntil` через `Intl.DateTimeFormat` с `timeZone: TZ`); ветка `m:sched`
- `apps/bot/src/menu.ts` — `sched` → `ready: true`
- `apps/bot/src/core-client.ts` — `maintenanceDue()`, `claimNotification(key)`
- `apps/core/src/notify/notify.service.ts` + `notify.controller.ts` (новые, минимальные) — `POST /notify/claim`
- `apps/core/src/tasks/tasks.service.ts` — `periodStats(ownerRef, from, to)` (для «Сделано сегодня: N из M»)

**Критерии приёмки:**
- «🗓 Графики» показывает **только то, что горит** — статусы `overdue`/`due`/`soon` в горизонте 14 дней, ≤8 строк на страницу. Зелёные и «норматив не задан» не выводятся.
- Свободные задачи попадают в дайджест отдельным блоком; кнопка `✋ Взять` переводит задачу в личный список.
- Две одновременные попытки взять одну задачу: одна выигрывает, второй получает всплывашку «Уже взял N» и перерисованный список, без ошибки в чат.
- Пустой график — сообщение, а не тишина.
- Дайджест уходит один раз в день на человека даже при перезапуске бота (ключ `staff-digest:<день>:<personId>` через `claim`).
- «✅ Сделал сейчас» из карточки графика запускает нужный мастер с подставленным объектом.

**Тесты:**
- `staff-digest.test.ts`: формат при 0 / 1 / 15 работах; группировка по объекту; ≤4096 символов на 30 работах; блок «Свободные» не рисуется при пустом пуле; >5 свободных сворачиваются в «Ещё N».
- `schedules.test.ts`: парсер `sc:`; `unknown` рисуется ⚪, не 🟢; зелёные в выдачу не попадают.
- `tasks.service.test.ts` (дополнить): «`claim` на уже взятую задачу возвращает null и не меняет исполнителя»; «`claim` пишет `auditLog`»; «возврат в пул очищает `ownerRef`».

---

### PR 9 — `fix(bot): 403 не теряет напоминания, таймауты и лимит исходящих`

**Объём: M. Зависимости: нет (можно вести параллельно с PR 4-8, влить до PR 8).**

**Создать:**
- `apps/bot/src/out-rate.ts` + `out-rate.test.ts`

**Изменить:**
- `apps/bot/src/telegram.ts` — `TelegramError`, `call(method, body, timeoutMs = 15_000)`, `getUpdates` с собственным таймаутом `(timeoutSec + 10) * 1000`, `isUnreachable()`, `OutRate` внутри `sendMessage`/`sendDocument`
- `apps/bot/src/index.ts` — правка `markReminded` (только при доставке исполнителю), обработка `isUnreachable` в `sendReminders`/`sendRedoNotices`, `REMIND_LOOKAHEAD_HOURS`
- `apps/core/src/people/people.service.ts` — `markUnreachable(personId, reason)` + `auditLog`
- `apps/core/src/people/people.controller.ts` — `POST /people/:id/telegram-unreachable`
- `apps/core/src/rules/rules.ts` — правило `staff.bot_blocked`
- `.env.example`, `deploy/docker-compose.yml` — `REMIND_LOOKAHEAD_HOURS`

**Критерии приёмки:**
- Пустой long poll не обрывается по таймауту (30 с < 40 с).
- 403 «bot was blocked» помечает человека, уведомляет владельца один раз и прекращает попытки.
- 429 тормозит всю отправку на `retry_after`, а не одно сообщение.
- Просроченная задача, не дошедшая до исполнителя, **не** помечается `remindedAt`.
- Возврат на доработку при заблокированном боте не долбит Telegram в цикле.

**Тесты:**
- `out-rate.test.ts` с подставляемыми часами: ≥1.2 с между сообщениями в один чат; `pause()` тормозит всех; `sweep()` чистит карту.
- `telegram.test.ts` (новый): разбор `error_code`/`retry_after`; 401/404 → `InvalidTokenError`; 403 «bot was blocked» → `isUnreachable`, «chat not found» → нет.
- `bot.test.ts` (дополнить): «доставка владельцу не помечает задачу напомненной исполнителю».

---

### PR 10 — `feat(core): роли сотрудников и подключение по приглашению`

**Объём: L. Зависимости: PR 1 (меню), PR 9 (обработка 403).**

**Создать:**
- `packages/shared/src/roles.ts` + `roles.test.ts`
- `packages/shared/src/invite.ts` + `invite.test.ts`
- `packages/db/src/backfill-roles.ts`
- `packages/db/drizzle/0043_staff_roles.sql`
- `apps/core/src/people/invites.service.ts` + `invites.service.test.ts`
- `apps/bot/src/staff-add.ts` + `.test.ts` (визард владельца, `sa:`)

**Изменить:**
- `packages/db/src/schema.ts` — `person.roles`, `staffInvite`, регистрация
- `packages/db/package.json` — `"db:backfill:roles": "node dist/backfill-roles.js"`
- `packages/shared/src/index.ts` — два реэкспорта
- `apps/core/src/people/people.service.ts` — `assertCan`, `personIdOf`, `enforcing`, `deactivate`, `objectsOf`, `roles` в create/update
- `apps/core/src/people/people.controller.ts` — `roles` в DTO (`@IsArray() @IsIn([...STAFF_ROLES], { each: true })`), маршруты приглашений (§3.4)
- `apps/core/src/people/people.module.ts` — `InvitesService`
- `apps/core/src/system/config-spec.ts` — `ROLES_ENFORCE`, `STAFF_LINK_BY_USERNAME`
- `apps/core/src/people/people.service.ts:123` — `linkTelegram` уважает тумблер
- `apps/bot/src/index.ts` — ветка `/start <payload>` **до** `isAllowed`, `InviteLimiter`, уведомление владельца о подключении, маршрутизация владелец/сотрудник по `can(roles, "system.admin")`
- `apps/bot/src/security/access.ts` — `InviteLimiter`
- `apps/bot/src/menu.ts` / `staff.ts` — фильтр меню по `can()`, отказ по праву
- `apps/bot/src/core-client.ts` — `roles: string[]` в `PersonRow`, `redeemInvite`, `issueInvite`, `revokeAccess`
- `apps/cc/src/components/person-new.tsx`, `apps/cc/src/app/team/page.tsx`, `apps/cc/src/app/team/[id]/page.tsx`, `apps/cc/src/app/team/actions.ts`, `apps/cc/src/lib/core.ts`
- `.env.example`, `deploy/docker-compose.yml` — `INVITE_PEPPER`

**Критерии приёмки:**
- Приглашение гасится ровно один раз; двое по одной ссылке — выигрывает один.
- Неактивная карточка не сжигает приглашение (транзакция откатывается).
- `STAFF_LINK_BY_USERNAME=0` полностью выключает привязку по нику.
- При `ROLES_ENFORCE=0` отказ пишется в `audit_log`, но действие проходит; при `=1` — `403`.
- Меню оператора не содержит «🔧 Замена детали», а слово «заменил» получает вежливый отказ, а не запуск мастера.
- Пустые `roles` не запирают человека: «Мои задачи» работают (BASELINE).
- Бэкфилл без `--apply` ничего не пишет и печатает список неопознанных.
- `deactivate` распускает открытые задачи одним UPDATE и сбрасывает `remindedAt`.

**Тесты:**
- `roles.test.ts`: `viewer`-подобный пустой массив не даёт `cash.collect`; `normalizeRoles` выбрасывает мусор; `guessRole` не угадывает по подстроке; матрица владельца равна `PERMISSIONS`.
- `invite.test.ts`: код только из алфавита и нужной длины; `normalizeInviteCode` съедает пробелы/регистр/дефис; `hashInviteSecret` зависит от перца.
- `invites.service.test.ts`: повторное погашение → `used`; протухшее не гасится; чужой `chatId` отвязывается; `inactive` не сжигает приглашение.
- `menu.test.ts` (дополнить): меню по ролям.
- `staff-add.test.ts`: мультивыбор ролей через `editMessage` с клавиатурой не теряет кнопки.

---

### PR 11 — `feat(cc): рабочее место обслуживания владельца`

**Объём: L. Зависимости: PR 4, PR 6, PR 10.**

**Создать:**
- `apps/cc/src/app/domain/[domain]/maintenance-client.tsx`
- `apps/cc/src/components/maintenance-plans.tsx`, `maintenance-log.tsx`, `machine-parts.tsx`
- `apps/cc/src/components/person-roles.tsx`, `person-invite.tsx`, `person-assignments.tsx`
- `apps/cc/src/app/domain/[domain]/maintenance-actions.ts`

**Изменить:**
- `apps/cc/src/app/domain/[domain]/page.tsx` — вкладка `maintenance` (строки 261-283)
- `apps/cc/src/lib/domain-nav.ts` — пункт «Обслуживание»
- `apps/cc/src/app/card/[id]/page.tsx` — блоки «Узлы сейчас» и «Обслуживание»
- `apps/cc/src/app/tasks/[id]/page.tsx` — галерея фото по стадиям
- `apps/cc/src/lib/core.ts` — типы и вызовы новых эндпойнтов
- `apps/bot/src/briefing.ts` — три новые строки брифинга (§7.6)

**Критерии приёмки:**
- Владелец заводит, правит и выключает график мышкой.
- «Применить к списку объектов» создаёт планы пачкой.
- Журнал показывает фото «до/после» миниатюрами.
- Карточка автомата показывает текущий состав узлов с S/N и гарантией.
- Карточка задачи показывает фото по стадиям.
- Брифинг владельца содержит счётчики обслуживания и приглашений.

**Тесты:** серверные экшены — тестами на `node:test` там, где есть чистая логика (сборка payload, валидация периодичности). UI-тестов в проекте нет — не заводим.

---

### Сводка последовательности

```
PR1 ──┬── PR2 ── PR3
      │     └──── PR4 ──┬── PR5
      │                 └── PR6 ── PR7 ── PR8
      ├── PR9 ─────────────────────┘
      └── PR10 ─────────────────────────── PR11
                        (PR4, PR6 тоже входят в PR11)
```

Точка, после которой владелец видит первую ценность — **PR 1**. Точка, после которой закрыты все шесть требований — **PR 8**. PR 9-11 — надёжность, безопасность и зеркало в панели.

---

## 9. Риски и открытые вопросы

### 9.0 Уже отвечено владельцем

| Вопрос | Ответ | Что из этого следует |
|---|---|---|
| Кто за какой объект отвечает | **Все сотрудники работают по всему парку**, закреплений нет | Таблица `staff_assignment` и трёхтировое разрешение исполнителя удалены из V1. Вместо них — общий пул задач с атомарным захватом (§6.4). Раздел «Графики» фильтруется по состоянию работ, а не по объектам человека (§5.12) |
| Сколько автоматов | **Подтягиваются из систем постепенно** | Парк — растущая величина, а не константа. Пикер объекта строится вокруг MRU (§5.5), нигде нет допущения «объектов мало». `part_kind` заполняется с запасом до миграции, чтобы не делать `ALTER TYPE` на каждый новый тип автомата |

Оставшиеся вопросы отсортированы по влиянию на архитектуру. Первые три блокируют проектные решения — ответы нужны до PR 4.

1. **Какие модели автоматов в парке — кофейные, снек, дринк?**
   От модели зависит состав узлов в `part_kind` и реалистичная периодичность. Список из 21 значения составлен по типовому парку. Поскольку автоматы подтягиваются постепенно, важно заложить типы узлов с запасом сразу: добавить значение в enum до первой миграции дёшево, `ALTER TYPE` на живой базе — нет.

2. **Реальная периодичность работ, которую владелец готов подтвердить.**
   Не из мануала производителя, а из практики. Если при запуске все 40 автоматов покажут «просрочено», в график перестанут смотреть на второй день. Нужны хотя бы три числа: мойка миксера (дней), фильтр воды (дней или литров), плановое ТО (месяцев).

3. **Ведутся ли серийные номера узлов и куда девается снятая деталь?**
   Без S/N контроль замен невозможен в принципе: списывается новый узел, ставится восстановленный б/у. Если S/N не ведутся — надо решить, вводим ли обязательное фото шильдика вместо номера.

4. **Есть ли действующая гарантия и сервисные контракты от поставщиков автоматов?**
   Влияет на то, должен ли бот при регистрации замены говорить «этот автомат на гарантии до 12.03.2027, сначала поставщик». Одно поле `warranty_until` в `machine_part` заложено; нужен ли аналог на уровне автомата — вопрос.

5. **Разделение ролей: оператор, техник, инкассатор — совмещают или нет?**
   Матрица прав рассчитана на совмещение (массив ролей). Если совмещений нет, `collector` и `operator` можно не разделять — но лучше знать заранее.

6. **Технический осмотр — что владелец имел в виду?**
   «Техосмотр» в ТЗ — это разовая регуляторная проверка с актом (электробезопасность, санитарный, поверка) или регламентное плановое ТО? Это две разные сущности с разной периодичностью, и они по-разному ложатся в `maintenance_kind`.

7. **Требуется ли журнал санитарной обработки установленной формы?**
   Во многих юрисдикциях форма важнее содержания, и её надо уметь печатать. Если да — нужен экспорт из `maintenance_log` в конкретный бланк. Смежно: есть ли у операторов личные медицинские книжки и кто следит за сроками.

8. **Нужна ли перерегистрация фискальной кассы при перестановке автомата на другую точку, и в какой срок?**
   У нас есть `coffee_machine_placement` с историей перемещений. Если перерегистрация нужна — перемещение автомата должно порождать регуляторную задачу, а не только запись в истории.

9. **Попадают ли товары дринк-автомата под обязательную цифровую маркировку?**
   Если да — меняется вся приёмка и планограмма (сканирование кода). Это отдельный контур, но знать нужно сейчас, чтобы не спроектировать приёмку дважды.

10. **Ручной ввод показаний счётчика: у каких автоматов он реально доступен?**
    Для снек/дринк из OurVend уже приезжает `machine_sale.totalCount` — требовать ручного ввода по ним значит завести два расходящихся числа об одном факте. Для кофейных счётчик на дисплее есть не у всех моделей. Нужен список моделей со счётчиком.

11. **Язык интерфейса бота: только русский или нужен узбекский?**
    Все тексты в этом ТЗ русские. Если нужен узбекский — это не перевод строк, а вынос всех текстов в словарь и переключатель на `person`, что меняет объём PR 1, 3, 5, 8 примерно в полтора раза.

---

## 10. Что осознанно отложено

| Отложено | Обоснование | Когда вернуться |
|---|---|---|
| **Пополнение снек/дринк-автомата из бота** | `machine_slot` — зеркало OurVend: `ingestSlots()` перетирает `quantity` по крону каждые 3 часа, `vending_stock` — центральный склад по имени товара без привязки к автомату. Нужна новая таблица `vending_refill` (журнал факта) и решение владельца, что делать при расхождении «техник доложил 10, OurVend показал +8» | После ответа на вопрос 11 и появления первых расхождений |
| **Маршрут с порядком объезда, `route_stop`, зоны** | `geo_point` у автоматов массово пуст, `task.entityId` только вводится и у всей истории NULL. Без координат «оптимальный маршрут» — это список в случайном порядке с красивым названием. В V1 «мой день» = задачи, сгруппированные по объекту | Когда владелец заполнит координаты и подтвердит фиксированные маршруты |
| **Telegram Mini App и съёмка с камеры** | Требует публичного HTTPS-домена — отмена решения «ноль открытых портов, только Tailscale» (`telegram.ts:1-6`, `docker-compose.yml`). При этом `capture="environment"` — подсказка UA, а не ограничение: на Android обходится, в Telegram Desktop игнорируется | Отдельный проект «выставить панель наружу», не раньше |
| **Геолокация как подтверждение присутствия** | Три причины: координат нет; в подвале ТЦ точность 50–500 м; mock-GPS на Android подделывает её за минуту. Целенаправленный обман ловится сверкой счётчиков и остатков, а не GPS | После заполнения `geo_point` — и то как «фильтр лени», не как доказательство |
| **`notification_outbox`, адресат в `Rule`, ключ с получателем** | Пять новых состояний, аренда, воркеры, `for update skip locked` — при одном инстансе бота в `docker-compose.yml`. Доставка сотруднику через задачи закрывает требование №5 без единой правки контракта уведомлений | Когда понадобится слать сотруднику то, что не является задачей (например, аварию по его объекту) |
| **Чек-листы (шаблон + ответы снимком)** | Каждый пункт = шаг визарда поверх in-memory `Conversations`. Техник в подвале потеряет 12 шагов, а фото-пункт вообще требует существующего `ownerId`. Владелец просил отчёт и фото — их и делаем | После двух-трёх месяцев работы журнала, когда станет видно, каких полей не хватает в `note` |
| **Модельные шаблоны графиков (`scope_kind='model'`)** | Ни одной карточки `equipment_model` для автоматов нет — тип используется в GLOBERENT. Кнопка «применить к списку объектов» (PR 6) даёт то же без трёх колонок и правил наследования | Когда парк вырастет настолько, что массовая правка норматива станет частой |
| **Слияние кофейной мойки в generic-график** | Рабочий контур с ботом, экраном и тестами. Ключ у него `(точка, позиция 1..8)`, а не `(автомат, узел)`. Копия фактов в двух журналах = двойной счёт и разные ответы на «когда мыли» | Отдельной задачей, если владелец захочет один экран вместо двух. Схема этому не мешает |
| **Склад ЗИП с подотчётом, обязательный возврат снятой детали** | В V1 фиксируем сам факт замены и причину. Подотчёт («взял 2 купюроприёмника, поставил 1, второй вернуть») требует складского контура для запчастей поверх `stock_movement` | После ответа на вопрос 4 |
| **Пломбы, разменный фонд, тройная сверка инкассации** | Доменно это метрика №1 в вендинге, но требование владельца — полевой бот, а не переделка инкассации. `collection` уже имеет раздельные `collectedAt`/`receivedAt` под это | Отдельная итерация «деньги», после ответа на вопросы про монеты и фискализацию |
| **Партии, срок годности, дата вскрытия** | `purchase.expiryDate` уже есть, вкладка «Сроки годности» уже есть. Не хватает ровно двух вещей: приёмки от сотрудника с партией и даты вскрытия пачки. Это правка контура приёмки, а не полевого бота | Вместе с итерацией по складу |
| **Списание с причиной и порогом одобрения** | `stock_movement kind='consumption'` существует и работает. Не хватает справочника причин, фото и порога. Одобрение делать через контур `createdFrom: staff:<id>`, а не через `approval` (иначе `auditLog.actorKind` станет врать: `approvals.service.ts` пишет `actorKind: "agent"`) | Вместе с итерацией по складу |
| **Вечерний итог, недельная статистика, «прошу перенести»** | Три новых таймера и новый канал ради мотивации, которую пока нечем наполнить: нужны 2–3 месяца честных данных, иначе первая же сводка будет несправедливой | После трёх месяцев работы журнала |
| **Голосовые отчёты** | `attachment.kind` не примет аудио как `photo`; как `doc` файл ляжет без расширения (`ext ?? ""`) и не откроется по клику; расшифровки нет | Когда появится ASR в контуре ассистента |
| **Персистентность визардов (FSM в Core)** | `Conversations` теряется при рестарте — это зафиксированное проектное решение (`conversation.ts:1-9`). Вынос в Core — отдельная задача с миграцией и своим набором гонок. Митигация в V1: мастера ≤5 шагов, TTL 45 мин, запись создаётся до фото | Если полевая статистика покажет реальные потери от рестартов |
| **Закрепление сотрудников за объектами (`staff_assignment`)** | Владелец подтвердил: все полевые сотрудники работают по всему парку. Таблица «человек × объект», где у каждой пары один и тот же ответ, не описывает реальность, а только создаёт вид управляемости — и требует ручного сопровождения при каждом новом автомате. Кто фактически делал работу, видно из `maintenance_log.person_id`; это факт, а не декларация. Место закрепления занял общий пул с атомарным захватом (§6.4) | Когда людей станет заметно больше и появятся географические зоны либо разделение «этот куст точек — его». Признак, что пора: техники начали договариваться в чате, кто куда едет, вместо того чтобы разбирать пул |
| **Именные графики (`maintenance_plan.assignee_id`) как основной механизм** | Колонка заложена и работает, но по умолчанию `null`. Массово заполнять её сейчас значит воспроизвести закрепление за объектами через чёрный ход | Когда появится работа, которую по факту делает только один конкретный человек (поверка, работа с подрядчиком) |
| **Роли `driver` и `viewer`** | В сети из 12 человек их сегодня нет. Добавляются одной строкой в `STAFF_ROLES` и тремя в `ROLE_PERMISSIONS` | Когда появятся |
| **`GIN`-индекс на `person.roles`** | Ни один запрос не фильтрует по `roles` в SQL — все проверки в JS после загрузки строки. Индекс только замедлил бы запись | Когда появится `GET /people?perm=parts.replace` для массовой адресации |
