import { normalizeMachineSerial, normalizeProductName } from "@mydon/shared";
import { NotAMachineError, type CoreClient, type PersonRow, type VendingPlan } from "./core-client";
import type { Conversations } from "./conversation";
import { pickObject } from "./machine-picker";
import { cutAt } from "./purchase-plan";
import {
  applyPress,
  NUMPAD_MAX_DIGITS,
  numpadKeyboard,
  numpadText,
  parseNumpadCallback,
  type NumpadPress,
} from "./numpad";
import type { StaffReply } from "./staff";

/**
 * Заливка снек/дринк-автомата прямо в Telegram (WAREHOUSE_SPEC §5.2).
 *
 *   объект → товар → сколько → [ещё товар | готово]
 *
 * Ключевое отличие от остальных мастеров: позиция пишется в Core СРАЗУ, а не
 * копится до «Готово». Техник обходит автомат с 3–6 позициями, и связь в
 * подвале ТЦ отваливается посреди обхода. Копили бы — потеряли бы всё
 * введённое; пишем сразу — теряется максимум текущая позиция.
 *
 * Отсюда же и отмена, которая не отменяет записанное: она заканчивает обход,
 * а не стирает факты. Мастер говорит об этом словами, чтобы техник не решил,
 * будто «Отмена» откатила всё.
 *
 * Кофейные бункеры сюда не входят: у них свой ключ (точка, позиция 1–8) и вес
 * вместо штук — отдельный мастер `coffee-refill.ts`.
 */

/**
 * Имя потока в беседе. Не «refill»-пункт меню кофейной заливки (тот `refill`
 * в меню, а поток у него `coffee-refill`) — здесь снек/дринк: слоты и штуки.
 */
export const REFILL_FLOW = "refill";

export interface RefillDeps {
  core: CoreClient;
  conversations: Conversations;
}

/**
 * Слова, которыми сотрудник начинает заливку автомата.
 *
 * С якорем ^, как у соседних мастеров (см. isCoffeeRefillTrigger): пункт стал
 * живым, и подстрока без якоря делала бы его претендентом на любую фразу, где
 * слово встретилось в середине, — «помыл бункер, потом заполнил автомат» ушло
 * бы в заливку, если бы пункт стоял в реестре выше мойки. Правильный
 * победитель не должен зависеть от порядка пунктов меню.
 */
export function isRefillTrigger(text: string): boolean {
  return /^(заполнил|заправил|загрузил.*автомат|пополнил)/i.test(text.trim());
}

/**
 * Количество: целые штуки. Дробь не принимаем осознанно — половины батончика
 * в слоте не бывает, а «12.5» почти всегда опечатка в «125».
 */
export function parseCount(text: string): number | null {
  const t = text.trim().replace(/\s+/g, "");
  if (!/^\d{1,4}$/.test(t)) return null;
  const n = Number(t);
  return n > 0 ? n : null;
}

/**
 * Ключ идемпотентности позиции.
 *
 * Складывается из id обхода, СЕРИЙНИКА автомата и порядкового номера позиции.
 * Двойное нажатие «Готово» на одной позиции даёт тот же ключ — Core вернёт
 * прежнюю запись и не спишет склад дважды. Законная вторая заливка того же
 * слота идёт следующим номером и проходит как новая.
 *
 * Серийник в ключе — не украшение. Без него заливка на ДРУГОЙ автомат тем же
 * обходом (кнопка пикера из прокрученного вверх чата) выглядела для Core
 * повтором первой: записи нет, склад не списан, а оператор читал «Загрузил по
 * плану» и уезжал. Канон обязателен: «c2508160376» и «2508160376» — один
 * автомат, и повтор по нему обязан ловиться повтором.
 */
export function refillClientKey(runId: string, serial: string, index: number): string {
  return `rf:${runId}:${normalizeMachineSerial(serial)}:${index}`;
}

/** Идентификатор обхода. Время + случайное: два техника на одном автомате. */
export function newRunId(now = Date.now(), rnd = Math.random): string {
  return `${now.toString(36)}${Math.floor(rnd() * 1e6).toString(36)}`;
}

export type RefillCallback =
  | { kind: "product"; name: string }
  | { kind: "more" }
  | { kind: "done" }
  | { kind: "other" }
  /** «✅ Загрузил по плану» — записать весь чек-лист как есть. */
  | { kind: "plan" }
  /** «✏️ Иначе» — тот же автомат, но количество набирает человек. */
  | { kind: "manual" }
  | { kind: "num"; press: NumpadPress }
  | { kind: "cancel" };

