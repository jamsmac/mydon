/**
 * КП «Classic» — коммерческое предложение (DOCX), серверный порт из донора
 * PROMACH: apps/web/src/kp-templates/{types.ts, shared.ts, classic.ts}.
 *
 * Перенос, не переписывание: вёрстка, цвета, шрифты и тексты — дословно из
 * донора. Адаптации против донора:
 *  - реквизиты продавца — параметр `seller` (у донора хардкод DEFAULT_COMPANY
 *    в index.ts); обязательных дефолтов вида «TAS MOTORS» больше нет;
 *  - Packer.toBlob (браузер) → Packer.toBuffer (сервер, Node);
 *  - валютная пара в строке курса параметризована (`rate_pair`; у донора
 *    «UZS/USD» была зашита в текст) — сама валюта цены и курс и у донора
 *    были параметрами (sale_price_currency, rate_conversion);
 *  - партнёрский бренд можно передать входом (`partner_brand`) — каталог
 *    донора PARTNER_BRANDS сохранён как fallback;
 *  - чистый текстовый слой (заголовки, строки таблиц, итоги) вынесен в
 *    отдельные функции — тестируется без docx.
 *
 * НДС в КП донора НЕ фигурирует: итог = sale_price × quantity, налоги не
 * считаются. Поэтому contractTotals/itemBreakdown из @mydon/shared
 * (НДС 12% «изнутри») здесь не используются — семантика не совпадает.
 * Математика КП (скидка как готовый процент, итог за партию) перенесена
 * дословно.
 *
 * Картинок с диска шаблон не тянет (логотипы — текстовые), поэтому параметр
 * imageBuffer не понадобился; фото техники — вместе со вторым шаблоном
 * (modern), позже.
 */

import {
  AlignmentType,
  BorderStyle,
  Document,
  Footer,
  Packer,
  PageNumber,
  PageOrientation,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TabStopPosition,
  TabStopType,
  TextRun,
  VerticalAlign,
  WidthType,
} from "docx";

// ─── Типы входа (порт types.ts донора) ──────────────────────────────────────

/** Покупатель (получатель КП). */
export interface KpClient {
  name: string;
  full_name?: string | null;
  inn?: string | null;
  phone?: string | null;
  address?: string | null;
  contact_person?: string | null;
}

/** Техника: основные характеристики + свободный список «ключ → значение». */
export interface KpVehicle {
  brand: string;
  model: string;
  full_model_name?: string | null;
  configuration?: string | null;
  engine_volume_cc?: number | null;
  engine_power_kw?: number | string | null;
  engine_model?: string | null;
  manufacture_year?: number | null;
  load_capacity_kg?: number | null;
  total_mass_kg?: number | null;
  dimensions_lxwxh?: string | null;
  max_speed_kmh?: number | null;
  fuel_tank_liters?: number | null;
  /** Свободный список «техн. характеристики» ключ → значение. */
  extra_specs?: Array<{ label: string; value: string }>;
  catalog_code?: string | null;
}

/** Ценовой блок КП. Валюта и курс — параметры (как и у донора). */
export interface KpPriceBlock {
  factory_price_usd?: number | null;
  transport_price_usd?: number | null;
  invoice_price_usd?: number | null;
  customs_base_usd?: number | null;
  /** Итоговая цена клиенту в валюте sale_price_currency. */
  sale_price: number;
  /** 'UZS', 'USD' и т.п. */
  sale_price_currency: string;
  /** Показывается, если больше нуля. */
  discount_percent?: number;
  /** Курс для строки «Курс конвертации: …». null/undefined — строки нет. */
  rate_conversion?: number | null;
  /**
   * Валютная пара строки курса, например «UZS/USD».
   * Адаптация: у донора текст «UZS/USD» был зашит; по умолчанию сохранено
   * донорское значение.
   */
  rate_pair?: string;
}

/** Условия предложения. */
export interface KpTerms {
  /** «Срок действия КП — 14 дней». */
  validity_days: number;
  /** «Срок поставки: 30 дней». */
  planned_delivery_days?: number | null;
  /** «Аванс 30%, остаток после поставки». */
  payment_terms?: string;
  /** «Гарантия 12 мес / 1500 моточасов». */
  warranty?: string;
  /** «DAP Ташкент (Incoterms 2020)». */
  delivery_terms?: string;
}

/**
 * Реквизиты продавца — параметр (порт KpCompany; у донора значения были
 * захардкожены константой DEFAULT_COMPANY).
 */
