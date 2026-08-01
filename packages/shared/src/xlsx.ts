/**
 * Разбор выгрузки, сохранённой файлом .xlsx.
 *
 * Некоторые кабинеты (OurVend/TCN) отдают отчёт только Excel-файлом, а не CSV.
 * Такой файл — это zip с XML внутри, и `parseDelimited` его прочитать не может.
 * Разбор живёт здесь, рядом с разбором CSV: по нему считает и оболочка, и Core.
 *
 * Правило слоя цело — ничего не приводится к типам ради удобства. Единственное
 * исключение вынужденное: даты Excel хранит числом (серийный день), а НЕ строкой,
 * которую видел человек. Восстановить исходную строку можно только развернув
 * число по формату ячейки — иначе во времени заказа стояло бы «46136.9» вместо
 * «2026-04-24 21:36:56». Числа-не-даты остаются как есть, текст — как написан.
 *
 * Зависимостей нет: распаковка zip идёт через встроенный DecompressionStream
 * (есть и в браузере, и в Node 18+), XML читается по месту.
 */

/** Разобранный лист: те же поля, что у CSV-разбора, плюс имя листа. */
export interface XlsxSheet {
  columns: string[];
  rows: string[][];
  /** Имя первого листа — владельцу видно, из чего читали. */
  sheet: string;
  /** Строк, где ячеек оказалось не столько, сколько заголовков. */
  ragged: number;
}

