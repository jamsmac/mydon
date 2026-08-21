/**
 * Предложение карточки сырья по строке реестра закупок (срез D, задача 2).
 *
 * ЗАЧЕМ. Ни одно из 59 имён реестра не совпадает с именем карточки дословно
 * (см. `register-analysis.md` рядом с планом среза): карточки названы коротко
 * («Кофе», «Сухое молоко»), реестр хранит имя поставщика («Кофе жареный в
 * зёрнах KMS blend 1 (1кг)»). Но у пяти поставщиков в реестре ровно ОДНО
 * наименование, и эти поставщики уже вписаны в `attrs["поставщик"]` карточек
 * сырья — это сильная подсказка, а не гадание.
 *
 * ПОРЯДОК ОСНОВАНИЙ (R-D4, план среза D, не обсуждается):
 *   1. точное совпадение нормализованных имён;
 *   2. поставщик с единственным наименованием в реестре, сверенный с тем же
 *      поставщиком на карточке;
 *   3. ключевое слово из имени карточки, встреченное в имени строки ОДНОЗНАЧНО
 *      (сигнал ровно одной карточки среди всех).
 * Ни одно не сработало — `cardId: null`, и это честный ответ, а не неудача.
 *
 * ПРЕДЛОЖЕНИЕ ≠ ПРИВЯЗКА. Связь создаёт владелец подтверждением (Task 4),
 * функция только объясняет `reason` человеку.
 *
 * ЧЕГО ЗДЕСЬ НЕТ. Нечёткого сравнения, расстояний между строками, «похожести»
 * — тот же запрет, что уже принят в `contractor-name.ts`: молча связать не тот
 * товар значит увести историю закупок на чужую карточку. Снятие окончания
 * прилагательного («лимонный» → «лимон») в ключевом слове — не расстояние
 * Левенштейна и не приближённое сравнение: это фиксированная маленькая таблица
 * окончаний (тот же приём, что `LEGAL_FORMS` в `contractor-name.ts`, только
 * для окончаний слова, а не целых слов целиком) и дальше точное вхождение
 * подстроки — без порога похожести, без метрики расстояния. Нужна она ровно
 * для одного живого случая: карточка «Лимонный чай» должна узнаваться в
 * «...со вкусом лимона», а не только в дословном «лимонный».
 *
 * ТОЛЬКО КАРТОЧКИ СЫРЬЯ (R-D2). Импорт партий (Task 3) отклоняет строку с
 * карточкой другого типа — значит и предлагать здесь можно только
 * `entity(type='ingredient')`, иначе владельцу показали бы предложение,
 * которое исполнить всё равно нельзя.
 */

import { normalizeSourceKey } from "./sources";
import { normalizeContractorName } from "./contractor-name";
import type { RegisterRow } from "./purchase-register";

/** Карточка сырья в минимуме, нужном для предложения. */
export interface CardRef {
  id: string;
  name: string;
  type: string;
  attrs?: Record<string, unknown> | null;
}

export interface Suggestion {
  cardId: string | null;
  /** Почему предложена именно эта карточка — показывается владельцу. */
  reason: string;
  /** "exact" — имена совпали; "supplier" — по поставщику; "keyword" — по слову; null — нет предложения. */
  basis: "exact" | "supplier" | "keyword" | null;
}

const NO_SUGGESTION: Suggestion = {
  cardId: null,
  reason: "Ни одно из правил не дало основания предложить карточку.",
  basis: null,
};

/** Только карточки сырья: другой тип импорт партий (Task 3, R-D2) всё равно отклонит. */
function ingredientCards(cards: readonly CardRef[]): CardRef[] {
  return cards.filter((c) => c.type === "ingredient");
}

/** Основание 1: имена совпадают дословно после нормализации. Несколько карточек с одним и тем же именем — не отгадка, а честное «нет». */
function suggestExact(row: RegisterRow, cards: readonly CardRef[]): Suggestion | null {
  const key = normalizeSourceKey(row.name);
  if (key === "") return null;
  const hits = cards.filter((c) => normalizeSourceKey(c.name) === key);
  if (hits.length !== 1) return null;
  const card = hits[0]!;
  return {
    cardId: card.id,
    basis: "exact",
    reason: `Имя строки «${row.name}» дословно совпадает с именем карточки «${card.name}».`,
  };
}

/**
 * Основание 2: поставщик, который во всём реестре продаёт ровно одно
 * наименование, и он же записан поставщиком на карточке (`attrs["поставщик"]`,
 * сравнение через `normalizeContractorName` — снимает юр. форму и кавышки,
 * без нечёткого сравнения). `rowsOfSameSupplier` собирает вызывающий код —
 * это все строки реестра того же поставщика, что и `row`.
 */
function suggestBySupplier(
  row: RegisterRow,
  cards: readonly CardRef[],
  rowsOfSameSupplier: readonly RegisterRow[],
): Suggestion | null {
  const distinctNames = new Set(rowsOfSameSupplier.map((r) => normalizeSourceKey(r.name)));
  if (distinctNames.size !== 1) return null; // поставщик возит не одно наименование — решает ключевое слово

  const supplierKey = normalizeContractorName(row.supplier);
  if (supplierKey === "") return null;

  const hits = cards.filter((c) => normalizeContractorName(String(c.attrs?.["поставщик"] ?? "")) === supplierKey);
  if (hits.length !== 1) return null;
  const card = hits[0]!;
  return {
    cardId: card.id,
    basis: "supplier",
    reason: `У поставщика «${row.supplier}» в реестре только одно наименование, и он записан поставщиком на карточке «${card.name}».`,
  };
}

