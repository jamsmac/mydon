/**
 * Разбор выгрузки, сохранённой файлом.
 *
 * Чужие системы отдают отчёт кнопкой «Экспорт», и до сих пор такой файл мог
 * загрузить только разработчик — скриптом, с ключом приёма и туннелем до
 * сервера. Пока это так, «заполнить источник» означало «продиктовать
 * разработчику»: роли колонок назначать не по чему, пока нет первой выгрузки, а
 * выгрузку не положить без чужих рук.
 *
 * Разбор живёт здесь, а не в экране: по нему считает и оболочка, и Core, и
 * расходиться они не имеют права. Ничего не приводится к типам — значения
 * остаются строками ровно так, как их написал источник. Это по-прежнему сырьё.
 */

/** Разделители, которые встречаются у выгрузок. */
export const DELIMITERS = [";", ",", "\t", "|"] as const;
export type Delimiter = (typeof DELIMITERS)[number];

/** Разобранная выгрузка. */
export interface Delimited {
  /** Заголовки первой строки — в порядке источника. Порядок часть данных. */
  columns: string[];
  rows: string[][];
  /** Каким разделителем читали: владельцу это видно, а не угадывается молча. */
  delimiter: Delimiter;
  /**
   * Строки, где ячеек оказалось не столько, сколько заголовков.
   *
   * Не отбрасываются и не «чинятся»: короткая строка дополняется пустыми, а
   * длинная сохраняется целиком. Но их число называется — молчаливое
   * выравнивание скрыло бы, что файл прочитан не так, как задумано.
   */
  ragged: number;
}

/**
 * Одна строка файла в ячейки. Кавычки по правилам CSV: внутри кавычек
 * разделитель и перевод строки — обычные символы, а удвоенная кавычка это одна.
 */
function splitRow(line: string, delimiter: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (quoted) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i += 1;
        } else quoted = false;
      } else cur += c;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === delimiter) {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out;
}

/** Разбить текст на строки, не разрывая значения внутри кавычек. */
function splitLines(text: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (c === '"') {
      quoted = !quoted;
      cur += c;
      continue;
    }
    if (!quoted && (c === "\n" || c === "\r")) {
      // \r\n — один перевод строки, а не два.
      if (c === "\r" && text[i + 1] === "\n") i += 1;
      out.push(cur);
      cur = "";
      continue;
    }
    cur += c;
  }
  if (cur.length > 0) out.push(cur);
  return out;
}

/**
 * Каким разделителем читать.
 *
 * Не «самый частый символ», а тот, при котором строки бьются на РОВНОЕ и
 * осмысленное число колонок. Иначе адрес «2 корпус, кардиология» сделал бы
 * запятую разделителем у файла, разделённого точкой с запятой.
 */
export function sniffDelimiter(text: string): Delimiter {
  const lines = splitLines(text).filter((l) => l.trim().length > 0).slice(0, 20);
  if (lines.length === 0) return ";";
  let best: Delimiter = ";";
  let bestScore = -1;
  for (const d of DELIMITERS) {
    const counts = lines.map((l) => splitRow(l, d).length);
    const first = counts[0];
    if (first < 2) continue;
    const even = counts.filter((c) => c === first).length / counts.length;
    // Ровность важнее числа колонок: файл, где все строки бьются одинаково,
    // прочитан верно, даже если колонок в нём немного.
    const score = even * 100 + first;
    if (score > bestScore) {
      bestScore = score;
      best = d;
    }
  }
  return best;
}

/**
 * Разобрать выгрузку. Первая строка — заголовки: так отдают все известные нам
 * системы, и угадывать здесь нечего.
 *
 * Пустые строки в конце файла отбрасываются — это не данные, а хвост экспорта.
 * Пустые строки в середине сохраняются: они могут значить разрыв в отчёте.
 */
export function parseDelimited(text: string, delimiter?: Delimiter): Delimited {
  // BOM записан кодом: в исходнике он невидим, а Excel ставит его в UTF-8.
  const clean = text.replace(/^\uFEFF/, "");
  const d = delimiter ?? sniffDelimiter(clean);
  const lines = splitLines(clean);
  while (lines.length > 0 && lines[lines.length - 1].trim().length === 0) lines.pop();
  if (lines.length === 0) return { columns: [], rows: [], delimiter: d, ragged: 0 };

  const columns = splitRow(lines[0], d).map((c) => c.trim());
  let ragged = 0;
  const rows: string[][] = [];
  for (const line of lines.slice(1)) {
    const cells = splitRow(line, d);
    if (cells.length !== columns.length) ragged += 1;
    // Короткую строку дополняем пустыми, длинную оставляем целиком: обрезать
    // значило бы выбросить то, что источник отдал.
    while (cells.length < columns.length) cells.push("");
    rows.push(cells);
  }
  return { columns, rows, delimiter: d, ragged };
}

/**
 * Прочитать файл текстом, угадав кодировку.
 *
 * Excel в русской локали сохраняет CSV в cp1251, и такой файл, прочитанный как
 * UTF-8, превращается в кракозябры. Отличить их можно надёжно: UTF-8 — формат
 * с проверкой, и неверная последовательность байт даёт символ замены.
 *
 * Порядок: BOM важнее всего (он прямо называет кодировку), потом — строгая
 * проверка UTF-8, и только при её провале cp1251.
 */
export function decodeUpload(bytes: Uint8Array): { text: string; encoding: string } {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { text: new TextDecoder("utf-8").decode(bytes), encoding: "utf-8 (с BOM)" };
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return { text, encoding: "utf-8" };
  } catch {
    return { text: new TextDecoder("windows-1251").decode(bytes), encoding: "windows-1251" };
  }
}