export interface KpSeller {
  name: string;
  /** «ООО». */
  legal_form?: string;
  inn?: string;
  address?: string;
  phone?: string;
  email?: string;
  website?: string;
  /** «Каримов Б.Х.» — для строки подписи. */
  director_name?: string;
  /** «Генеральный директор». */
  director_position?: string;
}

/** Партнёрский бренд для цветной плашки. */
export interface PartnerBrand {
  code: string;
  display_name: string;
  tagline?: string;
  color_hex: string;
  text_logo: string;
}

/** Вход рендера КП «Classic» (порт KpData; company → seller). */
export interface KpClassicInput {
  /** «EST-2026-00012». */
  estimation_no: string;
  title?: string | null;
  /** ISO yyyy-mm-dd. */
  date: string;
  vehicle: KpVehicle;
  quantity: number;
  client: KpClient;
  prices: KpPriceBlock;
  terms: KpTerms;
  seller: KpSeller;
  /** true — показать разбивку завод/транспорт/инвойс/таможня. */
  show_breakdown?: boolean;
  /** Адаптация: бренд можно задать явно, иначе поиск по каталогу донора. */
  partner_brand?: PartnerBrand | null;
}

// ─── Фирменные цвета и размеры (порт shared.ts донора, дословно) ────────────

export const TAS_YELLOW = "FFC72C";
export const TAS_BLACK = "1A1A1A";
export const TAS_GREY = "4A4A4A";
export const TAS_LIGHT = "F5F5F5";
export const TAS_WHITE = "FFFFFF";

/** Ширина контента при полях 1" на A4: 11906 − 2 × 1440 = 9026 DXA. */
export const CONTENT_WIDTH_DXA = 9026;

const FONT = "Cambria";

/** Каталог партнёрских брендов донора (сохранён дословно как fallback). */
export const PARTNER_BRANDS: Record<string, PartnerBrand> = {
  XCMG:    { code: "XCMG",    display_name: "XCMG Construction Machinery", tagline: "Лидер строительной техники Китая", color_hex: "C0392B", text_logo: "XCMG" },
  SHACMAN: { code: "SHACMAN", display_name: "SHACMAN",                     tagline: "Тяжёлая коммерческая техника",     color_hex: "D32F2F", text_logo: "SHACMAN" },
  WEICHAI: { code: "WEICHAI", display_name: "WEICHAI Power",               tagline: "Двигатели и силовые установки",     color_hex: "1976D2", text_logo: "WEICHAI" },
  SHANTUI: { code: "SHANTUI", display_name: "SHANTUI",                     tagline: "Бульдозеры и грейдеры",             color_hex: "F57C00", text_logo: "SHANTUI" },
  CIMC:    { code: "CIMC",    display_name: "CIMC Vehicles",               tagline: "Прицепы и контейнеры",              color_hex: "00796B", text_logo: "CIMC" },
  FAW:     { code: "FAW",     display_name: "FAW Trucks",                  tagline: "Грузовая техника",                  color_hex: "B71C1C", text_logo: "FAW" },
  SANY:    { code: "SANY",    display_name: "SANY Heavy Industry",         tagline: "Промышленная и строительная техника", color_hex: "C62828", text_logo: "SANY" },
};

/** Поиск бренда без учёта регистра и пробелов. */
export function getPartnerBrand(brand: string | null | undefined): PartnerBrand | null {
  if (!brand) return null;
  const key = brand.toUpperCase().replace(/\s+/g, "");
  return PARTNER_BRANDS[key] || null;
}

// ─── Чистый текстовый слой (без docx — тестируется напрямую) ────────────────

