/**
 * Разбор реестра закупок владельца (таблица, уже прочитанная `parseXlsx`) в
 * нормализованные строки — фундамент среза D (история закупок сырья).
 *
 * ЛОВУШКИ РЕЕСТРА (все найдены на живом файле, разбор — `register-analysis.md`
 * рядом с планом среза; проверка числами: 135 товарных строк, 13 поставщиков,
 * 183 454 462 сум):
 *
 * 1. Поставщик и ИНН стоят ТОЛЬКО у первой строки группы — остальные ячейки
 *    пустые. Без протяжки вниз теряются 28 строк снек-напитков, и итог не
 *    сходится с контрольной суммой. Протяжка идёт по каждой из четырёх колонок
 *    (группа/год/поставщик/ИНН) НЕЗАВИСИМО: группа реестра держится дольше
 *    поставщика — внутри одной группы поставщиков много.
 * 2. Даты прихода в реестре НЕТ. Дата берётся из ТЕКСТА счёта-фактуры
 *    («№ 477 от 17.05.2025»), не нашлась — из даты оплаты, но только
 *    правдоподобной (R-D3, план среза D).
 * 3. Дата оплаты ненадёжна: у части строк она в будущем — счёт от 21.11.2025,
 *    а оплата записана «2026-11-20»: день и месяц совпадают со счётом, год
 *    записан на единицу больше. Это опечатки владельца в самой таблице, а не
 *    ошибка разбора, поэтому дата оплаты принимается, только если она не
 *    позже `today`.
 * 4. В колонке «Дата оплаты» иногда текст вместо даты («25-29 авг») — не
 *    парсится, просто отбрасывается (а не роняет разбор строки).
 * 5. Числа вписаны вручную с пробелами всех видов («239 000», «11 950 000»)
 *    и запятой вместо точки — чистка та же, что в `ingredient-price.ts` для
 *    ручного ввода: другого способа для чисел, которые печатает человек, в
 *    проекте нет, и здесь он не изобретается заново.
 *
 * КОЛОНКИ ФИКСИРОВАНЫ ПО ПОЗИЦИИ, а не по названию заголовка: у группы, года
 * и ИНН заголовка нет вовсе (пустая строка что в тестовой таблице из брифа,
 * что в боевом файле) — искать их по имени невозможно. Остальные заголовки
 * в боевом файле длиннее, чем в примере из брифа («Ед. изм» вместо «Ед»,
 * «Счет-фактура» вместо «Счёт», «Стоимость сум с НДС» вместо «Стоимость») —
 * значит и по ним позиция надёжнее текста. Порядок колонок один и тот же
 * везде: 0 группа, 1 год, 2 поставщик, 3 ИНН, 4 наименование, 5 ед. изм.,
 * 6 кол-во, 7 цена с НДС, 8 стоимость с НДС, 9 счёт-фактура, 10 сумма оплаты
 * (в `RegisterRow` не входит — не часть контракта партии), 11 дата оплаты,
 * 12 примечание.
 */

import { normalizeSourceKey } from "./sources";

/** Нормализованная строка реестра закупок — вход для предложения карточки (Task 2) и импорта партий (Task 3). */
export interface RegisterRow {
  /** Номер строки в файле — часть ключа идемпотентности. Позиция строки в переданной таблице (1-based), считая и пропущенные строки — чтобы номер не сдвигался от того, что часть строк отфильтрована. */
  fileRow: number;
  group: string | null;
  year: number | null;
  supplier: string;
  inn: string | null;
  name: string;
  unit: string | null;
  qty: number | null;
  /** Цена за единицу С НДС — так озаглавлена колонка реестра. */
  priceGross: number | null;
  costGross: number | null;
  invoiceRaw: string | null;
  /** Номер счёта, вытащенный из текста («№ 477 от 17.05.2025» → «477»). */
  invoiceNo: string | null;
  /** Дата из текста счёта, YYYY-MM-DD. */
  invoiceDate: string | null;
  /** Дата оплаты, только если она правдоподобна (не в будущем). */
  payDate: string | null;
  /** Дата прихода по правилу R-D3; null — строку импортировать нельзя. */
  receivedOn: string | null;
  /** Почему receivedOn пуст — для отчёта владельцу. */
  dateProblem: string | null;
  note: string | null;
}