/**
 * Строгий разбор нажатия. Имя товара едет в callback_data закодированным:
 * лимит 64 байта, кириллица в UTF-8 занимает по два — поэтому индекс списка,
 * а не имя. Индекс валиден только вместе с сохранённым в визарде списком.
 */
export function parseRefillCallback(data: string): (RefillCallback & { index?: number }) | null {
  if (data === "rf:cancel") return { kind: "cancel" };
  if (data === "rf:more") return { kind: "more" };
  if (data === "rf:done") return { kind: "done" };
  if (data === "rf:other") return { kind: "other" };
  if (data === "rf:plan") return { kind: "plan" };
  if (data === "rf:else") return { kind: "manual" };
  const p = /^rf:p:(\d{1,3})$/.exec(data);
  if (p) return { kind: "product", name: "", index: Number(p[1]) };
  // Нумпад живёт в том же пространстве «rf:» — иначе его отмена («rf:cancel»)
  // разошлась бы с отменой мастера, и на экране было бы две разные «Отмены».
  const press = parseNumpadCallback("rf", data);
  if (press) return { kind: "num", press };
  return null;
}

/** Подсказка, когда ждут кнопку или число, а сотрудник пишет иное. */
export function refillStepHint(step: string): string {
  switch (step) {
    case "object":
      return "Выбери автомат кнопкой или напиши часть названия.";
    case "plan":
      return "Жми «Загрузил по плану», «Иначе» или «Отмена».";
    case "product":
      return "Выбери товар кнопкой или напиши его название.";
    case "count":
      return "Сколько штук загрузил? Ответь числом, например 12.";
    case "more":
      return "Жми «Ещё товар» или «Готово».";
    default:
      return "Продолжай по кнопкам.";
  }
}

/**
 * Клавиатура выбора товара: сначала то, что стоит в этом автомате по зеркалу
 * Ourvend, потом «другой товар». Показывать весь справочник значит заставить
 * техника листать сотню позиций там, где нужны пять.
 */
export function productKeyboard(names: string[]): NonNullable<StaffReply["keyboard"]> {
  return {
    inline_keyboard: [
      // cutAt, а не slice: имя из Ourvend бывает с эмодзи, и половина
      // суррогатной пары в подписи кнопки роняет всё сообщение целиком.
      ...names.slice(0, 20).map((n, i) => [{ text: cutAt(n, 40), callback_data: `rf:p:${i}` }]),
      [{ text: "🔎 Другой товар", callback_data: "rf:other" }],
      [{ text: "✖️ Отмена", callback_data: "rf:cancel" }],
    ],
  };
}

/** Клавиатура после записанной позиции: продолжить обход или закончить. */
export function afterItemKeyboard(): NonNullable<StaffReply["keyboard"]> {
  return {
    inline_keyboard: [
      [{ text: "➕ Ещё товар", callback_data: "rf:more" }],
      [{ text: "✅ Готово", callback_data: "rf:done" }],
    ],
  };
}

/**
 * Строка итога обхода: что записано и сколько осталось на складе.
 *
 * Отрицательный остаток объясняем теми же словами, что и живое сообщение после
 * позиции: итог перечитывают позже и вне контекста, и голое «(на складе −3)»
 * там читается как ошибка данных, а не как известный факт про пересчёт.
 */
export function summaryText(items: { product: string; qty: number; left: number | null }[]): string {
  if (items.length === 0) return "Ничего не записал.";
  const lines = items.map((i) => {
    const склад =
      i.left === null
        ? ""
        : i.left < 0
          ? ` (на складе ${i.left} — склад давно не пересчитывали)`
          : ` (на складе ${i.left})`;
    return `· ${i.product} — ${i.qty} шт.${склад}`;
  });
  return [`Записал ${items.length} ${plural(items.length)}:`, ...lines].join("\n");
}

/** «позицию / позиции / позиций» — иначе бот говорит «записал 3 позицию». */
export function plural(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return "позицию";
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return "позиции";
  return "позиций";
}

/**
 * Текст отмены. Отдельной функцией, потому что формулировка тут важнее кода:
 * техник, нажавший «Отмена» после трёх записанных позиций, должен понять, что
 * они на месте, а не искать их потом в панели.
 */
