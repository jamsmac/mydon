/**
 * КП GLOBERENT — рендерер ПО РЕАЛЬНЫМ ОБРАЗЦАМ владельца (2026-08-04:
 * CPD15, CPD20, BF30-1, CBD30-170HA), а не по шаблону донора TAS.
 *
 * Структура бланка (сверено с образцами):
 *   шапка: GLOBERENT FINANCE слева · HELI справа, линия;
 *   заголовок «КОММЕРЧЕСКОЕ ПРЕДЛОЖЕНИЕ» + «№ КП-ГГГГ/ММДД-N · ДД.ММ.ГГГГ»;
 *   вводный абзац компании + абзац о модели;
 *   теглайн («Электрический вилочный погрузчик 1 500 кг · 4 500 мм»);
 *   таблица характеристик с тёмно-коричневой шапкой, последняя строка —
 *   «Цена с НДС» оранжевым жирным;
 *   «Общие условия» (оплата / включено / поставка / срок);
 *   гарантийный блок на крем-подложке;
 *   футер-полоса с адресом/телефоном/почтой;
 *   опционально — страницы полных характеристик по группам.
 *
 * Цвета подобраны по образцам (пипеткой с PDF): точные фирменные коды
 * можно уточнить у владельца — вынесены константами в одном месте.
 */
