import type { SetRulesResult } from "./core-client";

/**
 * Команды правил закупа товара (П5a): владелец правит блок упаковки, снимает
 * товар с закупки и задаёт фикс-количество прямо из чата. До этого правила
 * жили только в сиде — «блок» и «не закупать» правились миграцией, а закуп
 * тем временем считал по умолчанию.
 *
 * Здесь только разбор и оформление; запись и канон имени — в Core
 * (POST /vending/product-rules).
 */

export type RuleCommand =
  | { kind: "exclude"; product: string }
  | { kind: "include"; product: string }
  | { kind: "fixed"; product: string; qty: number }
  | { kind: "pack"; product: string; qty: number };

export const RULE_COMMAND_HINT =
  "Правила закупа: «не закупать <товар>», «закупать <товар>», «фикс <товар> <N>» (или «нет»), «блок <товар> <N>».";

/**
 * Префиксы команд правил. Без `\b` — он не срабатывает после кириллицы.
 * Гейт по началу строки: «что закупать» — вопрос к брифингу, а не правило,
 * и перехватывать его мутацией нельзя.
 */
export function isRuleCommand(text: string): boolean {
  return /^(не\s+закупать|закупать|фикс|блок)(\s|:|$)/i.test(text.trim());
}

/**
 * Имя товара + число в конце. Число — ОДИН токен: пробелы внутри допустимы
 * только как разделители тысяч (группы ровно по 3). Жадное «\d[\d\s]*»
 * склеивало бы числовой хвост имени с количеством: «блок Cola 330 12» дало бы
 * блок 330 012 (тот же разбор, что в parsePriceCommand).
 */
const NUM = /^(.+?)([\s:—=-]+)(\d+(?:[\s\u00a0\u202f]\d{3})*)\s*(?:шт\.?)?\s*[.!]?$/i;

/** Снятие фикс-количества словом. Голый «0» сюда НЕ входит — см. parseRuleCommand. */
const FIXED_OFF = /^(.+?)[\s:—=-]+(нет|снять)\s*[.!]?$/i;

/** Потолки — защита от строки штрихкода, принятой за количество. */
const MAX_PACK = 1000;
const MAX_FIXED = 100_000;

export function parseRuleCommand(text: string): RuleCommand | null {
  const t = text.trim();

  // «не закупать X» проверяем первым: иначе «закупать» съело бы хвост отрицания.
  // Пустое имя после clean («не закупать «»») — отказ, а не запрос в Core:
  // оттуда вернулось бы 400 и безликое «не удалось записать» вместо подсказки.
  const excluded = /^не\s+закупать\s*:?\s*(.+)$/i.exec(t);
  if (excluded) {
    const product = clean(excluded[1]);
    return product ? { kind: "exclude", product } : null;
  }
  const included = /^закупать\s*:?\s*(.+)$/i.exec(t);
  if (included) {
    const product = clean(included[1]);
    return product ? { kind: "include", product } : null;
  }

  const head = /^(фикс|блок)\s*:?\s*(.+)$/i.exec(t);
  if (!head) return null;
  const kind = head[1].toLowerCase() === "фикс" ? "fixed" : "pack";
  const rest = head[2].trim();

  if (kind === "fixed") {
    const off = FIXED_OFF.exec(rest);
    if (off) return { kind, product: clean(off[1]), qty: 0 };
  }

  const n = NUM.exec(rest);
  if (!n) return null;
  // «блок TUC -5»: минус попадал в класс разделителей, и −5 молча становилось
  // 5 — правило в Core уезжало с чужим числом. Минус вплотную к числу — отказ.
  if (/-$/.test(n[2])) return null;
  const qty = Number(n[3].replace(/[\s\u00a0\u202f]+/g, ""));
  const max = kind === "pack" ? MAX_PACK : MAX_FIXED;
  // «фикс TUC 0» — не «снять», а бессмыслица: снятие говорят словом «нет».
  // Числовой ноль здесь чаще опечатка, и молча гасить правило по нему нельзя.
  if (!Number.isInteger(qty) || qty <= 0 || qty > max) return null;
  const product = clean(n[1]);
  if (!product) return null;
  return { kind, product, qty };
}