export function cancelText(recorded: number): string {
  return recorded === 0
    ? "Отменил, ничего не записано."
    : `Обход закончен. Записано ${recorded} ${plural(recorded)} — они сохранены.`;
}

/** Позиция чек-листа: товар и сколько его везём в этот автомат по плану. */
export interface RefillPlanItem {
  product: string;
  qty: number;
}

/**
 * Текст отмены по данным беседы — общий для кнопки «✖️ Отмена» и слова
 * «отмена». Две формулировки на одно действие означали бы, что набравший
 * слово (справка сама его предлагает) считает обход стёртым, а нажавший
 * кнопку — сохранённым.
 */
export function refillCancelText(data: Record<string, unknown>): string {
  return cancelText(readState(data)?.items.length ?? 0);
}

/** Состояние обхода внутри визарда. */
export interface RefillState {
  runId: string;
  machineId: string;
  machineSerial: string;
  machineName: string;
  /** Индекс следующей позиции — он же часть ключа идемпотентности. */
  index: number;
  /** Что уже записано за обход: для итога и для текста отмены. */
  items: { product: string; qty: number; left: number | null }[];
  /** Список товаров зеркала, показанный кнопками: индекс → имя. */
  choices: string[];
  /** Товар текущей позиции, пока ждём количество. */
  pending?: string;
  /**
   * Остаток чек-листа по плану закупа. Уменьшается по мере записи: после
   * сбоя связи посреди списка повтор дописывает ровно то, что не прошло.
   */
  plan?: RefillPlanItem[];
  /** Набранное нумпадом, пока не нажали «Готово». */
  draft?: string;
}

/** Разбор состояния из визарда: данные пришли из памяти, но форму проверяем. */
export function readState(data: Record<string, unknown>): RefillState | null {
  const s = data as Partial<RefillState>;
  if (typeof s.runId !== "string" || typeof s.machineSerial !== "string") return null;
  if (typeof s.index !== "number" || !Array.isArray(s.items) || !Array.isArray(s.choices)) return null;
  return {
    runId: s.runId,
    machineId: typeof s.machineId === "string" ? s.machineId : "",
    machineSerial: s.machineSerial,
    machineName: typeof s.machineName === "string" ? s.machineName : "автомат",
    index: s.index,
    items: s.items as RefillState["items"],
    choices: s.choices as string[],
    pending: typeof s.pending === "string" ? s.pending : undefined,
    plan: Array.isArray(s.plan) ? (s.plan as RefillPlanItem[]).filter(isPlanItem) : [],
    draft: typeof s.draft === "string" ? s.draft : "",
  };
}

/** Позиция плана из памяти: форму проверяем, как и остальное состояние. */
function isPlanItem(x: unknown): x is RefillPlanItem {
  if (typeof x !== "object" || x === null) return false;
  const i = x as Partial<RefillPlanItem>;
  return typeof i.product === "string" && typeof i.qty === "number" && i.qty > 0;
}

/**
 * Записать позицию и вернуть ответ сотруднику.
 *
 * Ошибка Core не роняет обход: техник видит, что позиция не записана, и может
 * повторить её или продолжить. Потерять обход целиком из-за одной сетевой
 * ошибки — худшее, что можно сделать с человеком у открытого автомата.
 */
