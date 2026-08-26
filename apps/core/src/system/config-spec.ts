/**
 * Белый список глобальных тумблеров системы, редактируемых из панели.
 *
 * Здесь — ТОЛЬКО не-секретные настройки активации (мозг/RAG/пауза/бюджет).
 * Секретов (API-ключи, токены) в этом списке нет и быть не должно: они остаются
 * в `.env` (правило ТЗ «ни одного ключа в коде/базе»). Ключ вне списка Core
 * отклоняет — панель не может записать произвольную переменную окружения.
 *
 * Приоритет чтения: значение из базы важнее env, env важнее дефолта. Так правка
 * из панели реально перекрывает то, что задано в окружении контейнера.
 */

export type ConfigKind = "select" | "text" | "number" | "bool";

export interface ConfigSpec {
  key: string;
  label: string;
  kind: ConfigKind;
  /** Для select — допустимые значения. */
  options?: string[];
  placeholder?: string;
  help?: string;
  /** Дефолт, если ни базы, ни env. */
  fallback?: string;
  /** Проверка значения: null — ок, строка — текст ошибки. Пустое всегда ок (= сброс). */
  validate: (v: string) => string | null;
}

const oneOf =
  (opts: string[]) =>
  (v: string): string | null =>
    opts.includes(v) ? null : `допустимо: ${opts.join(", ")}`;

const nonNegNumber = (v: string): string | null => {
  const n = Number(v.replace(",", "."));
  return Number.isFinite(n) && n >= 0 ? null : "нужно неотрицательное число (например 5)";
};

/**
 * Строго положительное число — для ОКОН, а не для порогов.
 *
 * Ноль законен там, где он означает «показывай всё» (порог в процентах или в
 * сумах). У окна в сутках такого смысла нет и быть не может: `DEAD_STOCK_DAYS=0`
 * молча уходит в дефолт 21 (`clamp` в `report-cache.ts`), `COST_WINDOW_DAYS=0` —
 * в единицу (`Math.max(1, …)` в `analytics.service.ts`). Панель при этом
 * говорит «сохранено», а отчёт считается по ДРУГОМУ числу — ровно тот баг,
 * который чинил `readIntSetting`.
 */
const posNumber = (v: string): string | null => {
  const n = Number(v.replace(",", "."));
  return Number.isFinite(n) && n >= 1 ? null : "нужно число от 1 (окно в сутках; ноль не значит «без окна»)";
};

/**
 * Число не ниже пола — для окна РЕТЕНЦИИ, а не для порога тревоги.
 *
 * Пол здесь не про «ноль бессмыслен» (это `posNumber`), а про то, что окно
 * ретенции РЕЖЕТ данные под уже работающими отчётами: `SNAPSHOT_RETENTION_DAYS
 * = 30` панель бы приняла, а мёртвый сток (окно до 180 суток) назавтра считал
 * бы по обрезанной истории и молча показывал другую картину. Число ниже пола —
 * не смелая настройка, а тихая потеря истории, и вернуть её нечем.
 */
const atLeast =
  (min: number, hint: string) =>
  (v: string): string | null => {
    const n = Number(v.replace(",", "."));
    return Number.isFinite(n) && n >= min ? null : hint;
  };

const urlOrEmpty = (v: string): string | null =>
  /^https?:\/\/\S+$/.test(v) ? null : "нужен URL вида http(s)://host:port";

const shortText =
  (max: number) =>
  (v: string): string | null =>
    v.length <= max ? null : `слишком длинно (максимум ${max})`;

/** Пути мозга: подписочные харнессы (HTTP-путь задаётся через LLM_BASE_URL). */
export const LLM_PROVIDERS = ["", "claude-cli", "codex-cli", "gemini-cli"] as const;

