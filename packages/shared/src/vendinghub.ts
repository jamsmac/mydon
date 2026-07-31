/**
 * Разбор отчёта кабинета VendHub office (vendinghub.uz).
 *
 * Кабинет не отдаёт ни файла, ни JSON-API: это AJAX-оболочка, где каждая
 * страница приходит куском HTML с server-rendered таблицей. Поэтому «выгрузка»
 * здесь — сама страница отчёта, и разбирать приходится разметку.
 *
 * Ключевое: строка таблицы содержит НЕ только видимые колонки. Внутри первой
 * ячейки спрятан раскрывающийся блок, а в нём — JSON заказа и фискальные поля
 * (ИКПУ, упаковка, штрих-код, маркировка). Это и есть самое ценное, чего нет
 * ни в одной другой системе владельца.
 *
 * Разворачивание вложенного в колонки НЕ противоречит правилу сырого слоя.
 * Правило запрещает переименовывать и приводить к типам; здесь же мы достаём
 * то, что источник сам положил внутрь ячейки, и называем СВОИМИ ЖЕ его
 * именами: `orderNo`, `machineCode`, «ИКПУ», «Упаковка». Хранить трёхкилобайтный
 * кусок разметки как одно «значение» значило бы сохранить оформление вместо
 * данных.
 */

/** Разобранная страница отчёта. */
export interface OfficeReport {
  /** Колонки в порядке: сначала видимые в таблице, потом развёрнутые из ячейки. */
  columns: string[];
  rows: string[][];
  /** Сколько строк не отдали JSON заказа — по ним развёрнутых полей нет. */
  withoutJson: number;
}

/** Пусто по-кабинетному: прочерк или «Нет данных». Оба значат «источник не дал». */
export function isBlank(value: string): boolean {
  const v = value.trim();
  return v === "" || v === "—" || v.toLowerCase() === "нет данных";
}