/** Число в русском формате: «12 500 000» (Intl, как у донора). */
export function fmtRu(n: number, decimals = 0): string {
  return new Intl.NumberFormat("ru-RU", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(n);
}

/**
 * Донорский fmtMoney: сумма + код валюты, по умолчанию без копеек —
 * «12 500 000 UZS». Отличается от fmtMoney из @mydon/shared (там всегда
 * 2 знака и без кода валюты) — это формат именно КП, перенесён дословно.
 */
export function fmtKpMoney(n: number, currency = "UZS", decimals = 0): string {
  return fmtRu(n, decimals) + " " + currency;
}

/** «2026-05-11» → «11 мая 2026 г.». */
export function fmtDateLong(s: string): string {
  if (!s) return "";
  const d = new Date(s);
  if (isNaN(d.getTime())) return s;
  const months = [
    "января", "февраля", "марта", "апреля",
    "мая", "июня", "июля", "августа",
    "сентября", "октября", "ноября", "декабря",
  ];
  return `${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()} г.`;
}

/** Русское склонение: forms = [один, несколько, много]. */
export function plural(n: number, forms: [string, string, string]): string {
  const m10 = Math.abs(n) % 10;
  const m100 = Math.abs(n) % 100;
  if (m100 >= 11 && m100 <= 19) return forms[2];
  if (m10 === 1) return forms[0];
  if (m10 >= 2 && m10 <= 4) return forms[1];
  return forms[2];
}

/** «день/дня/дней». */
export function dayWord(n: number): string {
  return plural(n, ["день", "дня", "дней"]);
}

/** Заголовок документа. */
export const KP_TITLE = "КОММЕРЧЕСКОЕ ПРЕДЛОЖЕНИЕ";

/** Подзаголовок: явный title либо «Бренд — Модель — Конфигурация». */
export function kpSubtitle(data: Pick<KpClassicInput, "title" | "vehicle">): string {
  return (
    data.title ||
    [data.vehicle.brand, data.vehicle.model, data.vehicle.configuration]
      .filter(Boolean)
      .join(" — ")
  );
}

/** Пара «метка → значение» текстового слоя. */
export interface KpPair {
  label: string;
  value: string;
}

/**
 * Строки таблицы характеристик: фильтрация пустых и форматирование значений —
 * дословно из buildSpecRows донора (без docx-обёртки).
 */
export function buildSpecPairs(v: KpVehicle): KpPair[] {
  const rows: Array<[string, string | null | undefined]> = [
    ["Бренд", v.brand],
    ["Модель", v.full_model_name || v.model],
    ["Конфигурация", v.configuration],
    ["Год выпуска", v.manufacture_year ? String(v.manufacture_year) : null],
    ["Объём двигателя", v.engine_volume_cc ? `${fmtRu(v.engine_volume_cc)} см³` : null],
    ["Мощность двигателя", v.engine_power_kw != null && v.engine_power_kw !== "" ? `${v.engine_power_kw} кВт` : null],
    ["Модель двигателя", v.engine_model],
    ["Грузоподъёмность", v.load_capacity_kg ? `${fmtRu(v.load_capacity_kg)} кг` : null],
    ["Полная масса", v.total_mass_kg ? `${fmtRu(v.total_mass_kg)} кг` : null],
    ["Габариты Д×Ш×В", v.dimensions_lxwxh],
    ["Макс. скорость", v.max_speed_kmh ? `${v.max_speed_kmh} км/ч` : null],
    ["Топливный бак", v.fuel_tank_liters ? `${v.fuel_tank_liters} л` : null],
  ];
  for (const xs of v.extra_specs || []) {
    rows.push([xs.label, xs.value]);
  }
  const result: KpPair[] = [];
  for (const [label, value] of rows) {
    if (value == null || value === "") continue;
    result.push({ label, value: String(value) });
  }
  return result;
}

/** Строки разбивки цены (завод/транспорт/инвойс/таможня) — в USD с копейками. */
export function priceBreakdownPairs(p: KpPriceBlock): KpPair[] {
  const rows: KpPair[] = [];
  if (p.factory_price_usd != null) rows.push({ label: "Заводская цена", value: fmtKpMoney(p.factory_price_usd, "USD", 2) });
  if (p.transport_price_usd != null) rows.push({ label: "Транспорт до Узбекистана", value: fmtKpMoney(p.transport_price_usd, "USD", 2) });
  if (p.invoice_price_usd != null) rows.push({ label: "Инвойс", value: fmtKpMoney(p.invoice_price_usd, "USD", 2) });
  if (p.customs_base_usd != null) rows.push({ label: "Таможенная стоимость (база)", value: fmtKpMoney(p.customs_base_usd, "USD", 2) });
  return rows;
}

/** Тексты итогового блока КП. */
export interface KpTotalsText {
  /** «Скидка: −5.0%» либо null, если скидки нет. */
  discount: string | null;
  /** Цена за единицу: «12 500 000 UZS». */
  unit: string;
  /** «Количество: 2 единицы». */
  qty: string;
  /** Итог за партию: «25 000 000 UZS». */
  total: string;
  /** «Курс конвертации: 12 500 UZS/USD» либо null. */
  rate: string | null;
}

/**
 * Итоги КП — математика донора дословно: итог = sale_price × qty, скидка
 * приходит готовым процентом (только отображается). НДС в КП нет, поэтому
 * contractTotals из @mydon/shared здесь неприменим.
 */
export function totalsText(p: KpPriceBlock, quantity: number): KpTotalsText {
  return {
    discount:
      p.discount_percent && p.discount_percent > 0
        ? `Скидка: −${p.discount_percent.toFixed(1)}%`
        : null,
    unit: fmtKpMoney(p.sale_price, p.sale_price_currency),
    qty: `Количество: ${quantity} ${plural(quantity, ["единица", "единицы", "единиц"])}`,
    total: fmtKpMoney(p.sale_price * quantity, p.sale_price_currency),
    rate:
      p.rate_conversion
        ? `Курс конвертации: ${fmtRu(p.rate_conversion)} ${p.rate_pair || "UZS/USD"}`
        : null,
  };
}

/** Строки раздела «Условия» — дефолтные формулировки донора сохранены. */
export function termsPairs(t: KpTerms): KpPair[] {
  const out: KpPair[] = [];
  out.push({ label: "Срок действия КП", value: `${t.validity_days} ${dayWord(t.validity_days)}` });
  if (t.planned_delivery_days != null) {
    out.push({ label: "Срок поставки", value: `${t.planned_delivery_days} ${dayWord(t.planned_delivery_days)}` });
  }
  out.push({ label: "Условия оплаты", value: t.payment_terms || "Аванс 30%, остаток после поставки" });
  out.push({ label: "Гарантия", value: t.warranty || "12 месяцев / 1 500 моточасов" });
  out.push({ label: "Условия поставки", value: t.delivery_terms || "DAP Ташкент, Incoterms 2020" });
  return out;
}

/** Юридическая строка внизу документа: «ООО «…» · ИНН: … · адрес · телефон». */
export function legalLineText(seller: KpSeller): string {
  const parts: string[] = [];
  if (seller.legal_form) parts.push(`${seller.legal_form} «${seller.name}»`);
  else parts.push(seller.name);
  if (seller.inn) parts.push(`ИНН: ${seller.inn}`);
  if (seller.address) parts.push(seller.address);
  if (seller.phone) parts.push(seller.phone);
  return parts.join(" · ");
}

// ─── Docx-хелперы (порт shared.ts донора) ───────────────────────────────────

/** Пустой абзац (вертикальный отступ). */
function emptyParagraph(): Paragraph {
  return new Paragraph({ children: [new TextRun({ text: "" })] });
}

const NO_BORDER = {
  top:    { style: BorderStyle.NONE, size: 0, color: "auto" },
  bottom: { style: BorderStyle.NONE, size: 0, color: "auto" },
  left:   { style: BorderStyle.NONE, size: 0, color: "auto" },
  right:  { style: BorderStyle.NONE, size: 0, color: "auto" },
};

/**
 * Верхняя чёрная плашка с именем продавца и контактами + золотая линия.
 * Адаптация: фолбэк «TAS MOTORS» убран — имя берётся из seller.name.
 */
function makeHeaderBar(seller: KpSeller, accentColor: string): Paragraph[] {
  const phone = seller.phone || "";
  const site = seller.website || "";
  return [
    new Paragraph({
      tabStops: [{ type: TabStopType.RIGHT, position: TabStopPosition.MAX }],
      shading: { fill: TAS_BLACK, type: ShadingType.CLEAR, color: "auto" },
      spacing: { before: 0, after: 80 },
      children: [
        new TextRun({
          text: seller.name.toUpperCase(),
          bold: true,
          size: 32,
          color: TAS_YELLOW,
          font: FONT,
        }),
        new TextRun({
          text: `\t${phone}${phone && site ? "   ·   " : ""}${site}`,
          size: 18,
          color: TAS_WHITE,
          font: FONT,
        }),
      ],
    }),
    new Paragraph({
      border: {
        bottom: { color: accentColor, size: 18, style: BorderStyle.SINGLE, space: 1 },
      },
      spacing: { before: 0, after: 120 },
      children: [new TextRun({ text: "" })],
    }),
  ];
}

/** Строка «ключ: значение» таблицы характеристик с серой нижней границей. */
function specsRow(label: string, value: string, opts?: { shaded?: boolean }): TableRow {
  const fill = opts?.shaded ? TAS_LIGHT : TAS_WHITE;
  const border = { color: "D0D0D0", size: 4, style: BorderStyle.SINGLE };
  return new TableRow({
    children: [
      new TableCell({
        width: { size: 3500, type: WidthType.DXA },
        shading: { fill, type: ShadingType.CLEAR, color: "auto" },
        borders: { ...NO_BORDER, bottom: border },
        margins: { top: 80, bottom: 80, left: 120, right: 120 },
        verticalAlign: VerticalAlign.CENTER,
        children: [new Paragraph({
          children: [new TextRun({ text: label, size: 20, color: TAS_GREY, font: FONT })],
        })],
      }),
      new TableCell({
        width: { size: CONTENT_WIDTH_DXA - 3500, type: WidthType.DXA },
        shading: { fill, type: ShadingType.CLEAR, color: "auto" },
        borders: { ...NO_BORDER, bottom: border },
        margins: { top: 80, bottom: 80, left: 120, right: 120 },
        verticalAlign: VerticalAlign.CENTER,
        children: [new Paragraph({
          children: [new TextRun({ text: value, size: 22, bold: true, color: TAS_BLACK, font: FONT })],
        })],
      }),
    ],
  });
}

/** Подпись + место печати: две колонки над золотой линией. */
function makeFooterSignature(seller: KpSeller): Table {
  const sigCellChildren: Paragraph[] = [
    new Paragraph({
      spacing: { before: 0, after: 40 },
      children: [new TextRun({
        text: seller.director_position || "Генеральный директор",
        size: 22,
        color: TAS_BLACK,
        font: FONT,
      })],
    }),
    new Paragraph({ children: [new TextRun({ text: "" })] }),
    new Paragraph({
      spacing: { before: 0, after: 40 },
      children: [new TextRun({
        text: "________________________",
        size: 22,
        color: TAS_BLACK,
        font: FONT,
      })],
    }),
    new Paragraph({
      children: [new TextRun({
        text: seller.director_name || "",
        size: 20,
        color: TAS_GREY,
        font: FONT,
      })],
    }),
  ];

  const sealCellChildren: Paragraph[] = [
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 400, after: 40 },
      children: [new TextRun({
        text: "М.П.",
        bold: true,
        size: 20,
        color: TAS_GREY,
        font: FONT,
      })],
    }),
  ];

  const yellowTop = { color: TAS_YELLOW, size: 18, style: BorderStyle.SINGLE };
  const noB = { color: "auto", size: 0, style: BorderStyle.NONE };
  const leftWidth = Math.floor(CONTENT_WIDTH_DXA * 0.65);

  return new Table({
    width: { size: CONTENT_WIDTH_DXA, type: WidthType.DXA },
    columnWidths: [leftWidth, CONTENT_WIDTH_DXA - leftWidth],
    borders: {
      top: yellowTop,
      bottom: noB,
      left: noB,
      right: noB,
      insideHorizontal: noB,
      insideVertical: noB,
    },
    rows: [
      new TableRow({
        children: [
          new TableCell({
            width: { size: leftWidth, type: WidthType.DXA },
            borders: { ...NO_BORDER, top: yellowTop },
            margins: { top: 160, bottom: 80, left: 120, right: 120 },
            children: sigCellChildren,
          }),
          new TableCell({
            width: { size: CONTENT_WIDTH_DXA - leftWidth, type: WidthType.DXA },
            borders: { ...NO_BORDER, top: yellowTop },
            margins: { top: 160, bottom: 80, left: 120, right: 120 },
            verticalAlign: VerticalAlign.CENTER,
            children: sealCellChildren,
          }),
        ],
      }),
    ],
  });
}

