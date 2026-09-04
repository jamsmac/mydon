// Формы, которые нужны САМОМУ клиенту (в сигнатурах методов ниже): реэкспорт
// `export type … from …` имени в модуле не заводит, поэтому они ещё и здесь.
import { normalizeMachineSerial, type Domain } from "@mydon/shared";
import type {
  AnalyticsWarning,
  BootstrapSalePriceResult,
  DeadStockReport,
  MarginReport,
  MonthlyPrice,
  OurvendHealth,
  ParityStreak,
  PriceChangesReport,
  PriceGapReport,
  ProductFiscal,
  PurchasePlan as VendingPlan,
  PurchaseSummary as VendingPurchase,
  SetSalePriceResult,
  ShrinkReport,
  WeeklyDigest,
} from "@mydon/shared";

export interface Briefing {
  generatedAt: string;
  tz: string;
  overdueMoney: number;
  idleMachines: number;
  pendingApprovals: number;
  contractsDueSoon: number;
}

export interface ApprovalRow {
  id: string;
  agent: string;
  action: string;
  tier: string;
  /** Данные запроса: карточка сотрудника несёт entityApprove/name/type/byName. */
  payload?: Record<string, unknown>;
  decision: string;
  createdAt: string;
}

export interface EntityRow {
  id: string;
  type: string;
  name: string;
  externalRef: string | null;
  attrs: Record<string, unknown>;
}

/** Сотрудник. tgChatId появляется, когда он нажал «Старт» у бота. */
export interface PersonRow {
  id: string;
  name: string;
  role: string | null;
  /** Роли сотрудника: по ним фильтруется меню и проверяются права. */
  roles?: string[];
  tgUsername: string | null;
  tgChatId: string | null;
  active: string;
}

export interface TaskRow {
  id: string;
  title: string;
  description: string | null;
  ownerKind: "human" | "agent";
  /** null при ownerKind='human' — задача свободна, её разбирают из пула. */
  ownerRef: string | null;
  status: "todo" | "in_progress" | "done" | "cancelled";
  priority: "low" | "normal" | "high" | "urgent";
  due: string | null;
  resultNote: string | null;
  quality: "excellent" | "accepted" | "redo" | null;
  completedAt: string | null;
  /** Кто фактически закрыл: веер приёмки исключает его из адресатов. */
  closedBy: string | null;
  confirmedAt: string | null;
  confirmedBy: string | null;
  assignNotifiedAt: string | null;
  /** По какому объекту работа: автомат, точка, склад. */
  entityId: string | null;
}

/** Строка сводки сроков — то же, что отдаёт Core в /maintenance/due. */
/** Карточка узла с вычисленным состоянием — как её отдаёт Core `/parts` (спека vendhub-parts). */
export interface PartUnitRow {
  id: string;
  partKind: string;
  inventoryNo: string | null;
  labelPending: boolean;
  serialNumber: string | null;
  setNumber: number | null;
  hopperPosition: number | null;
  tareWeight: number | null;
  retiredAt: string | null;
  where: { location: string; machineId: string | null; machineName: string | null; slot: number | null; since: string } | null;
  attention: string[];
  label: string;
  photoCount: number;
}

export interface MaintenanceDueRow {
  planId: string;
  targetId: string;
  targetName: string;
  kind: string;
  kindLabel: string;
  partKind: string | null;
  partLabel: string | null;
  title: string | null;
  nextDueOn: string | null;
  lastDoneOn: string | null;
  taskLeadDays: number;
  daysLeft: number | null;
  countLeft: number | null;
  status: "ok" | "soon" | "due" | "overdue" | "unknown";
  assigneeId: string | null;
  autoTask: boolean;
  /**
   * Автомат в эксплуатации. Необязательное: старый Core поля не отдаёт, и
   * тогда строка считается рабочей — отсутствие признака не повод спрятать
   * от техника весь график.
   */
  operational?: boolean;
  idleReason?: string | null;
}

/**
 * Таймаут загрузки фото. Отдельный от общего: 10 секунд достаточно для JSON,
 * но не для мегабайтного снимка с точки на 3G.
 */
const PHOTO_TIMEOUT_MS = 60_000;

/**
 * Расхождение при пересчёте склада (§5.4): было → стало. delta<0 — недостача
 * (потеря), delta>0 — излишек. value — |delta| × закупочная цена, сум;
 * noPrice — цены нет в прайсе, деньгам тогда доверять нельзя.
 */
export interface VendingStockAdjustment {
  product: string;
  before: number;
  after: number;
  delta: number;
  value: number;
  noPrice: boolean;
}

/** Строка статьи расхода — как её видит бот (Core хранит ещё qty/unitPrice, боту не нужны). */
export interface VendingCashLine {
  label: string;
  amount: number;
}

/** Статья с подытогом — «корзинка», «базар» (может повторяться для разных закупок). */
export interface VendingCashCategory {
  name: string;
  lines: VendingCashLine[];
  subtotal: number;
}

/** Касса закупа (§5.8): получил → статьи → остаток. Снимок, не леджер. */
export interface VendingCashSession {
  id: string;
  receivedAmount: number;
  categories: VendingCashCategory[];
  totalSpent: number;
  remainder: number;
  /** 'own' — обычная запись, 'storno' — отмена (Task 7, R-P6-10). */
  source: string;
  createdBy: string | null;
  createdAt: string;
}

/**
 * Строка прайса для КАРТОЧКИ (П6) — ровно те поля, которые она печатает.
 *
 * Полный тип строки каталога намеренно не дублируется из Core: общим между
 * слоями остаётся фискальный блок `ProductFiscal`.
 */
export interface VendingProductCard {
  id: string;
  name: string;
  category: "drink" | "snack" | "other";
  purchasePrice: number | null;
  salePrice: number | null;
  packSize: number;
  isActive: boolean;
  excludedFromPurchase: boolean;
  fixedPurchaseQty: number | null;
  fiscal: ProductFiscal;
}

/** Правила закупа товара «было»/«стало» — как их отдаёт Core. */
export interface VendingRulesSnapshot {
  packSize?: number;
  excludedFromPurchase?: boolean;
  /** null — фикса нет (обычное округление до блока). */
  fixedPurchaseQty?: number | null;
}

/** Итог правки правил закупа товара (POST /vending/product-rules, П5a). */
export interface SetRulesResult {
  ok: boolean;
  reason?: "not_found";
  /** Каноническое имя товара (после алиасов). */
  product?: string;
  /** Значения ДО правки — бот показывает «было → стало» из ответа Core, а не из команды. */
  before?: VendingRulesSnapshot;
  after?: VendingRulesSnapshot;
}

/** Накладная закупа (материализована при одобрении заявки, §5.7). */
export interface VendingOrder {
  id: string;
  approvalId: string;
  status: "approved" | "ordered" | "received" | "cancelled";
  positions: number;
  totalOrder: number;
  costRounded: number;
  createdBy: string | null;
  createdAt: string;
  /** Момент приёмки; null у непринятых и у принятых до появления колонки. */
  receivedAt?: string | null;
  receivedBy?: string | null;
}

/** Итог правки закупочной цены (POST /vending/product-price). */
export interface SetPriceResult {
  ok: boolean;
  product?: string;
  oldPrice?: number | null;
  newPrice?: number;
  deviationPct?: number;
  reason?: "not_found" | "spike";
}