/** Похоже ли начало файла на zip (а значит, на .xlsx). */
export function looksLikeXlsx(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

// ── Распаковка zip ────────────────────────────────────────────────────────

interface ZipEntry {
  name: string;
  method: number;
  offset: number;
  compressedSize: number;
}

function u16(dv: DataView, o: number): number {
  return dv.getUint16(o, true);
}
function u32(dv: DataView, o: number): number {
  return dv.getUint32(o, true);
}

/** Найти запись End Of Central Directory и вернуть смещение и число записей. */
function findEocd(dv: DataView, bytes: Uint8Array): { cdOffset: number; count: number } {
  // EOCD стоит в конце и может иметь комментарий до 65535 байт — сканируем с хвоста.
  const min = Math.max(0, bytes.length - (0xffff + 22));
  for (let i = bytes.length - 22; i >= min; i -= 1) {
    if (u32(dv, i) === 0x06054b50) {
      return { count: u16(dv, i + 10), cdOffset: u32(dv, i + 16) };
    }
  }
  throw new Error("Не .xlsx: не найден каталог zip (файл повреждён или не Excel).");
}

/** Прочитать центральный каталог zip в список записей. */
function readCentralDirectory(dv: DataView, bytes: Uint8Array): ZipEntry[] {
  const { cdOffset, count } = findEocd(dv, bytes);
  const entries: ZipEntry[] = [];
  let p = cdOffset;
  for (let n = 0; n < count; n += 1) {
    if (u32(dv, p) !== 0x02014b50) break;
    const method = u16(dv, p + 10);
    const compressedSize = u32(dv, p + 20);
    const nameLen = u16(dv, p + 28);
    const extraLen = u16(dv, p + 30);
    const commentLen = u16(dv, p + 32);
    const localOffset = u32(dv, p + 42);
    const name = new TextDecoder("utf-8").decode(bytes.subarray(p + 46, p + 46 + nameLen));
    entries.push({ name, method, offset: localOffset, compressedSize });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** Сырые байты одной записи (по локальному заголовку). */
function rawEntryBytes(dv: DataView, bytes: Uint8Array, e: ZipEntry): Uint8Array {
  // Локальный заголовок хранит собственные длины имени и extra — они могут
  // отличаться от каталожных, поэтому смещение данных считаем по нему.
  if (u32(dv, e.offset) !== 0x04034b50) throw new Error("Битый локальный заголовок zip.");
  const nameLen = u16(dv, e.offset + 26);
  const extraLen = u16(dv, e.offset + 28);
  const start = e.offset + 30 + nameLen + extraLen;
  return bytes.subarray(start, start + e.compressedSize);
}

/** Распаковать сырой deflate встроенным потоком (без зависимостей). */
async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream("deflate-raw");
  // Копия в свежий ArrayBuffer: subarray смотрит в чужой буфер, а Response/поток
  // ждёт самостоятельный кусок.
  const copy = data.slice();
  const stream = new Response(copy).body;
  if (!stream) throw new Error("Поток распаковки недоступен в этой среде.");
  const out = await new Response(stream.pipeThrough(ds)).arrayBuffer();
  return new Uint8Array(out);
}

/** Распаковать zip в словарь «имя → текст». Читаем только нужные части. */
async function unzip(bytes: Uint8Array, want: (name: string) => boolean): Promise<Map<string, string>> {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const entries = readCentralDirectory(dv, bytes);
  const out = new Map<string, string>();
  const dec = new TextDecoder("utf-8");
  for (const e of entries) {
    if (!want(e.name)) continue;
    const raw = rawEntryBytes(dv, bytes, e);
    const bytesOut = e.method === 0 ? raw : await inflateRaw(raw);
    out.set(e.name, dec.decode(bytesOut));
  }
  return out;
}

// ── Разбор XML листа ──────────────────────────────────────────────────────

/** Развернуть XML-сущности в обычный текст. */
function unescapeXml(s: string): string {
  return s.replace(/&(#\d+|#x[0-9a-fA-F]+|amp|lt|gt|quot|apos);/g, (_, e: string) => {
    if (e === "amp") return "&";
    if (e === "lt") return "<";
    if (e === "gt") return ">";
    if (e === "quot") return '"';
    if (e === "apos") return "'";
    if (e[0] === "#") {
      const code = e[1] === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : "";
    }
    return "";
  });
}

/** Общие строки: массив, где ячейка `t="s"` берёт значение по индексу. */
function parseSharedStrings(xml: string | undefined): string[] {
  if (!xml) return [];
  const out: string[] = [];
  const siRe = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
  let m: RegExpExecArray | null;
  while ((m = siRe.exec(xml)) !== null) {
    // Внутри <si> может быть один <t> или несколько <r><t> — склеиваем все.
    const parts: string[] = [];
    const tRe = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
    let t: RegExpExecArray | null;
    while ((t = tRe.exec(m[1])) !== null) parts.push(unescapeXml(t[1]));
    out.push(parts.join(""));
  }
  return out;
}

/**
 * Форматы-даты: id пользовательских дат + встроенные id дат Excel.
 *
 * Ячейка ссылается на стиль (`s`), стиль — на формат числа. Если формат
 * датовый, число в ячейке — серийный день, и его надо развернуть в строку.
 */
function parseDateStyles(xml: string | undefined): { dateXf: Set<number>; timeXf: Set<number> } {
  const dateXf = new Set<number>();
  const timeXf = new Set<number>();
  if (!xml) return { dateXf, timeXf };

  // Встроенные форматы: 14–22 и 45–47 — даты/время (у Excel зафиксированы).
  const builtinDate = new Set<number>([14, 15, 16, 17, 22, 45, 46, 47]);
  const builtinTime = new Set<number>([18, 19, 20, 21, 45, 46, 47]);

  const fmtCode = new Map<number, string>();
  const nfRe = /<numFmt\b[^>]*\bnumFmtId="(\d+)"[^>]*\bformatCode="([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = nfRe.exec(xml)) !== null) fmtCode.set(Number(m[1]), unescapeXml(m[2]));

  const isDate = (id: number): boolean => {
    if (builtinDate.has(id)) return true;
    const code = fmtCode.get(id);
    return code !== undefined && hasDateTokens(code);
  };
  const hasTime = (id: number): boolean => {
    if (builtinTime.has(id)) return true;
    const code = fmtCode.get(id);
    return code !== undefined && /[hs]/i.test(stripLiterals(code));
  };

  // cellXfs: индекс xf → его numFmtId. По индексу и ссылается ячейка через `s`.
  const cellXfs = xml.match(/<cellXfs\b[^>]*>[\s\S]*?<\/cellXfs>/);
  if (cellXfs) {
    const xfRe = /<xf\b[^>]*\bnumFmtId="(\d+)"[^>]*\/?>/g;
    let idx = 0;
    let x: RegExpExecArray | null;
    while ((x = xfRe.exec(cellXfs[0])) !== null) {
      const id = Number(x[1]);
      if (isDate(id)) dateXf.add(idx);
      if (hasTime(id)) timeXf.add(idx);
      idx += 1;
    }
  }
  return { dateXf, timeXf };
}

/** Убрать из формата экранированные и закавыченные литералы. */
function stripLiterals(code: string): string {
  return code.replace(/\\./g, "").replace(/"[^"]*"/g, "").replace(/\[[^\]]*\]/g, "");
}

/** Есть ли в формате токены даты/времени (после снятия литералов). */
function hasDateTokens(code: string): boolean {
  return /[ymdhs]/i.test(stripLiterals(code));
}

/** Номер колонки (0-based) из ссылки ячейки: «L2» → 11. */
function colIndex(ref: string): number {
  let n = 0;
  for (let i = 0; i < ref.length; i += 1) {
    const c = ref.charCodeAt(i);
    if (c >= 65 && c <= 90) n = n * 26 + (c - 64);
    else break;
  }
  return n - 1;
}

/** Серийный день Excel → строка, как её видел человек. */
function serialToString(serial: number, withTime: boolean): string {
  // Эпоха Excel — 1899-12-30 (учитывает мнимый високосный 1900 год).
  const ms = Math.round(serial * 86400 * 1000);
  const d = new Date(Date.UTC(1899, 11, 30) + ms);
  const p = (n: number) => String(n).padStart(2, "0");
  const date = `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
  if (!withTime) return date;
  return `${date} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

/** Значение одной ячейки в строку. */
function cellValue(
  t: string | null,
  s: number | null,
  inner: string,
  shared: string[],
  dateXf: Set<number>,
  timeXf: Set<number>,
): string {
  if (t === "s") {
    const i = Number(getTag(inner, "v"));
    return shared[i] ?? "";
  }
  if (t === "inlineStr") {
    const is = getTag(inner, "is");
    const parts: string[] = [];
    const tRe = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
    let m: RegExpExecArray | null;
    while ((m = tRe.exec(is)) !== null) parts.push(unescapeXml(m[1]));
    return parts.join("");
  }
  if (t === "str") return unescapeXml(getTag(inner, "v"));
  if (t === "b") return getTag(inner, "v") === "1" ? "TRUE" : "FALSE";
  // Число (или дата, спрятанная числом).
  const v = getTag(inner, "v");
  if (v === "") return "";
  if (s !== null && dateXf.has(s)) {
    const num = Number(v);
    if (Number.isFinite(num)) return serialToString(num, timeXf.has(s));
  }
  return v;
}

/** Содержимое первого тега `name` внутри строки (или пустое). */
function getTag(xml: string, name: string): string {
  const m = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`).exec(xml);
  if (m) return m[1];
  return "";
}

/** Разобрать XML листа в строки. */
function parseSheet(
  xml: string,
  shared: string[],
  dateXf: Set<number>,
  timeXf: Set<number>,
): { rows: string[][]; ragged: number } {
  const rows: string[][] = [];
  const rowRe = /<row\b[^>]*>([\s\S]*?)<\/row>|<row\b[^>]*\/>/g;
  let rm: RegExpExecArray | null;
  while ((rm = rowRe.exec(xml)) !== null) {
    const body = rm[1] ?? "";
    const cells: string[] = [];
    const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let cm: RegExpExecArray | null;
    while ((cm = cellRe.exec(body)) !== null) {
      const attrs = cm[1];
      const inner = cm[2] ?? "";
      const ref = /\br="([A-Z]+)\d+"/.exec(attrs);
      const col = ref ? colIndex(ref[1]) : cells.length;
      const t = /\bt="([^"]+)"/.exec(attrs);
      const sAttr = /\bs="(\d+)"/.exec(attrs);
      const val = cellValue(t ? t[1] : null, sAttr ? Number(sAttr[1]) : null, inner, shared, dateXf, timeXf);
      // Пропущенные ячейки (пустые) в XML отсутствуют — добиваем пустыми по месту.
      while (cells.length < col) cells.push("");
      cells[col] = val;
    }
    rows.push(cells);
  }
  return alignRows(rows);
}

/** Выровнять строки по числу заголовков; посчитать неровные. */
function alignRows(rows: string[][]): { rows: string[][]; ragged: number } {
  if (rows.length === 0) return { rows, ragged: 0 };
  const width = rows[0].length;
  let ragged = 0;
  const out = rows.map((r) => {
    if (r.length !== width) ragged += 1;
    const copy = r.slice(0, Math.max(width, r.length));
    while (copy.length < width) copy.push("");
    return copy;
  });
  // Заголовок неровным не считаем — он и задаёт ширину.
  if (out.length > 0 && rows[0].length === width) ragged = Math.max(0, ragged - 0);
  return { rows: out, ragged };
}

/** Путь к первому листу книги (обычно xl/worksheets/sheet1.xml). */
function firstSheetPath(files: Map<string, string>): string {
  const names = [...files.keys()].filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n));
  names.sort((a, b) => {
    const na = Number(/sheet(\d+)\.xml/.exec(a)![1]);
    const nb = Number(/sheet(\d+)\.xml/.exec(b)![1]);
    return na - nb;
  });
  return names[0] ?? "xl/worksheets/sheet1.xml";
}

/** Имя первого листа из workbook.xml (для показа владельцу). */
function firstSheetName(workbook: string | undefined): string {
  if (!workbook) return "Лист 1";
  const m = /<sheet\b[^>]*\bname="([^"]*)"/.exec(workbook);
  return m ? unescapeXml(m[1]) : "Лист 1";
}

/**
 * Разобрать .xlsx: первый лист в заголовки и строки.
 *
 * Читаются только нужные части архива (лист, общие строки, стили, книга) —
 * тему и картинки не трогаем.
 */
export async function parseXlsx(bytes: Uint8Array): Promise<XlsxSheet> {
  const files = await unzip(
    bytes,
    (n) =>
      n === "xl/sharedStrings.xml" ||
      n === "xl/styles.xml" ||
      n === "xl/workbook.xml" ||
      /^xl\/worksheets\/sheet\d+\.xml$/.test(n),
  );

  const shared = parseSharedStrings(files.get("xl/sharedStrings.xml"));
  const { dateXf, timeXf } = parseDateStyles(files.get("xl/styles.xml"));
  const sheetPath = firstSheetPath(files);
  const sheetXml = files.get(sheetPath);
  if (!sheetXml) throw new Error("В книге не найден лист с данными.");

  const { rows, ragged } = parseSheet(sheetXml, shared, dateXf, timeXf);
  const columns = rows.length > 0 ? rows[0] : [];
  return {
    columns,
    rows: rows.slice(1),
    sheet: firstSheetName(files.get("xl/workbook.xml")),
    ragged,
  };
}