export async function recordItem(
  state: RefillState,
  qty: number,
  person: PersonRow,
  deps: RefillDeps,
): Promise<{ state: RefillState; reply: StaffReply }> {
  const product = state.pending ?? "";
  try {
    const res = await deps.core.createRefill({
      machineSerial: state.machineSerial,
      machineId: state.machineId || undefined,
      productName: product,
      qty,
      personId: person.id,
      clientKey: refillClientKey(state.runId, state.machineSerial, state.index),
      createdBy: `person:${person.id}`,
    });
    const next: RefillState = {
      ...state,
      index: state.index + 1,
      pending: undefined,
      items: [...state.items, { product, qty, left: res.stockLeft }],
    };
    const left =
      res.stockLeft === null
        ? ""
        : res.stockLeft < 0
          ? `\nНа складе ${res.stockLeft} — склад давно не пересчитывали.`
          : `\nНа складе осталось ${res.stockLeft}.`;
    // «Записал» — утверждение о СПИСАНИИ склада, и при duplicate его не было:
    // позиция с этим ключом уже лежит в Core, а нажатие пришло вторым. Сказать
    // «Записал» значит подтвердить движение, которого не случилось, — а
    // расходится это потом в усушке, через неделю и без следов.
    const текст = res.duplicate
      ? `Уже записано ранее: ${product} — ${qty} шт. Повторно не списываю.${left}`
      : `Записал: ${product} — ${qty} шт.${left}`;
    return { state: next, reply: { text: текст, keyboard: afterItemKeyboard() } };
  } catch (err) {
    // Позиция не записана, индекс не двигаем: повтор пойдёт тем же ключом,
    // и если запись всё-таки прошла на сервере, дубля не будет.
    //
    // Лог обязателен: это единственная мутация мастера, и её сбой не виден
    // нигде, кроме сообщения одному человеку в поле.
    console.error(`[refill] позиция «${product}» не записана:`, err);
    return {
      state,
      // Знак в начале обязателен: кнопки под сбоем и под успехом одинаковые, и
      // техник, листающий чат бегло, отличает их только по первому символу.
      reply: {
        text: `⚠️ Не смог записать «${product}». Попробуй ещё раз или продолжи — записанное сохранено.`,
        keyboard: afterItemKeyboard(),
      },
    };
  }
}

// ── Мастер целиком (П4): план закупа ведёт заливку ──────────────────────────
//
// Мастер начинается не с товара, а с ПЛАНА: Core уже посчитал, сколько чего
// везут в этот автомат (GET /vending/plan), и техник у открытой двери должен
// подтвердить готовый чек-лист, а не набирать шесть чисел заново. Ввод руками
// никуда не делся — он за кнопкой «✏️ Иначе» и нужен ровно тогда, когда факт
// разошёлся с планом.

/**
 * Чтение из Core, которое мастеру нельзя ронять, но нельзя и проглатывать.
 *
 * Полевой мастер обязан продолжить работу при любом сбое чтения — заливка
 * записывается другим запросом. Но «не ответил Core» и «в данных пусто» —
 * РАЗНЫЕ факты, и говорить оператору второе вместо первого значит соврать про
 * его автомат. Флаг `failed` разводит формулировки, лог оставляет след.
 */
async function readSafely<T>(what: string, run: Promise<T>, fallback: T): Promise<{ value: T; failed: boolean }> {
  try {
    return { value: await run, failed: false };
  } catch (err) {
    console.error(`[refill] ${what}:`, err);
    return { value: fallback, failed: true };
  }
}

/** Клавиатура чек-листа: подтвердить план, изменить или выйти. */
export function planKeyboard(): NonNullable<StaffReply["keyboard"]> {
  return {
    inline_keyboard: [
      [{ text: "✅ Загрузил по плану", callback_data: "rf:plan" }],
      [{ text: "✏️ Иначе", callback_data: "rf:else" }],
      [{ text: "✖️ Отмена", callback_data: "rf:cancel" }],
    ],
  };
}

/**
 * Клавиатура после оборванного чек-листа: дописать остаток или закончить.
 *
 * «Дозаписать», а не «Повторить»: повтор звучит как «записать ещё раз» —
 * ровно тот страх дубля, из-за которого техник не нажимает кнопку и уезжает,
 * оставив половину обхода незаписанной. Дубля не будет: ключ у оборвавшейся
 * позиции тот же.
 */
export function planRetryKeyboard(): NonNullable<StaffReply["keyboard"]> {
  return {
    inline_keyboard: [
      [{ text: "🔁 Дозаписать по плану", callback_data: "rf:plan" }],
      [{ text: "✅ Готово", callback_data: "rf:done" }],
    ],
  };
}

/**
 * Чек-лист автомата из плана закупа: товар → сколько везём.
 *
 * Складываем по СЛОТАМ: один товар стоит в двух пружинах, и техник грузит его
 * одной пачкой — две строки «Montella 4» и «Montella 2» он сложил бы в голове
 * сам, а по дороге ошибся. Слоты с нулевой добавкой (полные) в список не идут:
 * чек-лист — это то, что несут в руках, а не карта автомата.
 */