/**
 * Окончания русских прилагательных, которые снимаются, чтобы существительное
 * («лимон», «ягода») узнавалось в форме прилагательного карточки («лимонный»,
 * «ягодный»). Фиксированная таблица, не стеммер общего назначения: длинные
 * окончания проверяются раньше коротких, чтобы не отрезать «ный» там, где
 * подходит более длинное «ному»/«ного».
 */
const ADJ_SUFFIXES = ["ного", "ному", "ными", "ний", "ный", "ая", "ое", "ые", "ых", "ым", "ой"] as const;

/** Корень слова для сравнения ключевых слов: снят суффикс из {@link ADJ_SUFFIXES}, если после этого остаётся не меньше 3 букв — иначе слово не трогаем. */
function keywordRoot(word: string): string {
  for (const suf of ADJ_SUFFIXES) {
    if (word.length - suf.length >= 3 && word.endsWith(suf)) {
      return word.slice(0, word.length - suf.length);
    }
  }
  return word;
}

/** Слова имени — только буквы (без цифр: голая цифра смысла ключевого слова не несёт), не короче 3 символов (короче — предлог/союз/огрызок). */
function significantWords(name: string): string[] {
  return normalizeSourceKey(name)
    .split(/[^\p{L}]+/u)
    .filter((w) => w.length >= 3);
}

/** Ключевое слово карточки: корень + слово карточки, из которого он получен (для объяснения владельцу). */
interface CardKeyword {
  root: string;
  cardWord: string;
}

function cardKeywords(card: CardRef): CardKeyword[] {
  const byRoot = new Map<string, string>();
  for (const w of significantWords(card.name)) {
    const root = keywordRoot(w);
    if (!byRoot.has(root)) byRoot.set(root, w);
  }
  return [...byRoot].map(([root, cardWord]) => ({ root, cardWord }));
}

/**
 * Ключевые слова каждой карточки, оставляющие только те корни, что не делят
 * ни с одной другой карточкой — общее слово («чай» у «Лимонный чай» и
 * «Ягодный чай» разом) не может быть ключевым словом ни для одной из них,
 * иначе строка с этим словом стала бы «сигналом» сразу двух карточек.
 */
function distinctiveKeywordsByCard(cards: readonly CardRef[]): Map<string, CardKeyword[]> {
  const perCard = new Map<string, CardKeyword[]>();
  const owners = new Map<string, Set<string>>();
  for (const card of cards) {
    const kws = cardKeywords(card);
    perCard.set(card.id, kws);
    for (const kw of kws) {
      const set = owners.get(kw.root) ?? new Set<string>();
      set.add(card.id);
      owners.set(kw.root, set);
    }
  }
  const result = new Map<string, CardKeyword[]>();
  for (const [id, kws] of perCard) {
    result.set(
      id,
      kws.filter((kw) => (owners.get(kw.root)?.size ?? 0) === 1),
    );
  }
  return result;
}

/**
 * Основание 3: ключевое слово из имени карточки, встреченное в имени строки.
 * Засчитывается, только если сигнал ровно одной карточки: если строка несёт
 * слова-признаки двух разных карточек (или ни одной), предложения нет —
 * тест на этот случай обязателен (см. `batch-import.test.ts`).
 */
function suggestByKeyword(row: RegisterRow, cards: readonly CardRef[]): Suggestion | null {
  const rowWords = significantWords(row.name);
  if (rowWords.length === 0) return null;

  const distinctive = distinctiveKeywordsByCard(cards);
  const hits: { card: CardRef; cardWord: string; rowWord: string }[] = [];

  for (const card of cards) {
    const keywords = distinctive.get(card.id) ?? [];
    for (const kw of keywords) {
      const rowWord = rowWords.find((w) => w.startsWith(kw.root));
      if (rowWord !== undefined) {
        hits.push({ card, cardWord: kw.cardWord, rowWord });
        break; // одной карточке достаточно одного совпавшего слова
      }
    }
  }

  if (hits.length !== 1) return null; // 0 — сигнала нет; 2+ — сигналы двух карточек, предложения нет
  const { card, cardWord, rowWord } = hits[0]!;
  const reason =
    cardWord === rowWord
      ? `В имени строки встречается слово «${cardWord}» из названия карточки «${card.name}», и оно однозначно указывает на неё среди всех карточек сырья.`
      : `В имени строки слово «${rowWord}» соответствует слову «${cardWord}» из названия карточки «${card.name}», и это совпадение однозначно среди всех карточек сырья.`;
  return { cardId: card.id, basis: "keyword", reason };
}

/**
 * Предложить карточку сырья по строке реестра закупок.
 *
 * `rowsOfSameSupplier` — все строки реестра того же поставщика, что и `row`
 * (включая саму `row`); собирает вызывающий код. Пустой массив — законное
 * значение (например, поставщик встречается впервые за пределами выборки) и
 * просто исключает основание «поставщик» из рассмотрения.
 */
export function suggestCard(
  row: RegisterRow,
  cards: readonly CardRef[],
  rowsOfSameSupplier: readonly RegisterRow[],
): Suggestion {
  const pool = ingredientCards(cards);
  if (pool.length === 0) return NO_SUGGESTION;

  return (
    suggestExact(row, pool) ??
    suggestBySupplier(row, pool, rowsOfSameSupplier) ??
    suggestByKeyword(row, pool) ??
    NO_SUGGESTION
  );
}