import {
  AlignmentType,
  BorderStyle,
  Document,
  Packer,
  PageBreak,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from "docx";

// ── Палитра бланка (приближение к образцам) ──
const BROWN_DARK = "5C3A21"; // шапки таблиц, полоса футера
const BROWN_TITLE = "7B3F1E"; // заголовок КП, теглайн, подписи условий
const CREAM = "FDF3E7"; // подложка ярлыков и гарантийного блока
const PRICE_ORANGE = "C55A11"; // цена с НДС
const GRAY = "8A8A8A"; // номер/дата под заголовком
const FONT = "Montserrat"; // гарнитура образцов; при отсутствии Word подставит близкую

const A4 = { width: 11906, height: 16838 };
const MARGINS = { top: 900, right: 900, bottom: 900, left: 900 };
const TW = 10106; // ширина контента в DXA при этих полях

export interface KpRow {
  label: string;
  value: string;
}

export interface KpSpecGroup {
  title: string;
  rows: KpRow[];
}

/** Условия «Общие условия» — дефолты сняты с образцов CPD15/CPD20. */
export interface KpConditions {
  payment: string;
  included: string;
  delivery: string;
  leadTime: string;
}

export const KP_DEFAULT_CONDITIONS: KpConditions = {
  payment: "50% предоплата, 50% по факту готовности товара к отгрузке со склада в Ташкенте",
  included: "Предпродажная подготовка, ЗИП ящик, зарядное устройство",
  delivery: "Доставка до склада Покупателя в Ташкенте",
  leadTime: "В наличии",
};

/** Гарантийный блок — дефолт с образцов Li-Ion серии. */
export const KP_DEFAULT_WARRANTY = {
  title: "ГАРАНТИЙНЫЕ ОБЯЗАТЕЛЬСТВА HELI",
  lines: [
    "— Электрический погрузчик — 2 года или 4 000 мото/часов",
    "— Литий-ионный аккумулятор — 5 лет",
  ],
};

/** Футер — реквизиты с образцов. */
export const KP_DEFAULT_FOOTER =
  "адрес г. Ташкент, Яшнабадский р-н, Шохимардон, 17     тел.  +998 71 200 1 201     email  globerefin@gmail.com";

/** Вводный абзац компании — дословно с образцов. */
export const KP_INTRO =
  "Компания Globerent Finance предлагает поставку складской техники HELI. " +
  "Мы осуществляем подбор оборудования с учётом специфики вашего бизнеса, " +
  "условий эксплуатации и требуемых технических характеристик.";

export interface KpGloberentInput {
  /** «КП-2026/0507-1» — см. kpNumber(). */
  kpNo: string;
  /** Дата документа, YYYY-MM-DD. */
  date: string;
  /** Абзац о модели («В предложении представлен…»). Пусто — не печатается. */
  aboutModel?: string;
  /** Теглайн: «Электрический вилочный погрузчик 1 500 кг · 4 500 мм». */
  tagline?: string;
  /** Шапка таблицы: «ЭЛЕКТРИЧЕСКИЙ ВИЛОЧНЫЙ ПОГРУЗЧИК LI-ION · G3 СЕРИЯ · CPD 15-GB3LI-S». */
  tableTitle: string;
  rows: KpRow[];
  /** Цена с НДС, сум. */
  priceWithVat: number;
  conditions?: Partial<KpConditions> | null;
  /** null — блок условий не печатается (короткие КП, как BF30-1). */
  warranty?: { title: string; lines: string[] } | null;
  footer?: string;
  /** Полные характеристики по группам — вторая страница (как CPD15/20). */
  specGroups?: KpSpecGroup[];
  specTitle?: string;
}

// ════════════════════════════════════════════════════════════════════════════
// Чистый текстовый слой — тестируется без docx
// ════════════════════════════════════════════════════════════════════════════

/** Номер КП по схеме образцов: КП-ГГГГ/ММДД-N (N — порядковый за день). */
export function kpNumber(dateIso: string, seqInDay: number): string {
  const [y, m, d] = dateIso.split("-");
  return `КП-${y}/${m}${d}-${seqInDay}`;
}

/** «2026-05-07» → «07.05.2026» (формат строки под заголовком). */
export function kpDate(dateIso: string): string {
  const [y, m, d] = dateIso.split("-");
  return `${d}.${m}.${y}`;
}

/** «227 360 000 сум» — формат цены образцов (целые сумы, пробелы-разряды). */
export function kpPriceText(priceWithVat: number): string {
  return `${new Intl.NumberFormat("ru-RU").format(Math.round(priceWithVat)).replace(/\u00A0/g, " ")} сум`;
}

/** Строка «№ … · …» под заголовком. */
export function kpSubtitle(kpNo: string, dateIso: string): string {
  return `№ ${kpNo} · ${kpDate(dateIso)}`;
}

/** Итоговые условия: дефолты образцов, поверх — что передали. */
export function kpConditions(over?: Partial<KpConditions> | null): KpConditions {
  return { ...KP_DEFAULT_CONDITIONS, ...(over ?? {}) };
}

// ════════════════════════════════════════════════════════════════════════════
// DOCX-слой
// ════════════════════════════════════════════════════════════════════════════

const run = (text: string, opts: { bold?: boolean; italics?: boolean; color?: string; size?: number; caps?: boolean } = {}) =>
  new TextRun({
    text,
    font: FONT,
    bold: opts.bold ?? false,
    italics: opts.italics ?? false,
    color: opts.color,
    size: opts.size ?? 22,
    allCaps: opts.caps ?? false,
  });

const p = (children: TextRun[], opts: { align?: (typeof AlignmentType)[keyof typeof AlignmentType]; before?: number; after?: number } = {}) =>
  new Paragraph({
    children,
    alignment: opts.align ?? AlignmentType.JUSTIFIED,
    spacing: { before: opts.before ?? 0, after: opts.after ?? 120 },
  });

const NO_BORDER = { style: BorderStyle.NONE, size: 0, color: "FFFFFF" };
const THIN = { style: BorderStyle.SINGLE, size: 4, color: "D9C4AC" };

function cell(children: Paragraph[], opts: { fill?: string; width?: number } = {}): TableCell {
  return new TableCell({
    children,
    shading: opts.fill !== undefined ? { fill: opts.fill } : undefined,
    width: opts.width !== undefined ? { size: opts.width, type: WidthType.DXA } : undefined,
    borders: { top: THIN, bottom: THIN, left: THIN, right: THIN },
    margins: { top: 90, bottom: 90, left: 140, right: 140 },
  });
}

/** Полноширинная полоса (шапка таблицы, «Общие условия», футер). */
function band(text: string, opts: { italics?: boolean } = {}): Table {
  return new Table({
    width: { size: TW, type: WidthType.DXA },
    rows: [
      new TableRow({
        children: [
          new TableCell({
            children: [
              new Paragraph({
                children: [run(text, { bold: true, color: "FFFFFF", size: 21, italics: opts.italics ?? false })],
                alignment: AlignmentType.CENTER,
              }),
            ],
            shading: { fill: BROWN_DARK },
            borders: { top: NO_BORDER, bottom: NO_BORDER, left: NO_BORDER, right: NO_BORDER },
            margins: { top: 100, bottom: 100, left: 140, right: 140 },
          }),
        ],
      }),
    ],
  });
}

/** Таблица «ярлык слева (крем через строку) — значение по центру». */
function rowsTable(rows: KpRow[], priceRow: KpRow | null): Table {
  const half = Math.floor(TW / 2);
  const trs = rows.map(
    (r, i) =>
      new TableRow({
        children: [
          cell([p([run(r.label, { size: 21 })], { align: AlignmentType.LEFT, after: 0 })], {
            fill: i % 2 === 0 ? CREAM : undefined,
            width: half,
          }),
          cell([p([run(r.value, { size: 21 })], { align: AlignmentType.CENTER, after: 0 })], {
            width: TW - half,
          }),
        ],
      }),
  );
  if (priceRow !== null) {
    trs.push(
      new TableRow({
        children: [
          cell([p([run(priceRow.label, { size: 21, bold: true })], { align: AlignmentType.LEFT, after: 0 })], {
            fill: CREAM,
            width: half,
          }),
          cell(
            [p([run(priceRow.value, { size: 23, bold: true, color: PRICE_ORANGE })], { align: AlignmentType.CENTER, after: 0 })],
            { width: TW - half },
          ),
        ],
      }),
    );
  }
  return new Table({ width: { size: TW, type: WidthType.DXA }, rows: trs });
}

/** Блок «Общие условия»: ярлык коричневыми капс слева, текст справа. */
function conditionsTable(c: KpConditions): Table {
  const half = Math.floor(TW * 0.38);
  const entries: [string, string][] = [
    ["УСЛОВИЯ ОПЛАТЫ", c.payment],
    ["ВКЛЮЧЕНО В СТОИМОСТЬ", c.included],
    ["УСЛОВИЯ ПОСТАВКИ", c.delivery],
    ["СРОК ПОСТАВКИ", c.leadTime],
  ];
  return new Table({
    width: { size: TW, type: WidthType.DXA },
    rows: entries.map(
      ([k, v]) =>
        new TableRow({
          children: [
            cell([p([run(k, { bold: true, color: BROWN_TITLE, size: 18 })], { align: AlignmentType.LEFT, after: 0 })], {
              width: half,
            }),
            cell([p([run(v, { size: 21 })], { align: AlignmentType.LEFT, after: 0 })], { width: TW - half }),
          ],
        }),
    ),
  });
}

/** Сборка документа по бланку образцов. */
export function buildKpDocument(input: KpGloberentInput): Document {
  const conditions = input.conditions === null ? null : kpConditions(input.conditions);
  const warranty = input.warranty === undefined ? KP_DEFAULT_WARRANTY : input.warranty;
  const footer = input.footer ?? KP_DEFAULT_FOOTER;

  const children: (Paragraph | Table)[] = [
    // Шапка: два «логотипа» текстом (фирменные картинки — параметром позже).
    new Table({
      width: { size: TW, type: WidthType.DXA },
      rows: [
        new TableRow({
          children: [
            new TableCell({
              children: [p([run("GLOBERENT", { bold: true, size: 30 }), run(" FINANCE", { size: 30 })], { align: AlignmentType.LEFT, after: 0 })],
              borders: { top: NO_BORDER, bottom: NO_BORDER, left: NO_BORDER, right: NO_BORDER },
            }),
            new TableCell({
              children: [
                p([run("HELI", { bold: true, color: "C00000", size: 34 })], { align: AlignmentType.RIGHT, after: 0 }),
                p([run("LIFTING THE FUTURE", { bold: true, color: "C00000", size: 14 })], { align: AlignmentType.RIGHT, after: 0 }),
              ],
              borders: { top: NO_BORDER, bottom: NO_BORDER, left: NO_BORDER, right: NO_BORDER },
            }),
          ],
        }),
      ],
    }),
    new Paragraph({
      children: [],
      border: { bottom: { style: BorderStyle.SINGLE, size: 8, color: BROWN_TITLE } },
      spacing: { after: 240 },
    }),
    p([run("КОММЕРЧЕСКОЕ ПРЕДЛОЖЕНИЕ", { bold: true, color: BROWN_TITLE, size: 32 })], {
      align: AlignmentType.CENTER,
      after: 60,
    }),
    p([run(kpSubtitle(input.kpNo, input.date), { color: GRAY, size: 20 })], {
      align: AlignmentType.CENTER,
      after: 240,
    }),
    p([run(KP_INTRO)]),
  ];

  if (input.aboutModel !== undefined && input.aboutModel.trim() !== "") {
    children.push(p([run(input.aboutModel.trim())]));
  }
  if (input.tagline !== undefined && input.tagline.trim() !== "") {
    children.push(
      p([run(input.tagline.trim(), { bold: true, italics: true, color: BROWN_TITLE, size: 26 })], {
        align: AlignmentType.CENTER,
        before: 160,
        after: 160,
      }),
    );
  }

  children.push(band(input.tableTitle));
  children.push(rowsTable(input.rows, { label: "Цена с НДС", value: kpPriceText(input.priceWithVat) }));

  if (conditions !== null) {
    children.push(new Paragraph({ children: [], spacing: { after: 120 } }));
    children.push(band("Общие условия", { italics: true }));
    children.push(conditionsTable(conditions));
  }

  if (warranty !== null && warranty.lines.length > 0) {
    children.push(new Paragraph({ children: [], spacing: { after: 160 } }));
    children.push(
      new Table({
        width: { size: TW, type: WidthType.DXA },
        rows: [
          new TableRow({
            children: [
              new TableCell({
                children: [
                  p([run(warranty.title, { bold: true, color: BROWN_TITLE, size: 20 })], { align: AlignmentType.LEFT, after: 60 }),
                  ...warranty.lines.map((l) => p([run(l, { size: 20 })], { align: AlignmentType.LEFT, after: 30 })),
                ],
                shading: { fill: CREAM },
                borders: { top: THIN, bottom: THIN, left: THIN, right: THIN },
                margins: { top: 120, bottom: 120, left: 160, right: 160 },
              }),
            ],
          }),
        ],
      }),
    );
  }

  children.push(new Paragraph({ children: [], spacing: { after: 200 } }));
  children.push(band(footer));

  // ── Страницы полных характеристик (как CPD15/CPD20) ──
  if (input.specGroups !== undefined && input.specGroups.length > 0) {
    children.push(new Paragraph({ children: [new PageBreak()] }));
    children.push(band(input.specTitle ?? `ПОЛНЫЕ ТЕХНИЧЕСКИЕ ХАРАКТЕРИСТИКИ  ·  ${input.tableTitle}`));
    for (const g of input.specGroups) {
      children.push(
        new Paragraph({
          children: [run(g.title, { bold: true, color: BROWN_TITLE, size: 20, caps: true })],
          spacing: { before: 160, after: 60 },
        }),
      );
      children.push(rowsTable(g.rows, null));
    }
    children.push(new Paragraph({ children: [], spacing: { after: 200 } }));
    children.push(band(footer));
  }

  return new Document({
    sections: [
      {
        properties: {
          page: { size: A4, margin: MARGINS },
        },
        children,
      },
    ],
  });
}

/** Рендер КП по бланку GLOBERENT в DOCX-буфер. */
export async function renderKpGloberent(input: KpGloberentInput): Promise<Buffer> {
  if ((input.tableTitle ?? "").trim() === "") throw new Error("Нет заголовка таблицы КП");
  if (!Number.isFinite(input.priceWithVat) || input.priceWithVat <= 0) {
    throw new Error("Цена с НДС — число больше нуля");
  }
  return Packer.toBuffer(buildKpDocument(input));
}