export function planItemsFor(plan: VendingPlan, serial: string): RefillPlanItem[] {
  const canon = normalizeMachineSerial(serial);
  const machine = plan.machines.find((m) => normalizeMachineSerial(m.serial) === canon);
  if (!machine) return [];
  const sums = new Map<string, number>();
  for (const sl of machine.slots) {
    const units = sl.fromPurchase + sl.fromStock;
    if (units <= 0) continue;
    sums.set(sl.product, (sums.get(sl.product) ?? 0) + units);
  }
  return [...sums].map(([product, qty]) => ({ product, qty }));
}

/** Текст чек-листа. Итог штуками — его сверяют с тем, что реально в сумке. */
export function planText(machineName: string, items: readonly RefillPlanItem[]): string {
  const total = items.reduce((sum, i) => sum + i.qty, 0);
  return [
    `🍫 По плану в «${machineName}»:`,
    ...items.map((i) => `• ${i.product} — ${i.qty}`),
    "",
    `Всего ${total} шт. Загрузил всё по плану?`,
  ].join("\n");
}

/** Начало мастера: выбор автомата общим пикером. */
export async function startMachineRefill(
  chatId: number,
  person: PersonRow,
  deps: RefillDeps,
): Promise<StaffReply> {
  // Без runId: обход начинается не здесь, а на выбранном автомате
  // (см. onMachinePicked) — иначе кнопка пикера, нажатая через полчаса,
  // продолжила бы прежний обход чужими ключами.
  deps.conversations.start(chatId, REFILL_FLOW, "object", {});
  return pickObject(person, deps, "🍫 Заполнил автомат. Какой?");
}

/**
 * Автомат выбран: карточка → серийник → план → чек-лист.
 *
 * Плана нет (автомат выпал из расчёта, Core недоступен, серийника не знаем) —
 * мастер не встаёт, а работает как раньше, по зеркалу Ourvend. План здесь
 * ускоряет, но не является условием записи: техник у открытой двери не должен
 * зависеть от того, посчитался ли сегодня закуп.
 *
 * Обход начинается ЗДЕСЬ, а не на шаге выбора: `runId` берётся новый при каждом
 * выборе автомата. Кнопки пикера живут в чате вечно, и нажатая через полчаса
 * старая кнопка другого автомата продолжала бы прежний обход — ключи позиций
 * совпали бы с уже записанными, Core вернул бы повтор, и заливка на второй
 * автомат пропала бы молча.
 */
export async function onMachinePicked(
  chatId: number,
  entityId: string,
  machineName: string,
  deps: RefillDeps,
): Promise<StaffReply> {
  const runId = newRunId();
  // Три исхода, а не два, поэтому не readSafely: серийник есть, карточка не
  // того рода, карточка не отдалась. Второе и третье техник чинит по-разному:
  // выбрать другой объект против позвать владельца.
  let serial = "";
  let неАвтомат = false;
  try {
    serial = await deps.core.machineSerial(entityId);
  } catch (err) {
    неАвтомат = err instanceof NotAMachineError;
    console.error("[refill] серийник автомата:", err);
  }
  if (неАвтомат) {
    deps.conversations.clear(chatId);
    return { text: `«${machineName}» — не автомат, заливку записывать некуда. Выбери автомат.` };
  }
  if (serial === "") {
    // Без серийника заливку писать некуда: Core сшивает её с автоматом именно
    // по нему. Молча предложить товары значило бы собрать ввод в никуда.
    // Формулировка покрывает оба случая — пустой код в карточке и недоступную
    // карточку: техник в поле всё равно чинит их одинаково (зовёт владельца).
    deps.conversations.clear(chatId);
    return {
      text: `У «${machineName}» не удалось узнать код автомата — заливку записать некуда. Скажи владельцу.`,
    };
  }

  const { value: plan, failed: planFailed } = await readSafely<VendingPlan | null>(
    "план закупа",
    deps.core.vendingPlan(),
    null,
  );
  const items = plan === null ? [] : planItemsFor(plan, serial);
  const base: RefillState = {
    runId,
    machineId: entityId,
    machineSerial: serial,
    machineName,
    index: 0,
    items: [],
    choices: items.map((i) => i.product),
    plan: items,
    draft: "",
  };

  if (items.length > 0) {
    saveState(chatId, "plan", base, deps);
    return { text: planText(machineName, items), keyboard: planKeyboard() };
  }

  const { value: mirror, failed: mirrorFailed } = await readSafely("товары автомата", deps.core.machineProducts(serial), [] as string[]);
  const choices = mergeNames(mirror);
  // Три разных причины пустого чек-листа — три разных ответа. Одна фраза на
  // все («плана нет») утверждала бы про данные то, чего мы не знаем.
  const почему = planFailed
    ? "План сейчас не отдался — Core не ответил."
    : "Плана по этому автомату нет.";
  const зеркало = mirrorFailed ? " Товары автомата тоже не отдались — напиши название словом." : "";
  saveState(chatId, "product", { ...base, choices }, deps);
  return {
    text: `${machineName}. ${почему} Выбери товар.${зеркало}`,
    keyboard: productKeyboard(choices),
  };
}