/** Позиции колонок реестра — см. заголовок файла. */
const COL = {
  group: 0,
  year: 1,
  supplier: 2,
  inn: 3,
  name: 4,
  unit: 5,
  qty: 6,
  priceGross: 7,
  costGross: 8,
  invoice: 9,
  // 10 — сумма оплаты, в RegisterRow не входит.
  payDate: 11,
  note: 12,
} as const;

/** Сырое (нетронутое) значение ячейки — "" для отсутствующей колонки. */
function rawCell(row: readonly string[], i: number): string {
  const v = row[i];
  return v === undefined ? "" : v;
}

/**
 * Ячейка пуста? Через `normalizeSourceKey`, а не голый `.trim()`: так пробел
 * любого вида (обычный, неразрывный, узкий неразрывный) даёт то же решение
 * «пусто», что и остальные модули проекта, работающие с ручным вводом.
 */
function isBlankCell(raw: string): boolean {
  return normalizeSourceKey(raw).length === 0;
}

/** Значение ячейки для хранения: трим по границам, пустая строка → null. */
function cellOrNull(row: readonly string[], i: number): string | null {
  const raw = rawCell(row, i).trim();
  return raw.length > 0 ? raw : null;
}

/**
 * Число из ячейки, введённой вручную: пробелы всех видов (включая неразрывный
 * U+00A0 и узкий неразрывный U+202F) и запятая как десятичный разделитель —
 * тот же приём, что в `ingredient-price.ts` (там не экспортирован, поэтому
 * логика повторена, а не переиспользована как функция).
 *
 * Отрицательное число — опечатка ввода, а не отрицательное количество/цена
 * (проектное правило, см. `ingredient-price.ts`): возвращаем null, а не
 * отрицательную величину, которая испортила бы сумму партии.
 */