/** Снять разметку и схлопнуть пробелы: в ячейках кабинета их десятки. */
function text(fragment: string): string {
  return unescapeHtml(fragment.replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

/** Обратное преобразование HTML-мнемоник. Кабинет отдаёт их в значениях. */
export function unescapeHtml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

/**
 * JSON заказа из ячейки.
 *
 * Кабинет печатает его «красиво»: запятые заменены на `<br/>`. Без обратной
 * замены это не JSON, а набор строк, и разобрать его нельзя.
 *
 * null — блока нет или он нечитаем. Догадываться о содержимом нельзя: пустая
 * строка честнее выдуманной.
 */
export function parseOrderInfo(cell: string): Record<string, unknown> | null {
  const m = /<pre[^>]*class="[^"]*order-container[^"]*"[^>]*>([\s\S]*?)<\/pre>/.exec(cell);
  if (!m) return null;
  const json = unescapeHtml(m[1].replace(/<br\s*\/?>/gi, ","));
  try {
    const parsed: unknown = JSON.parse(json);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Пары «подпись → значение» из раскрывающегося блока.
 *
 * Разбираются поблочно, а не сквозным поиском по ячейке: подпись и значение
 * лежат в одном `vhj-df`, и жадный поиск склеил бы подпись одной строки со
 * значением следующей.
 */
export function parseLabelledPairs(cell: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const block of cell.match(/<div[^>]*class="[^"]*vhj-df[^"]*"[^>]*>[\s\S]*?<\/div>/g) ?? []) {
    const label = /<span[^>]*class="[^"]*vhj-dl[^"]*"[^>]*>([\s\S]*?)<\/span>/.exec(block);
    if (!label) continue;
    const key = text(label[1]);
    if (key.length === 0 || key === "order Info") continue;
    // Значение берём из кнопки «копировать», если она есть: там оно лежит
    // готовым, без вложенной разметки и подсказок.
    const copy = /data-c="([^"]*)"/.exec(block);
    const value = /<span[^>]*class="[^"]*vhj-dv[^"]*"[^>]*>([\s\S]*?)<\/span>/.exec(block);
    const v = copy ? unescapeHtml(copy[1]).trim() : value ? text(value[1]) : "";
    // Прочерк и «Нет данных» — это «источник ничего не дал», и хранить их как
    // значение незачем: пустая ячейка говорит то же самое и не притворяется
    // данными. Кабинет пишет то одно, то другое — оба означают пусто.
    if (out[key] === undefined) out[key] = isBlank(v) ? "" : v;
  }
  return out;
}

/**
 * Разобрать страницу отчёта кабинета.
 *
 * Первая таблица страницы — она же единственная: остальное на странице это
 * оболочка и фильтры.
 */
export function parseOfficeReport(html: string): OfficeReport {
  const table = /<table[^>]*>[\s\S]*?<\/table>/.exec(html);
  if (!table) return { columns: [], rows: [], withoutJson: 0 };

  const visible = [...table[0].matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)].map((m) => text(m[1]));
  if (visible.length === 0) return { columns: [], rows: [], withoutJson: 0 };

  const trs = [...table[0].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map((m) => m[1]);

  // Состав развёрнутых колонок собираем по ВСЕМ строкам: у одного заказа поля
  // может не быть, и взяв состав по первой строке, мы молча потеряли бы его у
  // остальных.
  const nested: string[] = [];
  const parsed: { cells: string[]; extra: Record<string, string> }[] = [];
  let withoutJson = 0;

  for (const tr of trs) {
    const tds = [...tr.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => m[1]);
    if (tds.length === 0) continue;
    const detail = tds[0];
    const extra: Record<string, string> = {};

    const info = parseOrderInfo(detail);
    if (info === null) withoutJson += 1;
    else {
      for (const [k, v] of Object.entries(info)) {
        // Значения остаются строками: приводить к типам на сыром слое нельзя.
        extra[k] = v === null || v === undefined ? "" : String(v);
      }
    }
    for (const [k, v] of Object.entries(parseLabelledPairs(detail))) extra[k] = v;

    for (const k of Object.keys(extra)) if (!nested.includes(k)) nested.push(k);
    // Видимые колонки: первая ячейка — раскрывающийся блок, из неё в таблицу
    // идёт только собственный идентификатор строки.
    const cells = tds.map((c, i) => (i === 0 ? cellValue(c) : text(c)));
    parsed.push({ cells, extra });
  }

  const columns = [...visible, ...nested];
  const rows = parsed.map(({ cells, extra }) => {
    const row = visible.map((_, i) => cells[i] ?? "");
    for (const k of nested) row.push(extra[k] ?? "");
    return row;
  });

  return { columns, rows, withoutJson };
}

/**
 * Собственное значение ячейки, без раскрывающегося блока.
 *
 * Кабинет сам помечает ту часть ячейки, которая идёт в выгрузку:
 * `data-target="for-excel"`. На неё и опираемся — это его собственное решение
 * о том, что здесь данные, а что оформление, и лучшего указания у нас нет.
 *
 * Если пометки нет, берём номер строки из `data-row-id`, а в последнюю очередь
 * — текст до первого блока.
 */
export function cellValue(cell: string): string {
  const marked = /<[a-z]+[^>]*data-target="for-excel"[^>]*>([\s\S]*?)<\/[a-z]+>/i.exec(cell);
  if (marked) return text(marked[1]);
  const rowId = /data-row-id="([^"]*)"/.exec(cell);
  if (rowId) return rowId[1].trim();
  // Вложенного блока нет — значит вся ячейка это одно значение, даже если оно
  // обёрнуто в тег (кабинет пишет то «<nobr>39384</nobr>», то просто «39384»).
  // Если же блок есть, весь его текст брать нельзя — вернём то, что стоит до
  // него, иначе в колонку ушёл бы трёхкилобайтный разворот.
  const detail = /<(?:div|pre)[^>]*class="[^"]*(?:vhj-df|detail-container|order-container)[^"]*"/i.exec(
    cell,
  );
  return text(detail ? cell.slice(0, detail.index) : cell);
}