/** Заголовок раздела с золотой нижней границей. */
function sectionTitle(text: string): Paragraph {
  return new Paragraph({
    spacing: { before: 240, after: 80 },
    border: {
      bottom: { color: TAS_YELLOW, size: 12, style: BorderStyle.SINGLE, space: 1 },
    },
    children: [new TextRun({
      text: text.toUpperCase(),
      bold: true,
      size: 22,
      color: TAS_BLACK,
      font: FONT,
      characterSpacing: 30,
    })],
  });
}

/** Юридическая строка внизу (курсив, по центру). */
function legalLine(seller: KpSeller): Paragraph {
  return new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { before: 200, after: 0 },
    children: [new TextRun({
      text: legalLineText(seller),
      size: 16,
      color: TAS_GREY,
      font: FONT,
      italics: true,
    })],
  });
}

// ─── Блоки шаблона (порт classic.ts донора) ─────────────────────────────────

/** Блок получателя: «Кому», контактное лицо, ИНН, адрес. */
function recipientBlock(data: KpClassicInput): Paragraph[] {
  const c = data.client;
  const rows: Paragraph[] = [];
  rows.push(new Paragraph({
    spacing: { before: 0, after: 40 },
    children: [
      new TextRun({ text: "Кому: ", size: 22, color: TAS_GREY, font: FONT }),
      new TextRun({ text: c.full_name || c.name, size: 22, bold: true, color: TAS_BLACK, font: FONT }),
    ],
  }));
  const optional: Array<[string, string | null | undefined]> = [
    ["Контактное лицо: ", c.contact_person],
    ["ИНН: ", c.inn],
    ["Адрес: ", c.address],
  ];
  for (const [label, value] of optional) {
    if (!value) continue;
    rows.push(new Paragraph({
      spacing: { before: 0, after: 40 },
      children: [
        new TextRun({ text: label, size: 20, color: TAS_GREY, font: FONT }),
        new TextRun({ text: value, size: 20, color: TAS_BLACK, font: FONT }),
      ],
    }));
  }
  rows.push(emptyParagraph());
  return rows;
}