function parseAmount(raw: string): number | null {
  const s = raw.replace(/[\s\u00A0\u202F]/g, "").replace(",", ".");
  if (s.length === 0 || !/^-?\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

/** Номер счёта + дата из текста счёта-фактуры: «№ 477 от 17.05.2025» → («477», «2025-05-17»). Не распознано — оба null, а не брошенное исключение: реестр пишет чужой рукой, ломать весь разбор из-за одной строки нельзя. */
function parseInvoiceText(raw: string): { no: string | null; date: string | null } {
  const m = /^№?\s*(.+?)\s+от\s+(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(raw);
  if (!m) return { no: null, date: null };
  const [, no, d, mo, y] = m;
  return { no, date: `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}` };
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Дата оплаты правдоподобна, только если формат ровно `YYYY-MM-DD` и она не
 * позже `today`. У части строк реестра год записан на единицу больше, чем в
 * счёте («20.11.2026» при счёте от 21.11.2025) — опечатка владельца в самой
 * таблице; такая дата почти всегда попадёт в будущее относительно `today` и
 * будет отброшена этой же проверкой. Текст вместо даты («25-29 авг») не
 * матчит формат и тоже отбрасывается — без исключений и без попытки его
 * разобрать как диапазон.
 */
function plausiblePayDate(raw: string, today: string): string | null {
  if (!ISO_DATE_RE.test(raw)) return null;
  return raw <= today ? raw : null;
}

/**
 * Разобрать таблицу реестра закупок ({@link RegisterRow}). `today` — дата
 * прогона (`YYYY-MM-DD`, часовой пояс Asia/Tashkent), относительно которой
 * проверяется правдоподобность даты оплаты (R-D3).
 *
 * Строка без наименования (колонка «Наименование») пропускается целиком —
 * это либо строка-остаток (только сумма оплаты), либо пустая строка-заглушка
 * в хвосте листа, а не товарная позиция.
 */
export function parseRegisterRows(
  table: { columns: string[]; rows: string[][] },
  today: string,
  /**
   * Номер строки ФАЙЛА, которому соответствует `rows[0]`.
   *
   * Считать смещениями оказалось легко ошибиться, поэтому спрашиваем прямо.
   * У живого реестра `parseXlsx` забирает в заголовок первую строку книги —
   * титул «OOO VENDHUB», — значит `rows[0]` это вторая строка файла, и сюда
   * надо передать 2. Тогда первая товарная строка получит `fileRow` 3, как её
   * и видит человек в Excel. Из `fileRow` строится ключ идемпотентности, и по
   * нему же владелец ищет проблемную позицию глазами.
   */
  firstRowNumber = 1,
): RegisterRow[] {
  const out: RegisterRow[] = [];

  // Протяжка вниз — раздельно для каждой из четырёх колонок (ловушка №1).
  let group: string | null = null;
  let year: number | null = null;
  let supplier: string | null = null;
  let inn: string | null = null;

  table.rows.forEach((row, index) => {
    const groupCell = rawCell(row, COL.group);
    if (!isBlankCell(groupCell)) group = groupCell.trim();

    const yearCell = rawCell(row, COL.year);
    if (!isBlankCell(yearCell)) {
      const y = Number(yearCell.trim());
      if (Number.isInteger(y)) year = y;
    }

    const supplierCell = rawCell(row, COL.supplier);
    if (!isBlankCell(supplierCell)) supplier = supplierCell.trim();

    const innCell = rawCell(row, COL.inn);
    if (!isBlankCell(innCell)) inn = innCell.trim();

    const name = cellOrNull(row, COL.name);
    if (name === null) return; // не товарная строка — пропускаем, но протяжка выше уже учла её значения

    // У товарной строки есть количество ИЛИ стоимость. Без этого признака
    // строка заголовков («Наименование товара» в колонке имени) прошла бы как
    // запись: 136 записей вместо 135, 14 поставщиков вместо 13 — проверено на
    // живом файле. `parseXlsx` принимает за заголовок первую строку книги, а в
    // реестре первая строка — титул «OOO VENDHUB», поэтому настоящий заголовок
    // приходит уже как данные.
    const hasQty = parseAmount(rawCell(row, COL.qty)) !== null;
    const hasCost = parseAmount(rawCell(row, COL.costGross)) !== null;
    if (!hasQty && !hasCost) return;

    const invoiceRaw = cellOrNull(row, COL.invoice);
    const { no: invoiceNo, date: invoiceDate } = invoiceRaw !== null ? parseInvoiceText(invoiceRaw) : { no: null, date: null };

    const payDateRaw = cellOrNull(row, COL.payDate);
    const payDate = payDateRaw !== null ? plausiblePayDate(payDateRaw, today) : null;

    const receivedOn = invoiceDate ?? payDate ?? null;
    let dateProblem: string | null = null;
    if (receivedOn === null) {
      dateProblem =
        payDateRaw !== null
          ? "дата оплаты есть, но не похожа на настоящую (в будущем или не формат даты) — дата прихода неизвестна"
          : "нет даты прихода: ни счёта-фактуры с датой, ни правдоподобной даты оплаты";
    }

    out.push({
      fileRow: index + firstRowNumber,
      group,
      year,
      supplier: supplier ?? "",
      inn,
      name,
      unit: cellOrNull(row, COL.unit),
      qty: parseAmount(rawCell(row, COL.qty)),
      priceGross: parseAmount(rawCell(row, COL.priceGross)),
      costGross: parseAmount(rawCell(row, COL.costGross)),
      invoiceRaw,
      invoiceNo,
      invoiceDate,
      payDate,
      receivedOn,
      dateProblem,
      note: cellOrNull(row, COL.note),
    });
  });

  return out;
}