/**
 * Формы ответов аналитики снека (П5b) — РЕЭКСПОРТ из `@mydon/shared`.
 *
 * Своих объявлений здесь больше нет. Копии этих форм жили в боте и в панели
 * ровно до тех пор, пока их не было в общем пакете, и расходились они молча:
 * тип — не проверка на рантайме, разъехавшееся поле видно только по пустой
 * строке в чате. Теперь форму объявляет тот, кто считает числа
 * (`vending-reports.ts`), а бот и панель её читают — и `pnpm build` падает на
 * первом же несовпадении (N4).
 *
 * Реэкспорт, а не прямой импорт из `@mydon/shared` во всех модулях бота:
 * `core-client` остаётся ЕДИНСТВЕННОЙ дверью к Core — по нему видно, какие
 * формы бот вообще получает по HTTP.
 *
 * Тем же приёмом сюда приехали усушка и план закупа (R-H-6): имена бота
 * сохранены `as`-алиасами (`PurchasePlan as VendingPlan` и остальные), поэтому
 * ни брифинг, ни мастер заливки не правятся — меняется только адрес формы.
 *
 * `VendingPurchase`/`VendingPurchaseItem` — тот же переезд, доведённый до
 * конца. Их рукописные копии пережили R-H-6 и УЖЕ разъехались: `covered`,
 * `surplus`, `extra`, `costExact` у позиции и `totalNeed`, `totalCovered`,
 * `costByPriceFull` у сводки Core отдаёт, а копии о них не знали — притом что
 * `GET /vending/purchase` и `GET /vending/plan` возвращают ОДИН И ТОТ ЖЕ
 * объект (`PurchaseContext.summary`), и по второму маршруту он уже приезжал
 * общей формой. Доказательство расхождения предъявила сама ветка: как только
 * `VendingPlan.summary` стал общим, фикстуре `purchase-plan.test.ts` пришлось
 * дорастить ровно эти семь полей.
 */
export type {
  AnalyticsWarning,
  AnalyticsWarningCode,
  BootstrapSalePriceResult,
  BootstrapSkipReason,
  MonthlyPrice,
  OurvendHealth,
  OurvendSyncRun,
  ParityStreak,
  SetSalePriceResult,
  ShrinkItem,
  ShrinkMachine,
  ShrinkRefillDay,
  ShrinkReport,
  ShrinkSummary,
  ShrinkWarning,
  ShrinkWarningCode,
  AllocationPolicy as VendingAllocationPolicy,
  PurchaseItem as VendingPurchaseItem,
  PurchaseSummary as VendingPurchase,
  PurchasePlan as VendingPlan,
  PlanMachine as VendingPlanMachine,
  SlotPlanRow as VendingPlanSlot,
  PlanWarning as VendingPlanWarning,
  WeeklyDigest,
  WeeklyDigestMachine,
  WeeklyHealth,
} from "@mydon/shared";

/**
 * Хвост «посчитано не всё» у отчётов аналитики.
 *
 * Живёт здесь, а не в общем пакете: `warnings` дописывает HTTP-слой Core
 * поверх чистого отчёта (`analytics.service.ts`), и в самих расчётах
 * `vending-reports.ts` этого поля нет.
 *
 * Поле необязательное намеренно: форматтеры зовут и на данных без него
 * (недельная сводка, фикстуры), а отчёт без предупреждений обязан печататься
 * как раньше, а не падать.
 */
export interface WithWarnings {
  warnings?: AnalyticsWarning[];
}

/** Строка ленты действий сотрудников (GET /registry/actions). */
export interface ActionRow {
  ts: string;
  kind: string;
  label: string;
  personId: string;
  personName: string;
}

export interface PendingNotifications {
  since: string;
  until: string;
  events: number;
  truncated: boolean;
  nextCursor: { occurredAt: string; eventId: string } | null;
  notifications: {
    ruleId: string;
    urgency: string;
    text: string;
    eventId: string;
    occurredAt: string;
  }[];
}

/**
 * Ошибка Core с кодом и телом ответа.
 *
 * Раньше любой не-2xx схлопывался в безликую строку: 401 без ключа доступа,
 * 400 на дробном весе и упавшая сеть выглядели одинаково, и все обработчики
 * честно, но бесполезно советовали «попробуй позже». Код и тело позволяют
 * различать «данные не примут никогда» и «временный сбой».
 */
export class CoreError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    readonly body: string,
  ) {
    super(`Core ответил ${status} на ${path}`);
    this.name = "CoreError";
  }

  /** Ошибка в самих данных или доступе: повтор того же запроса не поможет. */
  get isClientError(): boolean {
    return this.status >= 400 && this.status < 500;
  }
}

/**
 * Текст 4xx для человека — Core уже объяснил, что не так, придумывать своё
 * сообщение незачем (см. `redeemInvite`, откуда этот разбор тела выделен).
 *
 * `null` для всего, что не 4xx (сеть/5xx — там текст ничего не объясняет,
 * повтор уместен) и для тела без `message` — вызывающий сам решает, каким
 * общим текстом это заменить.
 */
export function coreClientErrorMessage(err: unknown): string | null {
  if (!(err instanceof CoreError) || !err.isClientError) return null;
  try {
    const parsed = JSON.parse(err.body) as { message?: string | string[] };
    const msg = Array.isArray(parsed.message) ? parsed.message[0] : parsed.message;
    return msg ?? null;
  } catch {
    return null;
  }
}

/**
 * Выбранная карточка — не автомат.
 *
 * Отдельный класс, а не пустая строка: «карточка не отдалась» и «карточка не
 * того рода» чинятся по-разному (первое — позвать владельца, второе — выбрать
 * другой объект), и мастер обязан сказать оператору, что именно случилось.
 */
export class NotAMachineError extends Error {
  constructor(
    readonly entityId: string,
    readonly type: string,
  ) {
    super(`Карточка ${entityId} — не автомат (${type})`);
    this.name = "NotAMachineError";
  }
}

/** Три вида снек-записи, которые умеет отменять `RecordCancelService` (Core, Task 7). */
export type CancelKind = "refill" | "stock_count" | "cash";

/** Одна отменяемая запись сотрудника — экран бота «Мои записи» (Task 7). */
export interface MyRecordRow {
  kind: CancelKind;
  /** Для stock_count — id ПЕРВОЙ строки ввода (R-P6-11), не строки-товара. */
  id: string;
  createdAt: string;
  /** Готовая русская строка — тот же язык, что у ленты «Действия». */
  label: string;
}

/** Ответ Core на POST /vending/{refills|stock-counts|cash}/:id/cancel. */
export type CancelResult =
  | { ok: true; kind: CancelKind; stornoId: string; label: string; alreadyCancelled: boolean }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "not_yours" }
  | { ok: false; reason: "too_old"; hours: number };

/**
 * Отказ Core в отмене (403/404): `body` — уже РАЗОБРАННОЕ тело ответа
 * (`{reason, hours?, message}`), а не сырая строка, как у `CoreError.body`.
 * Отдельный класс, а не переиспользование `CoreError` как есть: только у
 * этого вызова обработчику бота нужны структурные `reason`/`hours`, а не
 * текст — придумывать общий разбор тела для ВСЕХ ошибок Core не стали.
 */
export class CancelVendingRecordError extends Error {
  constructor(
    readonly status: number,
    readonly body: { reason?: string; hours?: number; message?: string },
  ) {
    super(body.message ?? `Core ответил ${status} на отмену записи`);
    this.name = "CancelVendingRecordError";
  }
}