/** Титул: «КОММЕРЧЕСКОЕ ПРЕДЛОЖЕНИЕ» + подзаголовок с золотой линией. */
function titleBlock(data: KpClassicInput): Paragraph[] {
  return [
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 120, after: 40 },
      children: [new TextRun({
        text: KP_TITLE,
        bold: true,
        size: 40,
        color: TAS_BLACK,
        font: FONT,
        characterSpacing: 30,
      })],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 0, after: 80 },
      border: {
        bottom: { color: TAS_YELLOW, size: 12, style: BorderStyle.SINGLE, space: 1 },
      },
      children: [new TextRun({
        text: kpSubtitle(data),
        size: 24,
        italics: true,
        color: TAS_GREY,
        font: FONT,
      })],
    }),
    emptyParagraph(),
  ];
}

/** Плашка партнёрского бренда (текстовый логотип; картинок с диска нет). */
function partnerBrandStrip(data: KpClassicInput): Table | null {
  // Адаптация: явный partner_brand из входа приоритетнее каталога донора.
  const brand = data.partner_brand ?? getPartnerBrand(data.vehicle.brand);
  if (!brand) return null;

  const leftWidth = Math.floor(CONTENT_WIDTH_DXA * 0.6);
  const rightWidth = CONTENT_WIDTH_DXA - leftWidth;
  const black = { style: BorderStyle.SINGLE, size: 4, color: TAS_BLACK };

  return new Table({
    width: { size: CONTENT_WIDTH_DXA, type: WidthType.DXA },
    columnWidths: [leftWidth, rightWidth],
    borders: {
      top: black,
      bottom: black,
      left: black,
      right: black,
      insideHorizontal: { style: BorderStyle.NONE, size: 0, color: "auto" },
      insideVertical: black,
    },
    rows: [
      new TableRow({
        children: [
          new TableCell({
            width: { size: leftWidth, type: WidthType.DXA },
            shading: { fill: TAS_BLACK, type: ShadingType.CLEAR, color: "auto" },
            margins: { top: 200, bottom: 200, left: 240, right: 200 },
            verticalAlign: VerticalAlign.CENTER,
            children: [
              new Paragraph({
                spacing: { before: 0, after: 40 },
                children: [new TextRun({
                  text: brand.text_logo,
                  bold: true,
                  size: 64,
                  color: TAS_YELLOW,
                  font: FONT,
                  characterSpacing: 40,
                })],
              }),
              new Paragraph({
                children: [new TextRun({
                  text: brand.display_name,
                  size: 18,
                  color: TAS_WHITE,
                  font: FONT,
                })],
              }),
            ],
          }),
          new TableCell({
            width: { size: rightWidth, type: WidthType.DXA },
            shading: { fill: TAS_YELLOW, type: ShadingType.CLEAR, color: "auto" },
            margins: { top: 200, bottom: 200, left: 200, right: 200 },
            verticalAlign: VerticalAlign.CENTER,
            children: [
              new Paragraph({
                spacing: { before: 0, after: 60 },
                children: [new TextRun({
                  text: brand.tagline || "",
                  bold: true,
                  size: 22,
                  color: TAS_BLACK,
                  font: FONT,
                })],
              }),
              new Paragraph({
                children: [new TextRun({
                  text: "Официальный дилер в Узбекистане",
                  size: 18,
                  color: TAS_BLACK,
                  font: FONT,
                  italics: true,
                })],
              }),
            ],
          }),
        ],
      }),
    ],
  });
}