/**
 * Записать весь чек-лист подряд.
 *
 * Останавливаемся на ПЕРВОЙ неудаче и говорим, сколько прошло. Пропустить
 * упавшую позицию и записать следующие было бы хуже всего: обход выглядел бы
 * законченным, а одной позиции в нём не хватало бы — и никто бы этого не
 * заметил до расхождения склада. Индекс упавшей позиции не двигается, поэтому
 * «Дозаписать» идёт тем же ключом и дубля не создаёт.
 */
export async function loadByPlan(
  state: RefillState,
  person: PersonRow,
  deps: RefillDeps,
): Promise<{ state: RefillState; reply: StaffReply }> {
  const plan = state.plan ?? [];
  let cur = state;
  let done = 0;

  for (const item of plan) {
    const res = await recordItem({ ...cur, pending: item.product }, item.qty, person, deps);
    if (res.state.index === cur.index) {
      const stalled: RefillState = { ...cur, plan: plan.slice(done), pending: undefined };
      return {
        state: stalled,
        reply: {
          text:
            `Записано ${done} из ${plan.length}. «${item.product}»: не записано — похоже, связь.\n` +
            "Нажми «🔁 Дозаписать по плану» позже: записанное не задвоится.",
          keyboard: planRetryKeyboard(),
        },
      };
    }
    cur = res.state;
    done += 1;
  }

  const next: RefillState = { ...cur, plan: [] };
  return { state: next, reply: { text: summaryText(next.items), keyboard: afterItemKeyboard() } };
}