/** Тонкий клиент к MYDON Core. Бот не ходит в БД напрямую — только через API. */
export class CoreClient {
  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs = 10_000,
    /** Внутренний токен Core: нужен на мутации (approvals, ack, задачи). */
    private readonly serviceToken = "",
    /**
     * «Второй пояс» владельца (R-P5-2). Бот — КАНАЛ владельца, поэтому проставляет
     * его АДРЕСНО: только на системные owner-нотификации (брифинг, рассыльщики
     * напоминаний/приёмок/назначений) и owner-мутации из Telegram, инициированные
     * самим владельцем (approvals decide, invite/revoke/roles). На путях
     * сотрудников НЕ шлётся — эскалации staff→owner нет. Пусто (по умолчанию) →
     * бот шлёт только service-token, поведение РОВНО как сегодня (merge-safe): при
     * выключенном OWNER_IDENTITY_ENFORCED Core owner-токен и не спрашивает.
     */
    private readonly ownerActionToken = "",
  ) {}

  /**
   * Активен ли owner-scope. Пусто → нет. Равенство service-token запрещено ТЕМ
   * ЖЕ инвариантом, что и в Core (`ownerTokenValid`): равный токен Core считает
   * невалидным, слать его бессмысленно — только мусорит заголовок.
   */
  private get ownerScopeActive(): boolean {
    return this.ownerActionToken !== "" && this.ownerActionToken !== this.serviceToken;
  }

  /**
   * `opts.owner` — прикрепить «второй пояс» владельца к ЭТОМУ запросу. Адресно,
   * а не глобально: owner-scope несут только owner-плуминг и owner-мутации, и
   * никогда — staff-инициированные записи (заливки/возвраты/пересчёты).
   */
  private async request<T>(
    path: string,
    init?: RequestInit,
    opts: { owner?: boolean } = {},
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          ...(this.serviceToken ? { "x-service-token": this.serviceToken } : {}),
          ...(opts.owner && this.ownerScopeActive
            ? { "x-owner-action-token": this.ownerActionToken }
            : {}),
          ...(init?.headers ?? {}),
        },
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new CoreError(res.status, path, body.slice(0, 500));
      }
      return (await res.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  briefing(): Promise<Briefing> {
    // Owner-плуминг: брифинг-сводка владельцу. При ужесточении без owner-scope
    // из неё выпали бы личные задачи владельца.
    return this.request<Briefing>("/registry/briefing", undefined, { owner: true });
  }

  /** Лента действий сотрудников: «кто что сделал» за период (даты по Ташкенту). */
  actions(from: string, to: string, personId?: string): Promise<ActionRow[]> {
    const person = personId ? `&person=${personId}` : "";
    return this.request<ActionRow[]>(`/registry/actions?from=${from}&to=${to}${person}`);
  }

  pendingApprovals(): Promise<ApprovalRow[]> {
    // Только owner-контекст: брифинг владельцу и его же запрос «согласования».
    return this.request<ApprovalRow[]>("/approvals/pending", undefined, { owner: true });
  }

  /** Сводный закуп вендинга: что заказать, суммы, что на разбор (§5.4–5.5). */
  vendingPurchase(): Promise<VendingPurchase> {
    return this.request<VendingPurchase>("/vending/purchase");
  }

  /** План закупа: маршрут, что купить, что взять со склада, слоты (П5a). */
  vendingPlan(): Promise<VendingPlan> {
    return this.request<VendingPlan>("/vending/plan");
  }

  /**
   * Усушка автоматов за `days` суток (П4). Отдельный запрос, а не часть плана:
   * план отвечает «что везти», усушка — «куда девается уже привезённое».
   */
  vendingShrinkage(days = 14): Promise<ShrinkReport> {
    return this.request<ShrinkReport>(`/vending/shrinkage?days=${days}`);
  }

  // ── Аналитика снека (П5b): деньги, мёртвый сток, цены, витрина ──
  // Каждый отчёт — отдельный запрос: владелец спрашивает их по одному, а
  // общий «дай всё» гонял бы четыре тяжёлых расчёта ради одной строки в чате.
  // Окна зажимает бот (analytics-brief.ts): Core отвечает на выход за границы
  // отказом 400, а владельцу нужен отчёт, а не разбор кода ошибки.

  /** Маржа по проданному: автомат → товар (R-P5b-3). */
  vendingMargin(days = 30): Promise<MarginReport & WithWarnings> {
    return this.request<MarginReport & WithWarnings>(`/vending/margin?days=${days}`);
  }

  /** Мёртвый сток: что не двигалось за окно — склад и автоматы (R-P5b-4). */
  vendingDeadStock(days = 21): Promise<DeadStockReport & WithWarnings> {
    return this.request<DeadStockReport & WithWarnings>(`/vending/dead-stock?days=${days}`);
  }

  /**
   * Изменения цен: закупочные и витринные (R-P5b-5). `monthly` бот не
   * показывает — помесячная динамика читается только на листе панели, но
   * тип ответа один, и врать о нём клиенту незачем.
   */
  vendingPriceChanges(days = 30): Promise<PriceChangesReport & { monthly: MonthlyPrice[] } & WithWarnings> {
    return this.request<PriceChangesReport & { monthly: MonthlyPrice[] } & WithWarnings>(
      `/vending/price-changes?days=${days}`,
    );
  }

  /** Витрина против эталона владельца: где недобираем (R-P5b-6). */
  vendingPriceGap(days = 14): Promise<PriceGapReport & WithWarnings> {
    return this.request<PriceGapReport & WithWarnings>(`/vending/price-gap?days=${days}`);
  }

  /**
   * Эталон витрины товара (R-P5b-6). Это НЕ закупочная цена
   * (`setVendingPrice`): другая колонка, другой гейт — отклонение считается от
   * факта продаж, и снимается словом «точно».
   */
  setVendingSalePrice(product: string, price: number, confirmed: boolean): Promise<SetSalePriceResult> {
    return this.request<SetSalePriceResult>("/vending/sale-price", {
      method: "POST",
      body: JSON.stringify({ product, price, actor: "owner", confirmed }),
    });
  }

  /** Разовый бутстрап: эталон = факт продаж за окно для товаров без эталона. */
  bootstrapVendingSalePrice(days = 14): Promise<BootstrapSalePriceResult> {
    return this.request<BootstrapSalePriceResult>("/vending/sale-price/bootstrap", {
      method: "POST",
      body: JSON.stringify({ days }),
    });
  }

  /** Недельная сводка (R-P5b-7). Без `week` — предыдущая ISO-неделя по Ташкенту. */
  vendingWeeklyDigest(week?: string): Promise<WeeklyDigest> {
    return this.request<WeeklyDigest>(`/vending/weekly-digest${week ? `?week=${encodeURIComponent(week)}` : ""}`);
  }

  /** Здоровье сбора OurVend: прогоны, серия отказов, лаги, паритет (R-P5b-8). */
  ourvendHealth(runs = 20): Promise<OurvendHealth> {
    return this.request<OurvendHealth>(`/ourvend/health?runs=${runs}`);
  }

  /**
   * Серия зелёных дней паритета ПОФАКТОРНО, по дням (R-P8b-2, R-G-4).
   *
   * Роут отвечает `days[]` — пофакторный разбор 14 дней, которого в здоровье
   * нет и быть не должно. Счёт серии (`parityStreak`, `cutoverThreshold`) и
   * ОБЕ даты (`parityLastRed`, `parityStreakSince`) едут в `/ourvend/health`
   * — второй вызов за ними больше не нужен.
   */
  ourvendParityStreak(): Promise<ParityStreak> {
    return this.request<ParityStreak>("/ourvend/parity/streak");
  }

  // ── Сигналы GLOBERENT для брифинга (перенос PROMACH) ──
  // Берём ровно те поля, что нужны счётчикам briefing.ts, — не полные типы Core.

  /** «К сроку ≤ 7 дней» из финансового свода GLOBERENT. */
  globerentDueSoon(): Promise<{ dueSoonIn: unknown[]; dueSoonOut: unknown[] }> {
    return this.request<{ dueSoonIn: unknown[]; dueSoonOut: unknown[] }>(
      "/finance/summary/globerent",
    );
  }

  /** Договоры купли-продажи: статус, оплата (сум-эквивалент) и провенанс. */
  globerentContracts(): Promise<{ status: string; paidUzs: number; createdFrom: string | null }[]> {
    return this.request<{ status: string; paidUzs: number; createdFrom: string | null }[]>(
      "/contracts?domain=globerent",
    );
  }

  /** Единицы техники: стадия продажи и когда карточку трогали в последний раз. */
  globerentUnits(): Promise<{ salesStage: string | null; updatedAt: string }[]> {
    return this.request<{ salesStage: string | null; updatedAt: string }[]>(
      "/units?domain=globerent",
    );
  }

  /**
   * Записать остатки склада вендинга (инвентаризация, §5.4). Перезапись по
   * товару; `adjustments` — расхождение с предыдущим остатком (недостача при
   * delta<0, излишек при delta>0), пусто — если товар вводится впервые или
   * количество не изменилось.
   */
  setVendingStock(
    items: { product: string; quantity: number }[],
    /** Проводка автора (Task 7, Отклонение №9) — не шлём, если карточка не резолвилась. */
    personId?: string,
  ): Promise<{
    items: number;
    adjustments: VendingStockAdjustment[];
  }> {
    return this.request("/vending/stock", {
      method: "POST",
      body: JSON.stringify({ items, ...(personId ? { personId } : {}) }),
    });
  }

  /**
   * Записать кассу закупа: получил → статьи → остаток (§5.8). Снимок, а не
   * леджер — одна запись на поход на базар.
   */
  recordVendingCash(
    receivedAmount: number,
    categories: { name: string; amount: number }[],
    /** Проводка автора (Task 7, Отклонение №9) — не шлём, если карточка не резолвилась. */
    createdBy?: string,
  ): Promise<VendingCashSession> {
    return this.request<VendingCashSession>("/vending/cash", {
      method: "POST",
      body: JSON.stringify({
        receivedAmount,
        categories: categories.map((c) => ({
          name: c.name,
          lines: [{ label: c.name, amount: c.amount }],
        })),
        ...(createdBy ? { createdBy } : {}),
      }),
    });
  }

  /** Прошлые кассы закупа — свежие сверху (§5.8). */
  vendingCashSessions(): Promise<VendingCashSession[]> {
    return this.request<VendingCashSession[]>("/vending/cash");
  }

  /** Последние отменяемые записи автора — экран бота «Мои записи» (Task 7). */
  myRecords(personId: string, limit?: number): Promise<MyRecordRow[]> {
    const l = limit ? `&limit=${limit}` : "";
    return this.request<MyRecordRow[]>(`/vending/my-records?person=${encodeURIComponent(personId)}${l}`);
  }

  /**
   * Сторно снек-записи (заправка/пересчёт/касса, Task 7, R-P6-10). Права
   * читает Core: 403 несёт причину (`not_yours`/`too_old`) и, для второй,
   * число часов окна — бот называет ЕГО, а не свою константу.
   */
  async cancelVendingRecord(kind: CancelKind, id: string, personId: string): Promise<CancelResult> {
    const path =
      kind === "refill" ? "refills" : kind === "stock_count" ? "stock-counts" : "cash";
    try {
      return await this.request<CancelResult>(`/vending/${path}/${id}/cancel`, {
        method: "POST",
        body: JSON.stringify({ personId }),
      });
    } catch (err) {
      if (err instanceof CoreError && err.isClientError) {
        let body: { reason?: string; hours?: number; message?: string } = {};
        try {
          body = JSON.parse(err.body) as typeof body;
        } catch {
          // Тело не JSON (сеть/прокси) — причину не знаем, статус остаётся.
        }
        throw new CancelVendingRecordError(err.status, body);
      }
      throw err;
    }
  }

  /** Накладные закупа (материализованы при одобрении, §5.7). */
  vendingOrders(limit?: number): Promise<VendingOrder[]> {
    return this.request<VendingOrder[]>(limit === undefined ? "/vending/orders" : `/vending/orders?limit=${limit}`);
  }

  /**
   * Принять накладную на склад: приход += (заказанное − распределено). Пусто
   * orderId → последняя. `distributed` — сколько сразу ушло в автоматы, минуя
   * склад (§5.7); без него весь order идёт на склад, как раньше.
   */
  receiveVendingOrder(
    orderId?: string,
    distributed?: Record<string, number>,
  ): Promise<{
    received: boolean;
    orderId?: string;
    replenished: number;
    units: number;
    distributedUnits: number;
    unmatchedDistribution: string[];
    recordedPurchases?: number;
    reason?: string;
  }> {
    return this.request("/vending/orders/receive", {
      method: "POST",
      body: JSON.stringify({
        ...(orderId ? { orderId } : {}),
        ...(distributed ? { distributed } : {}),
      }),
    });
  }

  /** Правка закупочной цены товара; гейт ±20% снимается confirmed=true. */
  setVendingPrice(product: string, price: number, confirmed: boolean): Promise<SetPriceResult> {
    return this.request("/vending/product-price", {
      method: "POST",
      body: JSON.stringify({ product, price, actor: "owner", confirmed }),
    });
  }

  /**
   * Правила закупа товара (П5a): блок упаковки, «не закупать», фикс-количество.
   * `fixedPurchaseQty: 0` — снять фикс, не «покупать ноль». DTO не принимает
   * посторонние ключи, поэтому шлём ровно то, что он объявляет.
   */
  setVendingProductRules(
    product: string,
    patch: { packSize?: number; excludedFromPurchase?: boolean; fixedPurchaseQty?: number },
  ): Promise<SetRulesResult> {
    return this.request<SetRulesResult>("/vending/product-rules", {
      method: "POST",
      body: JSON.stringify({ product, ...patch, actor: "owner" }),
    });
  }

  /** Отправить закуп на утверждение владельцу (§5.7). */
  submitVendingPurchase(createdBy?: string): Promise<{
    submitted: boolean;
    approvalId?: string;
    positions: number;
    costRounded: number;
    reason?: string;
  }> {
    return this.request("/vending/purchase/submit", {
      method: "POST",
      body: JSON.stringify(createdBy ? { createdBy } : {}),
    });
  }

  decide(id: string, decision: "approved" | "rejected" | "clarify", actor: string) {
    // Owner-мутция. Единственный вызывающий (index.ts) уже за owner-гейтом
    // `isAllowed(chatId) && !asStaff` — решение инициирует верифицированный
    // владелец, поэтому «второй пояс» здесь на месте (OwnerMutationGuard).
    return this.request(
      `/approvals/${id}/decide`,
      {
        method: "POST",
        body: JSON.stringify({ decision, actor }),
      },
      { owner: true },
    );
  }

  /**
   * `opts.owner` — прикрепить «второй пояс» владельца к поиску по реестру.
   * Ставят его ТОЛЬКО owner-only вызовы из handler.ts (поиск владельца через
   * бота): при ужесточении Core режет personal-строки из `/entities`, и без
   * owner-scope владелец терял бы доступ к собственным личным сущностям.
   * Staff-хелперы (`warehouses`/`ingredients`, domain=vendhub) зовут БЕЗ него —
   * эскалации staff→owner нет, а personal их выборки и так не касается.
   */
  searchEntities(
    params: { domain?: Domain; type?: string; q?: string },
    opts: { owner?: boolean } = {},
  ): Promise<EntityRow[]> {
    const qs = new URLSearchParams();
    if (params.domain) qs.set("domain", params.domain);
    if (params.type) qs.set("type", params.type);
    if (params.q) qs.set("q", params.q);
    return this.request<EntityRow[]>(
      `/entities?${qs.toString()}`,
      undefined,
      opts.owner ? { owner: true } : {},
    );
  }

  obligations(domain: Domain): Promise<{
    domain: Domain;
    totals: unknown[];
    overdue: unknown[];
    /** Сколько просрочек всего — список может быть урезан Core. */
    overdueTotal: number;
    /** true — показаны не все: в отчёте это надо оговорить, а не выдавать за полный. */
    overdueTruncated: boolean;
  }> {
    return this.request(`/registry/obligations/${domain}`);
  }

  /** Последние действия из журнала — память помощника («что было»). */
  recent(
    limit = 10,
  ): Promise<
    {
      actorKind: "human" | "agent" | "system";
      action: string;
      actorRef: string | null;
      ts: string;
    }[]
  > {
    return this.request(`/audit?limit=${limit}`);
  }

  /** Уведомления, которые правила сочли срочными, с момента `since` (FR-2). */
  pendingNotifications(
    since: Date,
    page?: {
      until: Date;
      after?: { occurredAt: string; eventId: string };
    },
  ): Promise<PendingNotifications> {
    const query = new URLSearchParams({ immediate: "1", since: since.toISOString() });
    if (page) {
      query.set("until", page.until.toISOString());
      if (page.after) {
        query.set("afterAt", page.after.occurredAt);
        query.set("afterId", page.after.eventId);
      }
    }
    // Owner-плуминг: срочные уведомления доставляются владельцу. Owner-scope
    // сохраняет сигналы личного контура при ужесточении.
    return this.request<PendingNotifications>(`/rules/pending?${query.toString()}`, undefined, {
      owner: true,
    });
  }

  /**
   * Всё недоставленное с момента `since`, включая несрочное.
   *
   * Срочное бот опрашивает раз в минуту с `immediate=1`, а помеченное
   * правилами как `briefing` не забирал НИКТО: такие события копились в Core
   * и не доходили до владельца ни разу. Утренний брифинг — их единственный
   * канал, поэтому здесь фильтра нет: доставленное Core отсечёт сам.
   */
  briefingNotifications(since: Date): Promise<PendingNotifications> {
    // Owner-плуминг: несрочные сигналы для брифинга/недельной сводки владельцу.
    return this.request<PendingNotifications>(
      `/rules/pending?since=${encodeURIComponent(since.toISOString())}`,
      undefined,
      { owner: true },
    );
  }

  /** Отметить уведомления доставленными — после успешной отправки владельцу. */
  ackNotifications(keys: string[]): Promise<{ acked: number }> {
    return this.request<{ acked: number }>("/rules/ack", {
      method: "POST",
      body: JSON.stringify({ keys }),
    });
  }

  /**
   * Событие в общий журнал Core (`POST /events`).
   *
   * Нужно там, где отказ виден только боту, а чинить его должен человек:
   * `console.warn` в контейнере не читает никто (недельная сводка без
   * получателей молчала именно так). Событие переживёт перезапуск, попадёт в
   * ленту и может быть подхвачено правилом.
   */
  recordEvent(type: string, payload: Record<string, unknown> = {}, source = "system"): Promise<{ id?: string }> {
    return this.request<{ id?: string }>("/events", {
      method: "POST",
      body: JSON.stringify({ source, type, payload }),
    });
  }

  // ── Задачи и сотрудники ───────────────────────────────────────────────────
  // Сотрудник работает с задачами прямо в Telegram: ставить ему пароли и учить
  // веб-панели бессмысленно — Telegram у него уже есть и уже открыт.

  /** Привязка по «Старту»: возвращает сотрудника или отметку, что не нашли. */
  linkTelegram(chatId: string, username: string | null): Promise<PersonRow | { linked: false }> {
    return this.request(`/people/link`, {
      method: "POST",
      body: JSON.stringify({ chatId, ...(username ? { username } : {}) }),
    });
  }

  /** Кто написал: сотрудник или посторонний. */
  personByChat(chatId: string): Promise<PersonRow | { found: false }> {
    return this.request(`/people/by-chat/${encodeURIComponent(chatId)}`);
  }

  /** Открытые задачи исполнителя — то, что он видит по команде «мои задачи». */
  myTasks(ownerKind: "human" | "agent", ownerRef: string): Promise<TaskRow[]> {
    const qs = new URLSearchParams({ ownerKind, ownerRef, open: "1" });
    return this.request<TaskRow[]>(`/tasks?${qs.toString()}`);
  }

  task(id: string): Promise<TaskRow> {
    return this.request<TaskRow>(`/tasks/${id}`);
  }

  setTaskStatus(
    id: string,
    status: "todo" | "in_progress" | "done" | "cancelled",
    actor: string,
    resultNote?: string,
  ): Promise<TaskRow> {
    return this.request<TaskRow>(`/tasks/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ status, actor, ...(resultNote ? { resultNote } : {}) }),
    });
  }

  addTaskComment(id: string, body: string, author: string): Promise<unknown> {
    return this.request(`/tasks/${id}/comments`, {
      method: "POST",
      body: JSON.stringify({ body, author }),
    });
  }

  /** Кому пора напомнить (срок близко или прошёл, ещё не напоминали). */
  tasksDueSoon(hours = 24): Promise<TaskRow[]> {
    // Owner-плуминг: рассыльщик напоминаний. Без owner-scope личные задачи
    // владельца выпали бы из окна — напоминания по ним молчали бы.
    return this.request<TaskRow[]>(`/tasks/due-soon?hours=${hours}`, undefined, { owner: true });
  }

  /** Отметка «напомнили» — ставится ПОСЛЕ фактической отправки. */
  markReminded(id: string): Promise<unknown> {
    return this.request(`/tasks/${id}/reminded`, { method: "POST" });
  }

  /** Задачи, о возврате которых исполнителю ещё не сообщили. */
  redoUnnotified(): Promise<TaskRow[]> {
    // Owner-плуминг: рассыльщик переделок. Owner-scope сохраняет личные задачи
    // владельца при ужесточении.
    return this.request<TaskRow[]>("/tasks/redo-unnotified", undefined, { owner: true });
  }

  /** Отметка «о переделке сообщили» — ставится ПОСЛЕ фактической отправки. */
  markRedoNotified(id: string): Promise<unknown> {
    return this.request(`/tasks/${id}/redo-notified`, { method: "POST" });
  }

  /** Задачи, о новом назначении которых исполнителю ещё не сообщили. */
  assignUnnotified(): Promise<TaskRow[]> {
    // Owner-плуминг: рассыльщик назначений. Owner-scope сохраняет личные задачи
    // владельца при ужесточении.
    return this.request<TaskRow[]>("/tasks/assign-unnotified", undefined, { owner: true });
  }

  /** Отметка «о назначении сообщили» — только ПОСЛЕ фактической доставки. */
  markAssignNotified(id: string): Promise<unknown> {
    return this.request(`/tasks/${id}/assign-notified`, { method: "POST" });
  }

  /**
   * Сделанные задачи, которые ещё ждут приёмки менеджером.
   *
   * БЕЗ owner-scope намеренно: единственный потребитель — веер «подтвердите»,
   * который широковещает всем менеджерам (право `tasks.confirm` у staff-роли
   * `manager`). Owner-токен снял бы `excludePersonal` и подмешал бы ЛИЧНЫЕ
   * задачи владельца в staff-выборку — их нельзя разослать staff-менеджерам.
   * Личный контур владельца в приёмку не попадает (R-P5-2, п.3).
   */
  awaitingTasks(): Promise<TaskRow[]> {
    return this.request<TaskRow[]>("/tasks?awaiting=1");
  }

  confirmTask(id: string, actor: string): Promise<TaskRow> {
    return this.request<TaskRow>(`/tasks/${id}/confirm`, {
      method: "POST",
      body: JSON.stringify({ actor }),
    });
  }

  /** Актор обязателен: иначе журнал ошибочно припишет оценку владельцу. */
  rateTask(
    id: string,
    quality: "excellent" | "accepted" | "redo",
    actor: string,
  ): Promise<TaskRow> {
    return this.request<TaskRow>(`/tasks/${id}/quality`, {
      method: "POST",
      body: JSON.stringify({ quality, actor }),
    });
  }

  /** Автоматы направления — для клавиатуры инкассации. */
  /**
   * Автоматы реестра. По умолчанию — ВЕСЬ парк.
   *
   * ЗАЧЕМ НЕ ФИЛЬТРОВАТЬ ПО УМОЛЧАНИЮ. Замена детали, техосмотр и чистка чаще
   * всего и делаются с аппаратом, который стоит в ремонте или на складе:
   * убрать его из выбора значило бы отнять у техника ровно те объекты, ради
   * которых он мастер и открыл. Фильтр включается там, где нерабочий аппарат
   * бессмыслен по сути операции, — например, инкассация: денег в нём нет.
   */
  machines(domain = "vendhub", opts: { operationalOnly?: boolean } = {}): Promise<{ id: string; name: string }[]> {
    return this.request<{ id: string; name: string }[]>(
      `/entities?domain=${domain}&type=machine${opts.operationalOnly ? "&operational=1" : ""}`,
    );
  }

  /**
   * Оператор зафиксировал сбор денег с автомата.
   *
   * `clientKey` генерируется КЛИЕНТОМ — как у заливки (`createRefill` ниже):
   * сгенерируй его сервер, и повтор того же нажатия стал бы новой инкассацией.
   */
  createCollection(
    machineId: string,
    operatorId: string,
    clientKey?: string,
  ): Promise<{ id: string; collectedAt: string }> {
    return this.request<{ id: string; collectedAt: string }>("/collections", {
      method: "POST",
      body: JSON.stringify({ machineId, operatorId, ...(clientKey ? { clientKey } : {}) }),
    });
  }

  people(): Promise<PersonRow[]> {
    return this.request<PersonRow[]>("/people");
  }

  // ── Обслуживание: журнал работ, узлы автоматов ─────────────────────────────

  /**
   * Объекты, где сотрудник работал недавно, — верхний уровень пикера.
   * Закрепления за объектами нет, но маршрут дня повторяется.
   */
  recentObjects(personId: string, limit = 5): Promise<{ id: string; name: string }[]> {
    return this.request(`/maintenance/recent-objects?personId=${personId}&limit=${limit}`);
  }

  /** Записать факт работы. Без outcome — работа начата и не закрыта. */
  createMaintenanceLog(input: {
    entityId: string;
    kind: string;
    partKind?: string;
    /** Норматив, по которому работа сделана: без него срок не сдвинется. */
    planId?: string;
    personId?: string;
    taskId?: string;
    outcome?: "done" | "partial" | "failed";
    note?: string;
    counterValue?: number;
    /** Ключ идемпотентности: повтор того же нажатия несёт то же значение. */
    clientKey?: string;
    createdBy?: string;
  }): Promise<{ id: string }> {
    return this.request("/maintenance/log", { method: "POST", body: JSON.stringify(input) });
  }

  /** Замена узла: закрыть старый период и открыть новый одной транзакцией. */
  swapPart(input: {
    machineId: string;
    partKind: string;
    slot?: number;
    newSerial?: string;
    reason?: string;
    personId?: string;
    note?: string;
    /** Ключ идемпотентности: повтор того же нажатия несёт то же значение. */
    clientKey?: string;
    createdBy?: string;
  }): Promise<{ log: { id: string }; removed: { serialNumber: string | null } | null }> {
    return this.request("/maintenance/part-swap", { method: "POST", body: JSON.stringify(input) });
  }

  /** Узлы автомата: открытые периоды первыми, затем история. */
  machineParts(machineId: string): Promise<
    { id: string; partKind: string; slot: number | null; serialNumber: string | null; removedOn: string | null }[]
  > {
    return this.request(`/maintenance/parts?machineId=${machineId}`);
  }

  /** Узлы вне автоматов: склад, мойка, сушка, ремонт. */
  storageParts(): Promise<
    { id: string; partKind: string; serialNumber: string | null; location: string }[]
  > {
    return this.request("/maintenance/parts/storage");
  }

  /** Установка узла: со склада (partId) или новый. */
  installPart(input: {
    machineId: string;
    partKind: string;
    slot?: number;
    partId?: string;
    serialNumber?: string;
    personId?: string;
    note?: string;
    /** Ключ идемпотентности: повтор того же нажатия несёт то же значение. */
    clientKey?: string;
    createdBy?: string;
  }): Promise<{ log: { id: string }; installed: { serialNumber: string | null } }> {
    return this.request("/maintenance/part-install", { method: "POST", body: JSON.stringify(input) });
  }

  /** Снятие узла: период на автомате закрывается, узел уезжает в мойку/ремонт. */
  removePart(input: {
    machineId: string;
    partKind: string;
    slot?: number;
    toLocation: string;
    personId?: string;
    note?: string;
    /** Ключ идемпотентности: повтор того же нажатия несёт то же значение. */
    clientKey?: string;
    createdBy?: string;
  }): Promise<{ log: { id: string }; removed: { serialNumber: string | null } }> {
    return this.request("/maintenance/part-remove", { method: "POST", body: JSON.stringify(input) });
  }

  // ── Узлы: карточки, очередь, номера (спека vendhub-parts, У1–У3) ──

  /** Очередь внимания к узлам: без номера, наклеить, неизвестно где, без тары, без фото. */
  partsQueue(): Promise<{ counts: Record<string, number>; items: PartUnitRow[] }> {
    return this.request("/parts/queue");
  }

  partUnit(id: string): Promise<PartUnitRow> {
    return this.request(`/parts/${id}`);
  }

  /** Узлы, стоящие на автомате сейчас. */
  partsInstalled(machineId: string): Promise<PartUnitRow[]> {
    return this.request(`/parts/installed?machineId=${machineId}`);
  }

  /** Запасные узлы вида: на складе (по умолчанию) или в указанном месте. */
  partsSpares(kind: string, location?: string): Promise<PartUnitRow[]> {
    return this.request(`/parts/spares?kind=${encodeURIComponent(kind)}${location ? `&location=${location}` : ""}`);
  }

  /** Проставить / подтвердить / исправить номер узла. */
  partSetNumber(
    id: string,
    input: { inventoryNo?: string; confirmLabel?: boolean; actorRef?: string },
  ): Promise<PartUnitRow> {
    return this.request(`/parts/${id}/number`, { method: "POST", body: JSON.stringify(input) });
  }

  /** Что подходит к сроку. Статус считается на чтении, нигде не хранится. */
  maintenanceDue(): Promise<MaintenanceDueRow[]> {
    return this.request("/maintenance/due");
  }

  /** Свободные задачи — общий пул, из которого разбирают работу. */
  unassignedTasks(): Promise<TaskRow[]> {
    return this.request<TaskRow[]>("/tasks?unassigned=1");
  }

  /**
   * Взять свободную задачу. false — успел другой: это не ошибка, а обычное
   * утро при одном дайджесте на всех.
   */
  async claimTask(id: string, personId: string): Promise<boolean> {
    try {
      await this.request(`/tasks/${id}/claim`, {
        method: "POST",
        body: JSON.stringify({ personId }),
      });
      return true;
    } catch (err) {
      // false — ТОЛЬКО настоящий конфликт (Core ответил 409: успел другой).
      // Сеть и таймаут раньше тоже давали false, и сотруднику говорили
      // «взял другой»: он уходил, задача оставалась свободной, работа стояла.
      // Прочие ошибки пробрасываем — выше есть честный «попробуй ещё раз».
      if (err instanceof CoreError && err.status === 409) return false;
      throw err;
    }
  }

  /**
   * Погасить приглашение и привязать Telegram. Ошибка — текст для сотрудника:
   * Core уже объяснил, что не так, и придумывать своё сообщение незачем.
   */
  async redeemInvite(code: string, chatId: string): Promise<PersonRow | { error: string }> {
    try {
      return await this.request<PersonRow>("/people/redeem", {
        method: "POST",
        body: JSON.stringify({ code, chatId }),
      });
    } catch (err) {
      // Обещание «Core уже объяснил, что не так» теперь выполняется буквально:
      // из тела 4xx достаётся message Nest-исключения, а не техническое
      // «Core ответил 400 на /people/redeem», которое никому не помогает.
      const msg = coreClientErrorMessage(err);
      if (msg) return { error: msg };
      return { error: err instanceof Error ? err.message : "Не получилось" };
    }
  }

  /** Выпустить приглашение сотруднику. Код возвращается один раз. */
  issueInvite(
    personId: string,
    roles: string[],
    actor: string,
  ): Promise<{ code: string; expiresAt: string; name: string }> {
    // Owner-мутция (выдача доступа/ролей). Мастер подключения запускается только
    // из owner-гейта index.ts (`isAllowed && !asStaff`) — инициатор всегда
    // верифицированный владелец, поэтому «второй пояс» здесь на месте.
    return this.request(
      `/people/${personId}/invite`,
      {
        method: "POST",
        body: JSON.stringify({ roles, actor }),
      },
      { owner: true },
    );
  }

  /** Отозвать доступ: снять привязку, роли и погасить живые приглашения. */
  revokeAccess(personId: string, actor = "owner"): Promise<PersonRow> {
    // Owner-мутция. Как и invite, вызывается только из owner-гейта index.ts.
    return this.request<PersonRow>(
      `/people/${personId}/revoke`,
      {
        method: "POST",
        body: JSON.stringify({ actor }),
      },
      { owner: true },
    );
  }

  /** Вернуть свою задачу в общий пул. */
  releaseTask(id: string, personId: string): Promise<unknown> {
    return this.request(`/tasks/${id}/release`, {
      method: "POST",
      body: JSON.stringify({ personId }),
    });
  }

  /** Занять ключ одноразовой рассылки: true ровно один раз. */
  async claimNotification(key: string): Promise<boolean> {
    const r = await this.request<{ claimed: boolean }>("/rules/claim", {
      method: "POST",
      body: JSON.stringify({ key }),
    });
    return r.claimed;
  }

  /**
   * Освободить ранее занятый ключ рассылки. Нужно, когда отправка после
   * `claimNotification` сорвалась транзиентно: следующий прогон должен снова
   * занять ключ и переотправить, иначе сообщение теряется навсегда.
   */
  async releaseNotification(key: string): Promise<void> {
    await this.request("/rules/release", {
      method: "POST",
      body: JSON.stringify({ key }),
    });
  }

  /** Заявка на ремонт от сотрудника. Свободная — её разберут из общего пула. */
  /**
   * Перевести автомат в другое состояние (в эксплуатации / склад / ремонт).
   *
   * Core одной транзакцией отменяет висящие задачи обслуживания при уходе из
   * эксплуатации и пересчитывает сроки при возврате — боту об этом знать не
   * надо, но сотруднику последствие нужно назвать.
   */
  setMachineStatus(entityId: string, status: string, actor: string, note?: string): Promise<unknown> {
    return this.request(`/entities/${entityId}/machine-status`, {
      method: "PATCH",
      body: JSON.stringify({ status, actor, ...(note !== undefined ? { note } : {}) }),
    });
  }

  createTask(input: {
    title: string;
    ownerKind: "human" | "agent";
    domain: Domain;
    entityId?: string;
    description?: string;
    priority?: "low" | "normal" | "high" | "urgent";
    /** Ключ идемпотентности: повтор того же нажатия несёт то же значение. */
    clientKey?: string;
    createdBy?: string;
  }): Promise<TaskRow> {
    return this.request<TaskRow>("/tasks", { method: "POST", body: JSON.stringify(input) });
  }

  /**
   * Завести карточку реестра. `createdFrom` заполнен → карточка ляжет
   * черновиком на утверждение владельцу (сотрудник заводит, владелец
   * подтверждает — главное правило MYDON).
   */
  createEntity(input: {
    domain: string;
    type: string;
    name: string;
    attrs?: Record<string, unknown>;
    createdFrom: string;
  }): Promise<{ id: string; name: string }> {
    return this.request<{ id: string; name: string }>("/entities", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  /** Дописать поля карточки (например единицу измерения). */
  updateEntity(id: string, attrs: Record<string, unknown>): Promise<unknown> {
    return this.request(`/entities/${id}`, { method: "PATCH", body: JSON.stringify({ attrs }) });
  }

  /** Склады направления — для клавиатуры инвентаризации. */
  warehouses(domain: Domain = "vendhub"): Promise<EntityRow[]> {
    return this.searchEntities({ domain, type: "warehouse" });
  }

  /** Ингредиенты направления — для выбора при инвентаризации/приходе. */
  ingredients(domain: Domain = "vendhub"): Promise<EntityRow[]> {
    return this.searchEntities({ domain, type: "ingredient" });
  }

  /** Остаток пары «склад × ингредиент» — показать перед вводом факта. */
  stockBalance(
    warehouseId: string,
    ingredientId: string,
  ): Promise<{
    warehouseId: string;
    warehouseName: string;
    ingredientId: string;
    ingredientName: string;
    baseUnit: string | null;
    qty: number | null;
    unconvertible: number;
  }> {
    const qs = new URLSearchParams({ warehouseId, ingredientId });
    return this.request(`/stock/balance?${qs.toString()}`);
  }

  /** Приход сырья: движение на склад. Цена/поставщик — по желанию. */
  addIntake(input: {
    warehouseId: string;
    ingredientId: string;
    qty: number;
    unit: string;
    /** Ключ идемпотентности: повтор того же нажатия несёт то же значение. */
    clientKey?: string;
    createdBy?: string;
    unitPrice?: number;
    supplier?: string;
    note?: string;
  }): Promise<{ id: string }> {
    return this.request("/stock/movement", {
      method: "POST",
      body: JSON.stringify({ kind: "intake", ...input }),
    });
  }

  /**
   * Заливка снек/дринк-автомата: факт плюс списание со склада.
   *
   * `clientKey` обязателен и генерируется КЛИЕНТОМ: в нём весь смысл
   * идемпотентности. Сгенерируй его сервер — повтор того же нажатия стал бы
   * новой записью и списал бы склад второй раз.
   */
  createRefill(input: {
    machineSerial: string;
    machineId?: string;
    coilId?: string;
    productName: string;
    qty: number;
    personId?: string;
    taskId?: string;
    clientKey: string;
    note?: string;
    createdBy?: string;
  }): Promise<{ refill: { id: string }; stockLeft: number | null; duplicate: boolean }> {
    return this.request("/vending/refills", {
      method: "POST",
      body: JSON.stringify({ source: "bot", ...input }),
    });
  }

  /** Товары, стоящие в автомате по зеркалу Ourvend — кнопки мастера заливки. */
  machineProducts(machineSerial: string): Promise<string[]> {
    return this.request(`/vending/machine-products?serial=${encodeURIComponent(machineSerial)}`);
  }

  /**
   * Серийник автомата по карточке реестра.
   *
   * Мастера выбирают ОБЪЕКТ (карточку с именем), а вендинг живёт серийниками
   * Ourvend. Канон обязателен: в реестре лежит и «c2508160376», и
   * «2508160376» — без нормализации половина автоматов не нашла бы ни плана,
   * ни своих товаров (см. machine-serial.ts).
   *
   * Тип карточки проверяем здесь, а не в мастере: `externalRef` есть у складов,
   * помещений и машин сотрудников тоже, и заливка по чужому коду записалась бы
   * молча — с автоматом её потом не связать ничем.
   */
  async machineSerial(entityId: string): Promise<string> {
    const row = await this.request<EntityRow>(`/entities/${encodeURIComponent(entityId)}`);
    if (row.type !== "machine") throw new NotAMachineError(entityId, row.type);
    return normalizeMachineSerial(row.externalRef);
  }

  /**
   * Прайс вендинга — для поиска товара по названию, когда его нет в зеркале.
   * Возврат расширен под карточку (П6). Существующий мастер заливки берёт
   * только `name`/`isActive`, поэтому расширение для него безопасно.
   */
  vendingProducts(): Promise<VendingProductCard[]> {
    return this.request("/vending/products");
  }

  /** Инвентаризация: записать факт пересчёта — сервер сам считает дельту. */
  stocktake(input: {
    warehouseId: string;
    ingredientId: string;
    actual: number;
    unit?: string;
    countedBy?: string;
    /** Ключ идемпотентности: повтор того же нажатия несёт то же значение. */
    clientKey?: string;
    note?: string;
  }): Promise<{
    changed: boolean;
    before: number;
    actual: number;
    delta: number;
    unit: string;
    ingredientName: string;
    warehouseName: string;
    movementId: string | null;
  }> {
    return this.request("/stock/stocktake", { method: "POST", body: JSON.stringify(input) });
  }

  /**
   * Загрузить фото и привязать к записи. Идёт multipart (файл нельзя в JSON),
   * поэтому не через общий request: свой fetch с тем же service-token.
   */
  async uploadPhoto(input: {
    ownerType: string;
    ownerId: string;
    bytes: Buffer;
    mime: string | null;
    filename: string;
    createdBy: string;
    /** В какой момент снято: before | after | plate | counter. */
    stage?: string;
  }): Promise<{ id: string; url: string }> {
    const form = new FormData();
    form.append("ownerType", input.ownerType);
    form.append("ownerId", input.ownerId);
    form.append("kind", "photo");
    form.append("createdBy", input.createdBy);
    if (input.stage) form.append("stage", input.stage);
    const blob = input.mime
      ? new Blob([new Uint8Array(input.bytes)], { type: input.mime })
      : new Blob([new Uint8Array(input.bytes)]);
    form.append("file", blob, input.filename);
    const res = await fetch(`${this.baseUrl}/attachments`, {
      method: "POST",
      // Свой таймаут, а не общий: 10 секунд хватает JSON-запросу, но не
      // мегабайтной фотографии с точки на 3G. По общему таймауту загрузка
      // срывалась бы ровно там, где она особенно нужна.
      signal: AbortSignal.timeout(PHOTO_TIMEOUT_MS),
      headers: this.serviceToken ? { "x-service-token": this.serviceToken } : {},
      body: form,
    });
    if (!res.ok) throw new Error(`Core ответил ${res.status} на /attachments`);
    return (await res.json()) as { id: string; url: string };
  }

  /** Вложения записи: сколько фото «до» и «после» уже приложено к задаче. */
  attachmentsOfOwner(
    ownerType: string,
    ownerId: string,
  ): Promise<{ id: string; kind: string; stage: string | null }[]> {
    return this.request(
      `/attachments?ownerType=${encodeURIComponent(ownerType)}&ownerId=${encodeURIComponent(ownerId)}`,
    );
  }

  // ── Кофе-бункеры: ручные кофемашины, ежедневная заливка/мойка ────────────

  /** Точки с кофемашинами. */
  coffeeLocations(): Promise<{ id: string; name: string; isActive: boolean; operational: boolean }[]> {
    return this.request("/coffee/locations");
  }

  /** Позиция бункера 1–8 → допустимые ингредиенты (для подсказки технику при выборе). */
  coffeeBunkerConfig(): Promise<
    {
      position: number;
      ingredientId: string;
      ingredientName: string;
      packageWeight?: number | null;
      packageLabel?: string | null;
    }[]
  > {
    return this.request("/coffee/bunker-config");
  }

  /** Занести заливку бункера («Ввод данных»). */
  /** Последние заливки — по ним ловим повтор того же бункера в тот же день. */
  recentRefills(limit = 60): Promise<
    {
      id: string;
      locationId: string;
      position: number;
      containerNumber: number | null;
      filledWeight: number;
      enteredDate: string;
    }[]
  > {
    return this.request(`/coffee/refill/recent?limit=${limit}`);
  }

  /** Калибровка тары: вес пустого набора на позиции. Без неё чистый вес не посчитать. */
  coffeeTare(): Promise<{ containerNumber: number; position: number; tareWeight: number | null }[]> {
    return this.request("/coffee/tare");
  }

  submitCoffeeRefill(input: {
    locationId: string;
    position: number;
    containerNumber?: number;
    ingredientId?: string;
    filledWeight: number;
    measuredBefore?: number;
    packageCount?: number | null;
    enteredDate: string;
    createdBy?: string;
  }): Promise<{ id: string }> {
    return this.request("/coffee/refill", { method: "POST", body: JSON.stringify(input) });
  }

  /** Отметить мойку/обслуживание бункера или машины целиком. */
  recordCoffeeWash(input: {
    locationId: string;
    position?: number;
    kind?: "wash" | "clean" | "replace" | "service";
    note?: string;
    performedBy?: string;
  }): Promise<{ id: string }> {
    return this.request("/coffee/wash", { method: "POST", body: JSON.stringify(input) });
  }

  /** Возврат набора: строка «позиция. набор. вес» из привычного формата группы. */
  /**
   * Последние возвраты наборов — бот отсекает по ним пересланные старые списки.
   * Путь ЕДИНСТВЕННОГО числа — как у @Get("container-return") в контроллере:
   * первая версия ходила на несуществующий «container-returns», ловила 404 в
   * .catch(() => null) — и весь барьер молча не работал.
   */
  containerReturns(limit = 300): Promise<
    { position: number; containerNumber: number; weight: number; returnedDate: string }[]
  > {
    return this.request(`/coffee/container-return?limit=${limit}`);
  }

  recordContainerReturn(input: {
    position: number;
    containerNumber: number;
    weight: number;
    returnedDate: string;
    locationNote?: string;
    createdBy?: string;
  }): Promise<{ id: string }> {
    return this.request("/coffee/container-return", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  /** Сводка продаж автоматов — те же цифры, что на дашборде VendHub. */
  salesSummary(): Promise<{
    today: { qty: number; amount: number };
    yesterday: { qty: number; amount: number };
    days30: { qty: number; amount: number };
    lastSaleDt: string | null;
    configured: boolean;
  }> {
    return this.request("/sales/summary");
  }

  /**
   * Кофе-факты для LLM-помощника (порт AssistantCore.coffeeConsumption30d):
   * расход за 30 дней одним объектом — вопросы «сколько кофе ушло?» получают
   * цифры из снимка, а не выдумку.
   */
  async coffeeConsumption30d(): Promise<{
    totalGrams: number;
    totalCost: number | null;
    topLocation: string | null;
  }> {
    const iso = (d: Date) => d.toLocaleDateString("en-CA", { timeZone: "Asia/Tashkent" });
    const fromDate = new Date();
    fromDate.setDate(fromDate.getDate() - 30);
    const rep = await this.coffeeContainerConsumption(iso(fromDate), iso(new Date()));
    return {
      totalGrams: rep.totalGrams,
      totalCost: rep.totalCost,
      topLocation: rep.locations[0]?.locationName ?? null,
    };
  }

  /** Фактический расход по наборам за период (заливка − возврат через тару). */
  coffeeContainerConsumption(
    from: string,
    to: string,
  ): Promise<{
    from: string;
    to: string;
    rows: unknown[];
    locations: {
      locationId: string;
      locationName: string;
      grams: number;
      cost: number | null;
      pairs: number;
      unknownPairs: number;
    }[];
    totalGrams: number;
    totalCost: number | null;
  }> {
    return this.request(`/coffee/container-consumption?from=${from}&to=${to}`);
  }

  /** Расходники точки за день (вода/стаканчики/крышки) — upsert по (точка, дата). */
  recordCoffeeConsumable(input: {
    locationId: string;
    loggedDate: string;
    water?: number;
    cups?: number;
    lids?: number;
    createdBy?: string;
  }): Promise<{ id: string }> {
    return this.request("/coffee/consumables", { method: "POST", body: JSON.stringify(input) });
  }

  /** Последняя запись автора среди заливок/возвратов/расходников («ошибся»). */
  coffeeLastEntry(createdBy: string): Promise<{
    entry: {
      kind: "refill" | "container_return" | "consumable";
      id: string;
      at: string;
      text: string;
    } | null;
  }> {
    return this.request(`/coffee/last-entry?createdBy=${encodeURIComponent(createdBy)}`);
  }

  /**
   * Удалить свою запись журнала (бот «ошибся — исправить»). `personRef` идёт
   * и как actor (в аудит), и как страховка «только свои записи» на стороне Core.
   */
  deleteCoffeeEntry(
    kind: "refill" | "container_return" | "consumable",
    id: string,
    personRef: string,
  ): Promise<{ ok: boolean }> {
    const path =
      kind === "refill"
        ? "refill"
        : kind === "container_return"
          ? "container-return"
          : "consumable";
    const q = `actor=${encodeURIComponent(personRef)}&by=${encodeURIComponent(personRef)}`;
    return this.request(`/coffee/${path}/${id}?${q}`, { method: "DELETE" });
  }

  // ── Кофе-бункеры: чтение для утреннего брифинга (§ мониторинг) ────────────

  /** Недолив по последней заливке каждого (точка, бункер) против эталона. */
  coffeeFillStatus(): Promise<{ status: "ok" | "underfill" | "unknown" }[]> {
    return this.request("/coffee/fill-status");
  }

  /** Сверка факт/ожидание расхода ингредиентов по всем точкам за период. */
  coffeeReconcileAll(
    from: string,
    to: string,
  ): Promise<{ rows: { reconcile: { status: "ok" | "anomaly" | "unknown" } }[] }[]> {
    return this.request(`/coffee/reconcile?from=${from}&to=${to}`);
  }

  /** Планы обслуживания со статусом «пора/не пора». */
  coffeeWashScheduleStatus(): Promise<{ status: "ok" | "overdue" | "unknown" }[]> {
    return this.request("/coffee/wash-schedule");
  }
}