/** Таблица характеристик (чередующаяся заливка строк). */
function specsTable(v: KpVehicle): Table {
  return new Table({
    width: { size: CONTENT_WIDTH_DXA, type: WidthType.DXA },
    columnWidths: [3500, CONTENT_WIDTH_DXA - 3500],
    borders: {
      ...NO_BORDER,
      insideHorizontal: { style: BorderStyle.NONE, size: 0, color: "auto" },
      insideVertical:   { style: BorderStyle.NONE, size: 0, color: "auto" },
    },
    rows: buildSpecPairs(v).map((pair, i) =>
      specsRow(pair.label, pair.value, { shaded: i % 2 === 1 }),
    ),
  });
}

/** Таблица разбивки цены (если show_breakdown). */
function priceBreakdownTable(data: KpClassicInput): Table {
  const leftWidth = Math.floor(CONTENT_WIDTH_DXA * 0.65);
  const greyBottom = { style: BorderStyle.SINGLE, size: 4, color: "D0D0D0" };

  const trs: TableRow[] = priceBreakdownPairs(data.prices).map((pair, i) => new TableRow({
    children: [
      new TableCell({
        width: { size: leftWidth, type: WidthType.DXA },
        shading: { fill: i % 2 === 1 ? TAS_LIGHT : TAS_WHITE, type: ShadingType.CLEAR, color: "auto" },
        borders: { ...NO_BORDER, bottom: greyBottom },
        margins: { top: 60, bottom: 60, left: 120, right: 120 },
        children: [new Paragraph({
          children: [new TextRun({ text: pair.label, size: 20, color: TAS_GREY, font: FONT })],
        })],
      }),
      new TableCell({
        width: { size: CONTENT_WIDTH_DXA - leftWidth, type: WidthType.DXA },
        shading: { fill: i % 2 === 1 ? TAS_LIGHT : TAS_WHITE, type: ShadingType.CLEAR, color: "auto" },
        borders: { ...NO_BORDER, bottom: greyBottom },
        margins: { top: 60, bottom: 60, left: 120, right: 120 },
        children: [new Paragraph({
          alignment: AlignmentType.RIGHT,
          children: [new TextRun({ text: pair.value, size: 20, bold: true, color: TAS_BLACK, font: FONT })],
        })],
      }),
    ],
  }));

  return new Table({
    width: { size: CONTENT_WIDTH_DXA, type: WidthType.DXA },
    columnWidths: [leftWidth, CONTENT_WIDTH_DXA - leftWidth],
    borders: {
      ...NO_BORDER,
      insideHorizontal: { style: BorderStyle.NONE, size: 0, color: "auto" },
      insideVertical:   { style: BorderStyle.NONE, size: 0, color: "auto" },
    },
    rows: trs,
  });
}