/** Нажатие кнопки мастера: чек-лист, товар, нумпад, итог, отмена. */
export async function handleRefillCallback(
  chatId: number,
  cb: RefillCallback & { index?: number },
  person: PersonRow,
  deps: RefillDeps,
): Promise<{ answer: string; message?: StaffReply; edit?: StaffReply }> {
  if (cb.kind === "cancel") {
    // Барьер #149: «Отмена» с чужого устаревшего экрана не гасит текущее дело —
    // слот беседы один, а кнопки живут в чате вечно.
    const current = deps.conversations.get(chatId);
    if (current !== null && current.flow !== REFILL_FLOW) {
      return {
        answer: "Кнопка устарела",
        message: { text: "Эта кнопка от прошлого шага — она уже не действует." },
      };
    }
    const текст = current === null ? cancelText(0) : refillCancelText(current.data);
    deps.conversations.clear(chatId);
    return { answer: "Отменено", message: { text: текст } };
  }

  const conv = deps.conversations.get(chatId);
  if (conv?.flow !== REFILL_FLOW) {
    // Нумпад устаревшего экрана — без «начни заново» в приказном тоне: после
    // успешной записи это звучало бы как приглашение залить второй раз.
    if (cb.kind === "num") {
      return {
        answer: "Экран устарел",
        message: {
          text: "Этот нумпад уже неактуален. Если заливка не записана — начни заново: «заполнил автомат».",
        },
      };
    }
    return {
      answer: "Кнопка устарела",
      message: { text: "Эта кнопка от прошлого шага — она уже не действует." },
    };
  }

  const state = readState(conv.data);
  if (state === null) {
    deps.conversations.clear(chatId);
    return { answer: "Данные потерялись", message: { text: "Что-то потерялось — начни заново." } };
  }

  switch (cb.kind) {
    case "done": {
      deps.conversations.clear(chatId);
      return { answer: "Готово", message: { text: summaryText(state.items) } };
    }

    case "plan": {
      if ((state.plan ?? []).length === 0) {
        return {
          answer: "Плана нет",
          message: { text: "По плану записывать нечего — выбери товар.", keyboard: productKeyboard(state.choices) },
        };
      }
      const res = await loadByPlan(state, person, deps);
      const остаток = (res.state.plan ?? []).length > 0;
      saveState(chatId, остаток ? "plan" : "more", res.state, deps);
      return { answer: остаток ? "Записал часть" : "Записал", message: res.reply };
    }

    case "manual": {
      // К товарам плана добавляем всё, что стоит в автомате: «иначе» чаще
      // всего значит «залил то, чего в плане не было».
      const mirror = await readSafely("товары автомата", deps.core.machineProducts(state.machineSerial), [] as string[]);
      const choices = mergeNames([...(state.plan ?? []).map((i) => i.product), ...mirror.value]);
      saveState(chatId, "product", { ...state, choices }, deps);
      return {
        answer: "Выбор товара",
        message: {
          text: `${state.machineName}. Какой товар?${mirror.failed ? "\nСписок автомата не отдался — покажу только плановое, остальное ищи словом." : ""}`,
          keyboard: productKeyboard(choices),
        },
      };
    }

    case "other": {
      const mirror = await readSafely("товары автомата", deps.core.machineProducts(state.machineSerial), [] as string[]);
      const choices = mergeNames(mirror.value);
      saveState(chatId, "product", { ...state, choices }, deps);
      return {
        answer: "Все товары",
        message: {
          text: mirror.failed
            ? `Список товаров «${state.machineName}» сейчас не отдался. Напиши часть названия — поищу по прайсу.`
            : `Всё, что стоит в «${state.machineName}». Нет нужного — напиши часть названия, поищу по прайсу.`,
          keyboard: productKeyboard(choices),
        },
      };
    }

    case "more": {
      saveState(chatId, "product", state, deps);
      return {
        answer: "Ещё товар",
        message: { text: `${state.machineName}. Какой товар?`, keyboard: productKeyboard(state.choices) },
      };
    }

    case "product": {
      const name = state.choices[cb.index ?? -1];
      if (name === undefined) {
        return {
          answer: "Кнопка устарела",
          message: { text: "Список товаров сменился — выбери заново.", keyboard: productKeyboard(state.choices) },
        };
      }
      const next: RefillState = { ...state, pending: name, draft: "" };
      saveState(chatId, "count", next, deps);
      return { answer: name.slice(0, 60), message: countScreen(next) };
    }

    default:
      return numpadPress(chatId, cb.press, conv.step, state, person, deps);
  }
}

/** Набор количества кнопками. Экран перерисовывается, а не плодится. */
async function numpadPress(
  chatId: number,
  press: NumpadPress,
  step: string,
  state: RefillState,
  person: PersonRow,
  deps: RefillDeps,
): Promise<{ answer: string; message?: StaffReply; edit?: StaffReply }> {
  if (step !== "count" || state.pending === undefined) {
    // «saving» — идёт запись по первому тапу: второй не должен ни писать,
    // ни пугать.
    return { answer: step === "saving" ? "Уже записываю…" : "Не сейчас" };
  }
  const draft = state.draft ?? "";

  if (press.kind === "digit" || press.kind === "erase") {
    const next = applyPress(draft, press);
    if (next === draft) {
      return { answer: press.kind === "digit" ? `Не больше ${NUMPAD_MAX_DIGITS} цифр` : "Пусто" };
    }
    const withDraft: RefillState = { ...state, draft: next };
    saveState(chatId, "count", withDraft, deps);
    return { answer: next === "" ? "—" : next, edit: countScreen(withDraft) };
  }
  if (press.kind !== "done") return { answer: "Не сейчас" };

  const qty = parseCount(draft);
  if (qty === null) return { answer: draft === "" ? "Набери число" : "Столько в слот не влезет" };
  // Двойной тап «Готово»: помечаем «пишу» ДО запроса — повтор увидит шаг
  // saving и не создаст вторую позицию.
  saveState(chatId, "saving", state, deps);
  const res = await recordItem(state, qty, person, deps);
  saveState(chatId, "more", res.state, deps);
  return { answer: String(qty), message: res.reply };
}

/** Количество текстом — тот же путь, что у нумпада: канал ввода не отнимаем. */
export async function handleRefillCount(
  chatId: number,
  text: string,
  person: PersonRow,
  deps: RefillDeps,
): Promise<StaffReply> {
  const conv = deps.conversations.get(chatId);
  const state = conv?.flow === REFILL_FLOW ? readState(conv.data) : null;
  if (conv === null || state === null || conv.step !== "count" || state.pending === undefined) {
    return { text: refillStepHint(conv?.step ?? "") };
  }
  const qty = parseCount(text);
  if (qty === null) {
    return { text: "Не понял число. Сколько штук загрузил? Например 12." };
  }
  const res = await recordItem(state, qty, person, deps);
  saveState(chatId, "more", res.state, deps);
  return res.reply;
}