/** Имя товара как в карточке: без кавычек и висящей пунктуации. */
function clean(s: string): string {
  return s
    .trim()
    .replace(/[«»"']/g, "")
    .replace(/[,;:—-]+$/, "")
    .trim();
}

/**
 * Почему команда правила не разобралась — словами, а не общей подсказкой.
 *
 * «Блок TUC 5000» и «фикс TUC 0» — не опечатки в формате, а понятные
 * намерения, которые парсер отвергает по своим причинам. Одинаковая подсказка
 * на все случаи заставляла владельца гадать, что именно не так (UX#27).
 */
export function ruleCommandHint(text: string): string {
  const t = text.trim();
  const head = /^(фикс|блок)\s*:?\s*(.+)$/i.exec(t);
  if (head) {
    const kind = head[1].toLowerCase() === "фикс" ? "fixed" : "pack";
    const rest = head[2].trim();
    const n = NUM.exec(rest);
    if (n && /-$/.test(n[2])) return "Количество — положительное число. Минус здесь ничего не значит.";
    if (n) {
      const qty = Number(n[3].replace(/[\s\u00a0\u202f]+/g, ""));
      if (kind === "pack" && (qty < 1 || qty > MAX_PACK)) return `Блок — от 1 до ${MAX_PACK} штук.`;
      if (kind === "fixed" && qty === 0) return "Чтобы снять фикс, напиши «фикс <товар> нет».";
      if (kind === "fixed" && qty > MAX_FIXED) return `Фикс-количество — от 1 до ${MAX_FIXED} штук.`;
      if (!clean(n[1])) return "Не понял, какой товар. Формат: «блок <товар> <N>».";
    }
    return kind === "pack"
      ? "Формат: «блок <товар> <N>», например «блок Red Bull 6»."
      : "Формат: «фикс <товар> <N>» или «фикс <товар> нет», например «фикс Snickers 48».";
  }
  if (/^(не\s+закупать|закупать)/i.test(t)) return "Не понял, какой товар. Формат: «не закупать <товар>».";
  return RULE_COMMAND_HINT;
}

/** Значение поля правила словами (для «было → стало»). */
function ruleValue(kind: RuleCommand["kind"], v: SetRulesResult["before"]): string | null {
  if (!v) return null;
  if (kind === "pack") return v.packSize === undefined ? null : `${v.packSize}`;
  if (kind === "fixed") return v.fixedPurchaseQty === undefined ? null : v.fixedPurchaseQty === null ? "нет" : `${v.fixedPurchaseQty}`;
  return v.excludedFromPurchase === undefined ? null : v.excludedFromPurchase ? "не закупаем" : "закупаем";
}

/**
 * Ответ на команду правила — что записали и как это проверить.
 *
 * Показываем «было → стало» из ответа Core, а не то, что просил владелец: он
 * должен видеть РЕЗУЛЬТАТ записи. Отдельный случай — «ничего не изменилось»:
 * прежний ответ на повтор команды звучал как успешная правка, и владелец
 * уходил уверенным, что поменял то, что и так стояло (UX#28).
 */
export function formatRuleResult(cmd: RuleCommand, res: SetRulesResult): string {
  if (!res.ok) {
    return `Товар «${res.product ?? cmd.product}» не найден в прайсе вендинга. Имя должно совпадать с карточкой или алиасом.`;
  }
  const name = res.product ?? cmd.product;
  const было = ruleValue(cmd.kind, res.before);
  const стало = ruleValue(cmd.kind, res.after);
  const подпись =
    cmd.kind === "pack" ? `Блок «${name}»` : cmd.kind === "fixed" ? `Фикс «${name}»` : `Закуп «${name}»`;

  if (было !== null && стало !== null && было === стало) {
    return `${подпись}: ${стало} — уже было так, ничего не изменилось.\n\n«план закупа» — пересчитать.`;
  }
  const переход = было !== null && стало !== null ? `${подпись}: было ${было} → стало ${стало}.` : null;

  const what =
    cmd.kind === "exclude"
      ? `«${name}» убран из закупки — грузим только со склада.`
      : cmd.kind === "include"
        ? `«${name}» снова закупается.`
        : cmd.kind === "fixed"
          ? cmd.qty === 0
            ? `Фикс-количество «${name}» снято — обычное округление до блока.`
            : `«${name}»: при дефиците покупаем ровно ${cmd.qty}.`
          : `Блок «${name}»: ${cmd.qty} шт.`;
  return [what, ...(переход ? [переход] : []), "", "«план закупа» — пересчитать."].join("\n");
}