/** Жёлтый итоговый блок: скидка, цена за единицу, количество, итог, курс. */
function mainTotalBlock(data: KpClassicInput): Table {
  const t = totalsText(data.prices, data.quantity);
  const innerParas: Paragraph[] = [];

  if (t.discount) {
    innerParas.push(new Paragraph({
      alignment: AlignmentType.RIGHT,
      spacing: { before: 0, after: 40 },
      children: [new TextRun({
        text: t.discount,
        bold: true,
        size: 22,
        color: "C0392B",
        font: FONT,
      })],
    }));
  }

  innerParas.push(new Paragraph({
    spacing: { before: 0, after: 60 },
    children: [
      new TextRun({ text: "ИТОГО за единицу:  ", size: 24, color: TAS_BLACK, font: FONT }),
      new TextRun({ text: t.unit, bold: true, size: 44, color: TAS_BLACK, font: FONT }),
    ],
  }));
  innerParas.push(new Paragraph({
    spacing: { before: 0, after: 40 },
    children: [new TextRun({ text: t.qty, size: 20, color: TAS_BLACK, font: FONT })],
  }));
  innerParas.push(new Paragraph({
    spacing: { before: 0, after: 0 },
    children: [
      new TextRun({ text: "ИТОГО за всю партию:  ", size: 24, bold: true, color: TAS_BLACK, font: FONT }),
      new TextRun({ text: t.total, bold: true, size: 36, color: TAS_BLACK, font: FONT }),
    ],
  }));

  if (t.rate) {
    innerParas.push(new Paragraph({
      spacing: { before: 120, after: 0 },
      children: [new TextRun({
        text: t.rate,
        size: 18,
        italics: true,
        color: TAS_GREY,
        font: FONT,
      })],
    }));
  }

  const thickBlack = { style: BorderStyle.SINGLE, size: 18, color: TAS_BLACK };
  return new Table({
    width: { size: CONTENT_WIDTH_DXA, type: WidthType.DXA },
    columnWidths: [CONTENT_WIDTH_DXA],
    borders: {
      top: thickBlack,
      bottom: thickBlack,
      left: thickBlack,
      right: thickBlack,
      insideHorizontal: { style: BorderStyle.NONE, size: 0, color: "auto" },
      insideVertical:   { style: BorderStyle.NONE, size: 0, color: "auto" },
    },
    rows: [
      new TableRow({
        children: [
          new TableCell({
            width: { size: CONTENT_WIDTH_DXA, type: WidthType.DXA },
            shading: { fill: TAS_YELLOW, type: ShadingType.CLEAR, color: "auto" },
            margins: { top: 240, bottom: 240, left: 240, right: 240 },
            children: innerParas,
          }),
        ],
      }),
    ],
  });
}