export const CONFIG_SPECS: ConfigSpec[] = [
  {
    key: "AGENT_AUTONOMY_MAX",
    label: "Глобальный порог автономии",
    kind: "select",
    options: ["T0", "T1", "T2", "T3", "T4"],
    fallback: "T0",
    help: "Потолок для ВСЕХ агентов. T0 — только предлагают.",
    validate: oneOf(["T0", "T1", "T2", "T3", "T4"]),
  },
  {
    key: "AGENTS_SCHEDULES_PAUSED",
    label: "Расписания на паузе",
    kind: "bool",
    fallback: "1",
    help: "1 — агенты не запускаются по графику; 0 — работают по расписаниям.",
    validate: oneOf(["0", "1"]),
  },
  {
    key: "AGENT_BILLING_MODE",
    label: "Режим бюджета",
    kind: "select",
    options: ["subscription", "metered"],
    fallback: "subscription",
    help: "subscription — метрируемых трат нет, потолок спит. metered — потолок активен.",
    validate: oneOf(["subscription", "metered"]),
  },
  {
    key: "AGENT_DAILY_BUDGET_USD",
    label: "Потолок на агента в день, $",
    kind: "number",
    fallback: "5",
    validate: nonNegNumber,
  },
  {
    key: "AGENT_GLOBAL_BUDGET_USD",
    label: "Общий потолок в день, $",
    kind: "number",
    fallback: "5",
    validate: nonNegNumber,
  },
  {
    key: "LLM_PROVIDER",
    label: "Мозг: подписочный харнесс",
    kind: "select",
    options: [...LLM_PROVIDERS],
    help: "Пусто — LLM-путь спит (детерминированные навыки). Требует CLI в контейнере + авторизацию.",
    validate: oneOf([...LLM_PROVIDERS]),
  },
  {
    key: "LLM_BASE_URL",
    label: "Мозг: HTTP-шлюз (OpenAI-совместимый)",
    kind: "text",
    placeholder: "http://100.x.y.z:port",
    help: "Альтернатива подписке. Держать ТОЛЬКО в Tailscale. Не ключ — endpoint.",
    validate: urlOrEmpty,
  },
  {
    key: "LLM_MODEL",
    label: "Мозг: модель",
    kind: "text",
    placeholder: "например claude-sonnet-4",
    validate: shortText(128),
  },
  {
    key: "LLM_FALLBACK_MODELS",
    label: "Мозг: резервные модели (через запятую)",
    kind: "text",
    placeholder: "model-a, model-b",
    validate: shortText(512),
  },
  {
    key: "EMBED_BASE_URL",
    label: "Память (RAG): шлюз эмбеддингов",
    kind: "text",
    placeholder: "http://100.x.y.z:port",
    help: "Пусто — семантическая память спит. Держать в Tailscale. Не ключ — endpoint.",
    validate: urlOrEmpty,
  },
  {
    key: "EMBED_MODEL",
    label: "Память (RAG): модель эмбеддингов",
    kind: "text",
    placeholder: "text-embedding-3-small",
    validate: shortText(128),
  },
  // ── Вендинг: порядок обхода автоматов при загрузке (П5a, R-P5a-3) ──
  {
    key: "VENDING_ROUTE_ORDER",
    label: "Вендинг: маршрут загрузки (серийники через запятую)",
    kind: "text",
    placeholder: "2508160376,2508160359",
    help: "Первый автомат маршрута получает закуп первым. Пусто — по имени автомата.",
    validate: (v) => (/^\s*\d{6,}(\s*,\s*\d{6,})*\s*$/.test(v) ? null : "серийники (без «c») через запятую, например 2508160376,2508160359"),
  },
  // ── Вендинг: полевой контур (П4) ──
  {
    key: "SHRINK_ALERT_UZS",
    label: "Вендинг: порог усушки автомата, сум (по позиции за период)",
    kind: "number",
    fallback: "30000",
    help: "Донор mydon-stock: 30 000 сум",
    validate: nonNegNumber,
  },
  {
    key: "REFILL_DETECT_MIN_UNITS",
    label: "Вендинг: порог детектора заливки, шт за окно",
    kind: "number",
    fallback: "10",
    validate: nonNegNumber,
  },
  // ── Вендинг: аналитика (П5b) ──
  // Пороги отчётов — решение владельца, а не константа в сервисе (R-P5b-11).
  // Ноль законен У ПОРОГОВ В ПРОЦЕНТАХ: им владелец говорит «показывай всё», и
  // это дешевле, чем правка кода ради одного прогона. У ОКОН В СУТКАХ ноль
  // законным не был никогда — см. `posNumber`.
  {
    key: "DEAD_STOCK_DAYS",
    label: "Вендинг: окно мёртвого стока, дней",
    kind: "number",
    fallback: "21",
    validate: posNumber,
  },
  {
    key: "PRICE_CHANGE_PCT",
    label: "Вендинг: порог изменения цены, %",
    kind: "number",
    fallback: "5",
    validate: nonNegNumber,
  },
  {
    key: "PRICE_GAP_PCT",
    label: "Вендинг: порог разрыва витрины с эталоном, %",
    kind: "number",
    fallback: "5",
    validate: nonNegNumber,
  },
  {
    key: "COST_WINDOW_DAYS",
    label: "Вендинг: окно взвешенной себестоимости, дней",
    kind: "number",
    fallback: "90",
    help: "Донор mydon-stock: 90 дней по принятым накладным",
    validate: posNumber,
  },
  {
    key: "MARGIN_LOW_PCT",
    label: "Вендинг: маржа ниже этого % — тревожная",
    kind: "number",
    fallback: "15",
    validate: nonNegNumber,
  },
  // ── Вендинг: сторож сбора (П8a, R-P8a-6) ──
  {
    key: "SYNC_STALE_HOURS",
    label: "Вендинг: порог застоя сбора OurVend, часов",
    kind: "number",
    fallback: "6",
    help: "Сбор ходит раз в 3 часа: 6 ч = два пропущенных прогона подряд.",
    validate: posNumber,
  },
  // ── Вендинг: катовер учёта OurVend (П8b, R-P8b-3/7) ──
  {
    key: "OURVEND_ACCOUNTING_SOURCE",
    label: "Вендинг: источник учёта OurVend",
    kind: "select",
    options: ["stock", "own"],
    fallback: "stock",
    help:
      "stock — читаем БД mydon-stock (зеркало). own — свой снапшот (агент ourvend:accounting). " +
      "Переключать ПОСЛЕ 7 зелёных дней паритета (бот «сверка» → строка серии). " +
      "Без STOCK_DATABASE_URL значение игнорируется: там own по определению.",
    validate: oneOf(["stock", "own"]),
  },
  {
    key: "CUTOVER_GREEN_DAYS",
    label: "Вендинг: зелёных дней паритета до переключения",
    kind: "number",
    fallback: "7",
    help: "Семь суток подряд без расхождений и по продажам, и по остаткам.",
    validate: posNumber,
  },
  {
    key: "SNAPSHOT_STALE_HOURS",
    label: "Вендинг: порог застоя учётного снапшота, часов",
    kind: "number",
    fallback: "36",
    help:
      "Агент снимает кабинет раз в сутки (08:05). 36 ч = пропущен один съём с запасом; " +
      "на 72 ч учёт встанет молча.",
    validate: posNumber,
  },
  {
    key: "SNAPSHOT_RETENTION_DAYS",
    label: "Вендинг: хранить историю снимков, дней",
    kind: "number",
    fallback: "180",
    help: "Ниже 180 нельзя: столько просит отчёт о мёртвом стоке (DEAD_STOCK_DAYS_MAX).",
    validate: atLeast(90, "нужно не меньше 90 (окна отчётов доходят до 180 суток)"),
  },
  // ── GLOBERENT: комиссия менеджера — у донора PROMACH жили ТРИ формулы,
  // перенесены все три (packages/shared/globerent/commission.ts); какая
  // действует — решает владелец здесь, а не константа кода. ──
  {
    key: "GR_COMMISSION_METHOD",
    label: "GLOBERENT: метод комиссии менеджера",
    kind: "select",
    options: ["flat_bonus", "margin_rate", "tiers"],
    fallback: "flat_bonus",
    help:
      "flat_bonus — % от фактической прибыли (бонус калькулятора, уточнение владельца донору 2026-05-17); " +
      "margin_rate — % от маржи сделки по ставке должности; " +
      "tiers — тиры 0.5–3.5% в зависимости от % маржи.",
    validate: oneOf(["flat_bonus", "margin_rate", "tiers"]),
  },
  {
    key: "GR_COMMISSION_RATE_PCT",
    label: "GLOBERENT: ставка комиссии, % (для flat_bonus и margin_rate)",
    kind: "number",
    fallback: "8",
    help: "flat_bonus донора — 8% от фактической прибыли; для margin_rate — ставка должности.",
    validate: nonNegNumber,
  },
];

