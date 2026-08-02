import type { VendingCashSession } from "./core-client";

/**
 * Касса закупа в Telegram (§5.8): владелец пошёл на базар с наличными,
 * вернулся — записывает: получил столько, потратил по статьям столько,
 * остаток такой. Строчная арифметика («47×2090») уже посчитана владельцем
 * от руки на бумаге/в заметках — здесь фиксируются ИТОГИ по статьям, а не
 * каждая позиция: MYDON должен ответить «куда ушли деньги», а не заменить
 * блокнот владельца.
 *
 * Формат команды — тот же приём, что и у ввода склада («склад X 24, Y 12»):
 * «категория сумма» через запятую/перевод строки; первая пара — «получил N».
 */

const RU = (n: number): string => Math.round(n).toLocaleString("ru-RU");

/**
 * Команда начинается «касса закупа», дальше пары. Требуем именно «закупа» —
 * бэйр «касса» слишком общее слово, могло бы столкнуться с будущими фичами.
 * Между словами допускаем пробел ИЛИ дефис («касса-закупа») — оба варианта
 * реалистичны при быстром наборе на телефоне. Граница — lookahead, а не
 * `\b`: в JS-regex `\b` не срабатывает после кириллицы (см. stock-intake.ts).
 */
const PREFIX = /^касса[\s-]+закупа(?=$|[\s:.\-—])[\s:.\-—]*/i;

export interface CashSessionInput {
  receivedAmount: number;
  categories: { name: string; amount: number }[];
}

/**
 * Начинается ли сообщение с «касса закупа» — ЖЁСТКИЙ гейт, отдельный от
 * полного разбора. handler.ts обязан проверять его первым и, если разбор
 * дальше не удался, ответить ошибкой формата, а НЕ пропускать сообщение
 * дальше по цепочке: «касса закупа: получил N» (без статьи) содержит и
 * «получил», и «закуп» — без этого гейта такое сообщение попало бы в
 * isPurchaseReceiveCommand и вызвало бы приёмку накладной вместо кассы
 * (найдено адверсариал-ревью).
 */
export function isCashPrefixed(text: string): boolean {
  return PREFIX.test(text.trim());
}

/** Полная валидная команда кассы: префикс И успешный разбор. Для тестов/справки. */
export function isCashCommand(text: string): boolean {
  return isCashPrefixed(text) && parseCashSession(text) !== null;
}

/**
 * Разбор: РОВНО ОДНА пара «получил N» задаёт полученную сумму, остальные —
 * статьи «имя сумма» (имя обязательно, число без имени ни к чему не
 * относится и пропускается). Число — целое (сумы без дробной части на
 * практике); дробное/отрицательное отбрасывается, как и у ввода склада.
 *
 * Ни повторный «получил», ни безымянное число НЕ перезаписывают уже найденную
 * сумму молча: раньше `label === ""` тоже трактовалось как «получил», и
 * повторное «получил» тихо побеждало последнее — обе ошибки роняли реальную
 * сумму на пол пути без единого сообщения владельцу (найдено
 * адверсариал-ревью). Двусмысленный ввод — весь разбор отклоняется (null),
 * а не догадка о том, что «получил» на самом деле.
 */
export function parseCashSession(raw: string): CashSessionInput | null {
  const body = raw.trim().replace(PREFIX, "");
  let receivedAmount: number | null = null;
  let receivedCount = 0;
  const categories: { name: string; amount: number }[] = [];

  for (const chunk of body.split(/[,;\n]+/)) {
    const part = chunk.trim();
    if (!part) continue;
    const m = /^(.*?)[\s:.\-—=]*(\d+)$/.exec(part);
    if (!m) continue;
    const label = m[1].trim();
    const amount = Number(m[2]);
    if (!Number.isInteger(amount) || amount < 0) continue;

    if (/^получил/i.test(label)) {
      receivedAmount = amount;
      receivedCount += 1;
    } else if (label !== "") {
      categories.push({ name: label, amount });
    }
    // label === "" (число без имени статьи) — непонятно, что это; пропускаем.
  }

  if (receivedCount !== 1 || categories.length === 0) return null;
  return { receivedAmount: receivedAmount!, categories };
}

/** Подтверждение записи кассы: получил / статьи / потрачено / остаток. */
export function formatCashAck(session: VendingCashSession): string {
  const lines = ["💰 Касса закупа", "", `Получил: ${RU(session.receivedAmount)} сум`, ""];
  for (const c of session.categories) lines.push(`• ${c.name}: ${RU(c.subtotal)} сум`);
  lines.push("", `Потрачено: ${RU(session.totalSpent)} сум`, `Остаток: ${RU(session.remainder)} сум`);
  if (session.remainder < 0) {
    lines.push("", "⚠️ Потрачено больше, чем получил — сверь суммы.");
  }
  return lines.join("\n");
}

/**
 * Запрос истории касс закупа: отдельная фраза, не пересекается с накладными.
 * «кассы закупа» (множественное число) — фраза из HELP; раньше регекс её не
 * ловил, и она уходила в parseIntent как обычный «закуп» (найдено
 * адверсариал-ревью). Не пересекается с isCashPrefixed: та требует ЕДИНСТВЕННОЕ
 * «касса» в начале, «кассы» (мн.ч.) под неё не подходит.
 */
export function isCashHistoryQuery(text: string): boolean {
  return /(кассы закупа|истори.*касс|касс.*истори|прошлые кассы)/i.test(text.trim().toLowerCase());
}

/** Список прошлых касс закупа для владельца. */
export function formatCashSessions(sessions: VendingCashSession[]): string {
  if (sessions.length === 0) {
    return "💰 Касс закупа пока нет. Запиши: «касса закупа: получил 2400000, базар 376300».";
  }
  const lines = sessions.slice(0, 10).map((s) => {
    const when = new Date(s.createdAt).toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit" });
    return `• ${when} — получил ${RU(s.receivedAmount)}, потратил ${RU(s.totalSpent)}, остаток ${RU(s.remainder)}`;
  });
  if (sessions.length > 10) lines.push(`…и ещё ${sessions.length - 10}`);
  return ["💰 Кассы закупа:", "", ...lines].join("\n");
}