/**
 * Поиск товара словом: сначала зеркало автомата, потом весь прайс.
 *
 * Прайс нужен именно здесь: техник заливает то, чего в зеркале ещё нет
 * (новинка, замена слота), и без поиска у него оставался бы один выход —
 * не записать заливку вовсе.
 */
export async function handleRefillProductText(
  chatId: number,
  text: string,
  deps: RefillDeps,
): Promise<StaffReply> {
  const conv = deps.conversations.get(chatId);
  const state = conv?.flow === REFILL_FLOW ? readState(conv.data) : null;
  if (state === null) return { text: refillStepHint("product") };

  const q = normalizeProductName(text);
  if (q.length < 2) {
    return { text: "Слишком коротко — напиши хотя бы две буквы.", keyboard: productKeyboard(state.choices) };
  }
  const [mirror, priced] = await Promise.all([
    readSafely("товары автомата", deps.core.machineProducts(state.machineSerial), [] as string[]),
    readSafely("прайс вендинга", deps.core.vendingProducts(), [] as { name: string; isActive: boolean }[]),
  ]);
  // Снятые с прайса позиции в поиск не идут: предложить их значит записать
  // заливку товара, которого в закупе давно нет.
  const активные = priced.value.filter((p) => p.isActive).map((p) => p.name);
  const found = mergeNames(
    [...mirror.value, ...активные].filter((n) => normalizeProductName(n).includes(q)),
  );
  if (found.length === 0) {
    // «Ничего не нашёл» — утверждение о справочнике. Если справочник не
    // отдался, оператор решит, что товара нет, и не запишет заливку вовсе.
    const текст =
      mirror.failed && priced.failed
        ? `Справочник товаров сейчас не отдался — Core не ответил. Попробуй ещё раз через минуту.`
        : `По «${text.trim()}» ничего не нашёл. Напиши иначе или выбери кнопкой.`;
    return { text: текст, keyboard: productKeyboard(state.choices) };
  }
  saveState(chatId, "product", { ...state, choices: found }, deps);
  return { text: `Нашёл ${found.length}:`, keyboard: productKeyboard(found) };
}

/** Экран набора количества. Плановое число — рядом, чтобы не держать в голове. */
function countScreen(state: RefillState): StaffReply {
  const план = (state.plan ?? []).find(
    (i) => normalizeProductName(i.product) === normalizeProductName(state.pending ?? ""),
  );
  const подсказка = план ? ` (по плану ${план.qty})` : "";
  return {
    text: numpadText(`${state.pending ?? "Товар"} — сколько штук загрузил?${подсказка}`, state.draft ?? ""),
    keyboard: numpadKeyboard("rf"),
  };
}

/**
 * Состояние целиком — в беседу. Частичные патчи разъезжаются с readState.
 *
 * Протухшую беседу заводим заново, а не теряем шаг: TTL 45 минут, а техник
 * стоит у автомата, где связь пропадает и покупатели подходят. Всё нужное
 * (автомат, остаток плана, индекс позиции) уже в руках — терять его из-за
 * таймера значит заставить человека начать обход с выбора автомата.
 */
function saveState(chatId: number, step: string, state: RefillState, deps: RefillDeps): void {
  if (deps.conversations.advance(chatId, step, { ...state }) === null) {
    deps.conversations.start(chatId, REFILL_FLOW, step, { ...state });
  }
}

/**
 * Имена без повторов, в порядке появления и не длиннее клавиатуры.
 *
 * Сравнение по канону (`normalizeProductName`), а не по строке: «Coca Cola» из
 * прайса и «Coca  cola» из зеркала — один товар, и две одинаковые на вид
 * кнопки заставили бы техника выбирать между ними наугад.
 */
function mergeNames(names: readonly string[], limit = 20): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const n of names) {
    const key = normalizeProductName(n);
    if (key === "" || seen.has(key)) continue;
    seen.add(key);
    out.push(n);
    if (out.length >= limit) break;
  }
  return out;
}