const BY_KEY = new Map(CONFIG_SPECS.map((s) => [s.key, s]));

/** Спека тумблера или undefined, если ключ не в белом списке. */
export function specFor(key: string): ConfigSpec | undefined {
  return BY_KEY.get(key);
}

/**
 * Проверка пары ключ/значение перед записью. Ключ вне белого списка → ошибка
 * (нельзя протащить секрет или произвольный env). Пустое значение = сброс к
 * env/дефолту, всегда допустимо.
 */
export function validateConfig(key: string, value: string): string | null {
  const spec = BY_KEY.get(key);
  if (!spec) return `неизвестный ключ «${key}» — вне белого списка настроек`;
  if (value.trim() === "") return null;
  return spec.validate(value.trim());
}

export interface EffectiveItem {
  key: string;
  label: string;
  kind: ConfigKind;
  options?: string[];
  placeholder?: string;
  help?: string;
  value: string;
  /** Откуда взято действующее значение. */
  source: "db" | "env" | "default";
}

/**
 * Действующее значение тумблера: база важнее env, env важнее дефолта. `db` —
 * карта записанных из панели значений; `env` — окружение процесса Core.
 */
export function resolveEffective(
  spec: ConfigSpec,
  db: Record<string, string>,
  env: Record<string, string | undefined>,
): EffectiveItem {
  const dbVal = (db[spec.key] ?? "").trim();
  const envVal = (env[spec.key] ?? "").trim();
  const [value, source]: [string, EffectiveItem["source"]] =
    dbVal !== "" ? [dbVal, "db"] : envVal !== "" ? [envVal, "env"] : [spec.fallback ?? "", "default"];
  return {
    key: spec.key,
    label: spec.label,
    kind: spec.kind,
    ...(spec.options ? { options: spec.options } : {}),
    ...(spec.placeholder ? { placeholder: spec.placeholder } : {}),
    ...(spec.help ? { help: spec.help } : {}),
    value,
    source,
  };
}

/** Все тумблеры с действующими значениями — для панели и для оверлея агентов. */
export function resolveAll(
  db: Record<string, string>,
  env: Record<string, string | undefined>,
): EffectiveItem[] {
  return CONFIG_SPECS.map((s) => resolveEffective(s, db, env));
}