/** Раздел «Условия» — маркированный список с золотыми точками. */
function termsList(data: KpClassicInput): Paragraph[] {
  return termsPairs(data.terms).map((pair) => new Paragraph({
    spacing: { before: 0, after: 60 },
    children: [
      new TextRun({ text: "•  ", size: 22, color: TAS_YELLOW, bold: true, font: FONT }),
      new TextRun({ text: `${pair.label}: `, size: 22, color: TAS_GREY, font: FONT }),
      new TextRun({ text: pair.value, size: 22, bold: true, color: TAS_BLACK, font: FONT }),
    ],
  }));
}

/** Дата и номер КП справа вверху. */
function dateAndNoBlock(data: KpClassicInput): Paragraph[] {
  return [
    new Paragraph({
      alignment: AlignmentType.RIGHT,
      spacing: { before: 0, after: 20 },
      children: [new TextRun({
        text: fmtDateLong(data.date),
        size: 22,
        bold: true,
        color: TAS_BLACK,
        font: FONT,
      })],
    }),
    new Paragraph({
      alignment: AlignmentType.RIGHT,
      spacing: { before: 0, after: 200 },
      children: [new TextRun({
        text: `№ ${data.estimation_no}`,
        size: 18,
        color: TAS_GREY,
        font: "Consolas",
      })],
    }),
  ];
}

// ─── Рендер ─────────────────────────────────────────────────────────────────

/**
 * Собирает DOCX КП «Classic» и возвращает Buffer (донор возвращал Blob —
 * адаптация под сервер: Packer.toBlob → Packer.toBuffer).
 */
export async function renderKpClassic(input: KpClassicInput): Promise<Buffer> {
  const children: Array<Paragraph | Table> = [];

  // 1. Плашка продавца
  children.push(...makeHeaderBar(input.seller, TAS_YELLOW));

  // 2. Дата + номер, справа
  children.push(...dateAndNoBlock(input));

  // 3. Получатель
  children.push(...recipientBlock(input));

  // 4. Титул
  children.push(...titleBlock(input));

  // 5. Плашка партнёрского бренда
  const partnerStrip = partnerBrandStrip(input);
  if (partnerStrip) {
    children.push(partnerStrip);
    children.push(emptyParagraph());
  }

  // 6. Характеристики
  children.push(sectionTitle("Технические характеристики"));
  children.push(specsTable(input.vehicle));

  // 7. Цена
  children.push(sectionTitle("Стоимость предложения"));
  if (input.show_breakdown) {
    children.push(priceBreakdownTable(input));
    children.push(emptyParagraph());
  }
  children.push(mainTotalBlock(input));

  // 8. Условия
  children.push(sectionTitle("Условия"));
  children.push(...termsList(input));

  // 9. Подпись и юридическая строка
  children.push(emptyParagraph());
  children.push(makeFooterSignature(input.seller));
  children.push(legalLine(input.seller));

  const doc = new Document({
    creator: input.seller.name,
    title: `КП ${input.estimation_no}`,
    styles: {
      default: {
        document: {
          run: { font: FONT, size: 22, color: TAS_BLACK },
        },
      },
    },
    sections: [
      {
        properties: {
          page: {
            size: { width: 11906, height: 16838, orientation: PageOrientation.PORTRAIT },
            margin: { top: 1440, bottom: 1440, left: 1440, right: 1440 },
          },
        },
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                alignment: AlignmentType.RIGHT,
                tabStops: [{ type: TabStopType.RIGHT, position: TabStopPosition.MAX }],
                children: [
                  new TextRun({ text: "Стр. ", size: 16, color: TAS_GREY, font: FONT }),
                  new TextRun({ children: [PageNumber.CURRENT], size: 16, color: TAS_GREY, font: FONT }),
                  new TextRun({ text: " из ", size: 16, color: TAS_GREY, font: FONT }),
                  new TextRun({ children: [PageNumber.TOTAL_PAGES], size: 16, color: TAS_GREY, font: FONT }),
                ],
              }),
            ],
          }),
        },
        children,
      },
    ],
  });

  return Packer.toBuffer(doc);
}
