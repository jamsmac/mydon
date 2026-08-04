/**
 * DOCX-генерация UZS-договора купли-продажи — перенос из PROMACH
 * (apps/web/src/ContractModule.tsx, generateDocx() + хелперы mkP/mkT/mkCell/
 * mkSection/mkClause/dateRu/warrantyClause). Структура документа, тексты
 * пунктов и форматирование — дословно из донора.
 *
 * Отличия от донора (осознанные, по спеке переноса §6):
 *  - продавец НЕ захардкожен — реквизиты приходят параметром `seller`
 *    (карточка own_company реестра);
 *  - гарантийный сервис — параметр `serviceCompany` (у донора был хардкод);
 *  - ставка НДС в ТЕКСТАХ — параметр `vatRatePct` (по умолчанию 12); формулы
 *    «НДС изнутри» (×12/112) НЕ дублируются — берутся из @mydon/shared;
 *  - единица измерения позиции — из items[].unit (у донора хардкод «шт»),
 *    с дефолтом «шт».
 *
 * Модуль разделён на два слоя:
 *  (а) чистые функции сборки ТЕКСТОВ пунктов — без docx, тестируемы напрямую;
 *  (б) сборка Document из этих текстов с форматированием донора
 *      (Times New Roman, 12pt / 10pt таблицы, A4 11906×16838 DXA,
 *      поля 1134/850/1134/1701, шапки таблиц заливка 1a2744).
 */
import {
  AlignmentType,
  BorderStyle,
  Document,
  Packer,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  VerticalAlign,
  WidthType,
} from "docx";
import {
  contractTotals,
  fmtMoney,
  installmentSchedule,
  itemBreakdown,
  trancheAmount,
  type ContractItem,
} from "@mydon/shared";

// ============================================================================
// ТИПЫ ВХОДА
// ============================================================================

/** Реквизиты стороны договора (продавец и покупатель — одна форма). */
export interface ContractParty {
  name: string;
  director: string;
  inn: string;
  address: string;
  account: string;
  bank: string;
  mfo: string;
  oked: string;
  nds: string;
  phone: string;
}

/** Порядок оплаты (как в доноре). */
export type PayType = "100" | "partial" | "install" | "post";

/** Режим гарантии (донор: warranty === "spec" | "self" | свой текст). */
export type WarrantyMode = "spec" | "self" | "custom";

/** Транш частичной оплаты (донор: Tranche). */
export interface PartialTranche {
  pct: number;
  days: number;
  event: "after_signing" | "after_delivery";
}

/** Параметры документа (contract.doc_params — у донора жили только в state формы). */
export interface ContractDocParams {
  /** Срок оплаты, банковских дней (п.3.1). */
  payDays: number;
  /** Первоначальный взнос, % (рассрочка). */
  prepayPct: number;
  /** Число месяцев рассрочки. */
  installMonths: number;
  /** Ставка рассрочки, % годовых (0 — равные платежи, иначе аннуитет). */
  installInterest: number;
  /** Дата первого платежа рассрочки, YYYY-MM-DD. */
  installFirstDate?: string;
  /** Транши частичной оплаты. */
  partialTranches: PartialTranche[];
  /** Пеня Продавца, %/день (п.8.1). */
  penaSeller: number;
  /** Пеня Покупателя, %/день (п.8.2). */
  penaBuyer: number;
  /** Потолок пени, % (п.8.1/8.2). */
  penaMax: number;
  /** Число экземпляров (п.11.2). */
  copies: number;
  /** Режим гарантии (п.5.1). */
  warrantyMode: WarrantyMode;
  /** Свой текст гарантии при warrantyMode='custom'. */
  warrantyCustom?: string;
}

/** Вход рендера договора. */
export interface ContractDocxInput {
  contractNo: string;
  /** Дата договора, YYYY-MM-DD. */
  contractDate: string;
  buyer: Partial<ContractParty> & Pick<ContractParty, "name">;
  seller: ContractParty;
  items: ContractItem[];
  payType: PayType;
  docParams: ContractDocParams;
  /** Срок самовывоза, банковских дней (п.6.1). */
  deliveryDays: number;
  /** Гарантийный сервис (п.5.2); у донора был хардкод. */
  serviceCompany?: string;
  /** Ставка НДС в текстах, % (формулы shared фиксируют 12/112). */
  vatRatePct?: number;
}

// ============================================================================
// СЛОЙ (а): ЧИСТЫЕ ТЕКСТЫ ПУНКТОВ — без docx
// ============================================================================

/** Гарантийный сервис по умолчанию — прежнее значение донора, теперь заменяемое. */
const DEFAULT_SERVICE_COMPANY = "ООО «TAS MOTORS»";

/** Ставка НДС в текстах по умолчанию. */
const DEFAULT_VAT_RATE_PCT = 12;

/** fmt донора (ContractModule.tsx:401) — единый источник в @mydon/shared. */
const fmt = fmtMoney;

/** ««4» августа 2026 г.» — дословно донор (ContractModule.tsx:403). */
export function dateRu(d: string): string {
  const months = [
    "января", "февраля", "марта", "апреля", "мая", "июня",
    "июля", "августа", "сентября", "октября", "ноября", "декабря",
  ];
  const dt = new Date(d);
  return `«${dt.getDate()}» ${months[dt.getMonth()]} ${dt.getFullYear()} г.`;
}

/** Заголовок документа; суффикс «/ОП» — только рендер, в БД его нет. */
export function contractTitle(contractNo: string): string {
  return `ДОГОВОР КУПЛИ-ПРОДАЖИ № ${contractNo || "__"}/ОП`;
}

/** Сегмент преамбулы: текст + жирность (донор собирал её из TextRun'ов). */
export interface TextSegment {
  text: string;
  bold: boolean;
}

/** Преамбула (донор, строка 1383) — продавец из параметра, не из хардкода. */
export function preambleSegments(
  seller: Pick<ContractParty, "name" | "director">,
  buyer: { name?: string; director?: string },
): TextSegment[] {
  return [
    { text: seller.name, bold: true },
    { text: ", именуемое в дальнейшем «Продавец», в лице Директора ", bold: false },
    { text: seller.director, bold: true },
    { text: ", действующего на основании Устава с одной стороны, и ", bold: false },
    { text: buyer.name || "________________", bold: true },
    { text: " именуемое в дальнейшем «Покупатель», в лице директора ", bold: false },
    { text: buyer.director || "________________", bold: true },
    {
      text: ", действующего на основании Устава с другой стороны, заключили настоящий Договор о нижеследующем:",
      bold: false,
    },
  ];
}

/** п.2.1 (донор, строка 1389): общая сумма с НДС «изнутри». */
export function sumClauseText(totalWithVat: number, totalVat: number, vatRatePct: number): string {
  return `Общая сумма: ${fmt(totalWithVat)} сум, включая НДС ${vatRatePct}% — ${fmt(totalVat)} сум.`;
}

/** п.3.1 — ведущий абзац + (для рассрочки) помесячный список платежей. */
export interface PaymentClauseTexts {
  lead: string;
  /** «— первый платеж: … сум, до … г.» — только для рассрочки с датой. */
  items: string[];
}

/**
 * п.3.1 по payType — дословно paymentText() донора (строки 445–480) плюс
 * многопараграфная ветка рассрочки из generateDocx() (строки 1315–1342).
 * Расчёты рассрочки/траншей — installmentSchedule/trancheAmount из shared.
 */
export function paymentClauseTexts(
  totalWithVat: number,
  payType: PayType,
  p: ContractDocParams,
): PaymentClauseTexts {
  const total = totalWithVat;
  const pct = p.prepayPct || 0;
  if (payType === "100") {
    return {
      lead: `Покупатель обязуется произвести оплату 100% (${fmt(total)} сум) в течение ${p.payDays} банковских дней с даты подписания Договора.`,
      items: [],
    };
  }
  if (payType === "partial") {
    const eventLabel: Record<PartialTranche["event"], string> = {
      after_signing: "с даты подписания Договора",
      after_delivery: "после поставки Товара",
    };
    const parts = p.partialTranches
      .filter((t) => (t.pct || 0) > 0)
      .map((t, i) => {
        const tp = t.pct || 0;
        const amount = trancheAmount(total, tp);
        return `(${i + 1}) ${tp}% (${fmt(amount)} сум) в течение ${t.days} банковских дней ${eventLabel[t.event]}`;
      });
    if (parts.length === 0) return { lead: `Оплата траншами (не настроено).`, items: [] };
    return { lead: `Оплата производится траншами: ${parts.join("; ")}.`, items: [] };
  }
  if (payType === "install") {
    const months = p.installMonths || 0;
    const prepay = (total * pct) / 100;
    const remaining = total - prepay;
    const annualRate = p.installInterest || 0;
    const rateStr = annualRate > 0 ? ` под ${annualRate}% годовых` : "";
    // Многопараграфная ветка донора: месяцы и дата заданы, остаток положителен.
    if (months > 0 && p.installFirstDate && remaining > 0) {
      const rows = installmentSchedule({
        totalWithVat: total,
        prepayPct: pct,
        months,
        annualRatePct: annualRate,
        firstDate: new Date(p.installFirstDate),
      });
      const lead = `Первоначальный взнос ${pct}% (${fmt(prepay)} сум) в течение ${p.payDays} банковских дней с даты подписания Договора. Остаток ${fmt(remaining)} сум${rateStr} погашается следующим образом:`;
      const ords = [
        "первый", "второй", "третий", "четвёртый", "пятый", "шестой",
        "седьмой", "восьмой", "девятый", "десятый", "одиннадцатый", "двенадцатый",
      ];
      const items = rows.map((row, i) => {
        const ord = i < ords.length ? ords[i] : `${i + 1}-й`;
        return `— ${ord} платеж: ${fmt(row.amount)} сум, до ${row.due.toLocaleDateString("ru-RU")} г.`;
      });
      return { lead, items };
    }
    // Одноабзацный фолбэк донора (paymentText, months || 1).
    const m = p.installMonths || 1;
    const sched = installmentSchedule({
      totalWithVat: total,
      prepayPct: pct,
      months: m,
      annualRatePct: annualRate,
      firstDate: p.installFirstDate ? new Date(p.installFirstDate) : new Date(0),
    });
    const monthly = sched.length > 0 ? sched[0].amount : 0;
    const startStr = p.installFirstDate
      ? `, начиная с ${new Date(p.installFirstDate).toLocaleDateString("ru-RU")}`
      : "";
    return {
      lead: `Первоначальный взнос ${pct}% (${fmt(prepay)} сум) в течение ${p.payDays} банковских дней с даты подписания Договора. Остаток ${fmt(remaining)} сум${rateStr} погашается ${m} ежемесячными платежами по ${fmt(monthly)} сум${startStr}.`,
      items: [],
    };
  }
  // post
  return {
    lead: `Оплата 100% (${fmt(total)} сум) в течение ${p.payDays} банковских дней с момента получения Товара.`,
    items: [],
  };
}

/** Текст гарантии (донор, warrantyClause, строки 482–486). */
export function warrantyClauseText(mode: WarrantyMode, custom?: string): string {
  if (mode === "spec") return "1 год или 2000 моточасов для спецтехники; 6 месяцев для самоходной техники.";
  if (mode === "self") return "6 месяцев с момента подписания акта приема-передачи.";
  return custom ?? "";
}

/** п.5.1 (донор, строка 1402). */
export function warrantyFullClauseText(mode: WarrantyMode, custom?: string): string {
  return `Гарантийный срок: ${warrantyClauseText(mode, custom)} Подробные условия — в Приложении №1.`;
}

/** п.5.2 (донор, строка 1403) — сервис из параметра, не из хардкода. */
export function serviceClauseText(serviceCompany?: string): string {
  return `Гарантийное обслуживание — ${serviceCompany || DEFAULT_SERVICE_COMPANY}.`;
}

/** п.6.1 (донор, строка 1406). */
export function deliveryClauseText(deliveryDays: number): string {
  return `Самовывоз со склада Продавца в течение ${deliveryDays} банковских дней с момента 100% оплаты.`;
}

/** п.8.1 (донор, строка 1413). */
export function penaltySellerClauseText(penaSeller: number, penaMax: number): string {
  return `Пеня Продавца за просрочку: ${penaSeller}%/день, не более ${penaMax}%.`;
}

/** п.8.2 (донор, строка 1414). */
export function penaltyBuyerClauseText(penaBuyer: number, penaMax: number): string {
  return `Пеня Покупателя за просрочку: ${penaBuyer}%/день, не более ${penaMax}%.`;
}

/** п.11.2 (донор, строка 1425). */
export function copiesClauseText(copies: number): string {
  return `Составлен в ${copies} экземплярах. ГК РУз, Закон №670-I от 29.08.1998 г.`;
}

/** Строки блока реквизитов продавца (§12, донор строка 1351) — из параметра. */
export function sellerRequisitesLines(seller: ContractParty): string[] {
  return [
    seller.name,
    seller.address,
    "р/с: " + seller.account,
    "Банк: " + seller.bank,
    "МФО: " + seller.mfo + "  ИНН: " + seller.inn,
  ];
}

/** Строки блока реквизитов покупателя (§12, донор строка 1352) — с прочерками. */
export function buyerRequisitesLines(buyer: Partial<ContractParty>): string[] {
  return [
    buyer.name || "ООО «________________»",
    "Адрес: " + (buyer.address || "____________________"),
    "р/с: " + (buyer.account || "____________________"),
    "Банк: " + (buyer.bank || "____________________"),
    "МФО: " + (buyer.mfo || "______") + "  ИНН: " + (buyer.inn || "________"),
  ];
}

/** Все тексты документа одной структурой — для тестов и переиспользования. */
export interface ContractTexts {
  title: string;
  city: string;
  dateLine: string;
  preamble: TextSegment[];
  sumClause: string;
  payment: PaymentClauseTexts;
  warrantyClause: string;
  serviceClause: string;
  deliveryClause: string;
  penaltySeller: string;
  penaltyBuyer: string;
  copiesClause: string;
  sellerRequisites: string[];
  buyerRequisites: string[];
  totals: { totalWithVat: number; totalVat: number; totalNoVat: number };
}

/** Собирает все тексты пунктов договора (чистый слой, без docx). */
export function buildContractTexts(input: ContractDocxInput): ContractTexts {
  const vatRatePct = input.vatRatePct ?? DEFAULT_VAT_RATE_PCT;
  const totals = contractTotals(input.items);
  return {
    title: contractTitle(input.contractNo),
    city: "г. Ташкент",
    dateLine: dateRu(input.contractDate),
    preamble: preambleSegments(input.seller, input.buyer),
    sumClause: sumClauseText(totals.totalWithVat, totals.totalVat, vatRatePct),
    payment: paymentClauseTexts(totals.totalWithVat, input.payType, input.docParams),
    warrantyClause: warrantyFullClauseText(input.docParams.warrantyMode, input.docParams.warrantyCustom),
    serviceClause: serviceClauseText(input.serviceCompany),
    deliveryClause: deliveryClauseText(input.deliveryDays),
    penaltySeller: penaltySellerClauseText(input.docParams.penaSeller, input.docParams.penaMax),
    penaltyBuyer: penaltyBuyerClauseText(input.docParams.penaBuyer, input.docParams.penaMax),
    copiesClause: copiesClauseText(input.docParams.copies),
    sellerRequisites: sellerRequisitesLines(input.seller),
    buyerRequisites: buyerRequisitesLines(input.buyer),
    totals,
  };
}

// ============================================================================
// СЛОЙ (б): СБОРКА Document — форматирование донора дословно
// (ContractModule.tsx:1288–1440)
// ============================================================================

type Align = (typeof AlignmentType)[keyof typeof AlignmentType];
const A_LEFT: Align = AlignmentType.LEFT;
const A_CENTER: Align = AlignmentType.CENTER;
const A_RIGHT: Align = AlignmentType.RIGHT;
const A_JUSTIFIED: Align = AlignmentType.JUSTIFIED;

const FONT = "Times New Roman";
const SZ = 24; // 12pt в half-points — основной текст
const SZS = 20; // 10pt — таблицы
const NAVY_COLOR = "1a2744"; // заливка шапок таблиц

const mkBorder = () => ({ style: BorderStyle.SINGLE, size: 4, color: "999999" });
const mkBorders = () => {
  const b = mkBorder();
  return { top: b, bottom: b, left: b, right: b };
};
const mkNoBorder = () => ({ style: BorderStyle.NONE, size: 0, color: "FFFFFF" });
const mkNoBorders = () => {
  const b = mkNoBorder();
  return { top: b, bottom: b, left: b, right: b };
};
const cm = { top: 80, bottom: 80, left: 100, right: 100 };

const mkP = (runs: TextRun[], align: Align = A_JUSTIFIED, before = 60, after = 60) =>
  new Paragraph({ children: runs, spacing: { before, after }, alignment: align });
const mkT = (text: string, bold = false, size = SZ, color?: string) =>
  new TextRun({ text, font: FONT, size, bold, color });
const mkCell = (children: Paragraph[], width: number, fill?: string, noBorder = false, span?: number) =>
  new TableCell({
    children,
    borders: noBorder ? mkNoBorders() : mkBorders(),
    width: { size: width, type: WidthType.DXA },
    margins: cm,
    shading: fill ? { fill, type: ShadingType.CLEAR } : undefined,
    verticalAlign: VerticalAlign.CENTER,
    ...(span ? { columnSpan: span } : {}),
  });
const mkSection = (text: string) => mkP([mkT(text, true)], A_CENTER, 160, 80);
const mkClause = (num: string, text: string) => mkP([mkT(num + " ", true), mkT(text)], A_JUSTIFIED, 80, 60);
const mkEmpty = () => mkP([mkT("")], A_LEFT, 0, 0);

/** Собирает Document договора из чистых текстов (структура донора 1:1). */
export function buildContractDocument(input: ContractDocxInput): Document {
  const vatRatePct = input.vatRatePct ?? DEFAULT_VAT_RATE_PCT;
  const t = buildContractTexts(input);
  const TW = 9026;
  const H = TW / 2;

  // Пункт 3.1: для рассрочки — многопараграфный список платежей, иначе один абзац.
  const paymentClauseParagraphs: Paragraph[] = [
    mkClause("3.1.", t.payment.lead),
    ...t.payment.items.map((line) => mkP([mkT(line)], A_LEFT, 20, 20)),
  ];

  // §12 Реквизиты сторон — продавец из параметра (донор: хардкод SELLER).
  const rekvTable = new Table({
    width: { size: TW, type: WidthType.DXA },
    columnWidths: [H, H],
    rows: [
      new TableRow({
        children: [
          mkCell([mkP([mkT("ПРОДАВЕЦ", true, SZ, "FFFFFF")], A_CENTER, 0, 0)], H, NAVY_COLOR),
          mkCell([mkP([mkT("ПОКУПАТЕЛЬ", true, SZ, "FFFFFF")], A_CENTER, 0, 0)], H, NAVY_COLOR),
        ],
      }),
      new TableRow({
        children: [
          mkCell(
            t.sellerRequisites.map((line, i) =>
              mkP([mkT(line, i === 0, SZS)], A_LEFT, 0, i === t.sellerRequisites.length - 1 ? 0 : 20),
            ),
            H,
          ),
          mkCell(
            t.buyerRequisites.map((line, i) =>
              mkP([mkT(line, i === 0, SZS)], A_LEFT, 0, i === t.buyerRequisites.length - 1 ? 0 : 20),
            ),
            H,
          ),
        ],
      }),
    ],
  });

  // §13 Подписи и печати.
  const signTable = new Table({
    width: { size: TW, type: WidthType.DXA },
    columnWidths: [H, H],
    rows: [
      new TableRow({
        children: [
          mkCell(
            [
              mkP([mkT("ПРОДАВЕЦ", true)], A_CENTER, 0, 120),
              mkP([mkT("Директор " + input.seller.name, false, SZS)], A_LEFT, 0, 200),
              mkP([mkT(input.seller.director + " ___________________", false, SZS)], A_LEFT, 0, 200),
              mkP([mkT("М.П.", false, SZS)], A_LEFT, 0, 0),
            ],
            H,
          ),
          mkCell(
            [
              mkP([mkT("ПОКУПАТЕЛЬ", true)], A_CENTER, 0, 120),
              mkP([mkT("Директор " + (input.buyer.name || "ООО «________________»"), false, SZS)], A_LEFT, 0, 200),
              mkP([mkT(input.buyer.director || "________________________", false, SZS)], A_LEFT, 0, 200),
              mkP([mkT("М.П.", false, SZS)], A_LEFT, 0, 0),
            ],
            H,
          ),
        ],
      }),
    ],
  });

  // §1 Спецификация — 9 колонок; построчные формулы из @mydon/shared.
  const specColWidths = [350, 2300, 500, 450, 1300, 1100, 500, 700, 826];
  const specTable = new Table({
    width: { size: TW, type: WidthType.DXA },
    columnWidths: specColWidths,
    rows: [
      new TableRow({
        tableHeader: true,
        children: ["№", "Наименование", "Ед.", "Кол.", "Цена без НДС", "Сумма без НДС", "НДС%", "НДС сум", "С НДС"].map(
          (h, i) => mkCell([mkP([mkT(h, true, SZS, "FFFFFF")], A_CENTER, 0, 0)], specColWidths[i], NAVY_COLOR),
        ),
      }),
      ...input.items.map((r, i) => {
        const b = itemBreakdown(r);
        return new TableRow({
          children: [
            String(i + 1),
            r.name,
            r.unit || "шт",
            String(r.qty),
            fmt(b.unitNoVat),
            fmt(b.noVat),
            `${vatRatePct}%`,
            fmt(b.vat),
            fmt(b.total),
          ].map((v, j) => mkCell([mkP([mkT(v, false, SZS)], j > 3 ? A_RIGHT : A_LEFT, 0, 0)], specColWidths[j])),
        });
      }),
      new TableRow({
        children: [
          mkCell(
            [mkP([mkT("Итого с НДС:", true, SZS)], A_RIGHT, 0, 0)],
            specColWidths.slice(0, 8).reduce((a, b) => a + b, 0),
            "F2F2F2",
            false,
            8,
          ),
          mkCell([mkP([mkT(fmt(t.totals.totalWithVat), true, SZS)], A_RIGHT, 0, 0)], specColWidths[8], "F2F2F2"),
        ],
      }),
    ],
  });

  return new Document({
    styles: { default: { document: { run: { font: FONT, size: SZ } } } },
    sections: [
      {
        properties: {
          page: {
            size: { width: 11906, height: 16838 },
            margin: { top: 1134, right: 850, bottom: 1134, left: 1701 },
          },
        },
        children: [
          mkP([mkT(t.title, true, 28)], A_CENTER, 0, 120),
          new Table({
            width: { size: TW, type: WidthType.DXA },
            columnWidths: [H, H],
            rows: [
              new TableRow({
                children: [
                  mkCell([mkP([mkT(t.city)], A_LEFT, 0, 0)], H, undefined, true),
                  mkCell([mkP([mkT(t.dateLine)], A_RIGHT, 0, 0)], H, undefined, true),
                ],
              }),
            ],
          }),
          mkEmpty(),
          mkP(
            t.preamble.map((s) => mkT(s.text, s.bold)),
            A_JUSTIFIED,
            100,
            100,
          ),
          mkEmpty(),
          mkSection("1. ПРЕДМЕТ ДОГОВОРА."),
          mkClause("1.1.", "«Продавец» обязуется передать в собственность, а «Покупатель» принять и оплатить Товары согласно спецификации:"),
          mkEmpty(),
          specTable,
          mkEmpty(),
          mkSection("2. ЦЕНА И ОБЩАЯ СУММА ДОГОВОРА."),
          mkClause("2.1.", t.sumClause),
          mkClause("2.2.", "Цена фиксированная. Изменение — только по дополнительному соглашению."),
          mkEmpty(),
          mkSection("3. ПОРЯДОК РАСЧЁТОВ."),
          ...paymentClauseParagraphs,
          mkClause("3.2.", "Иной порядок оплаты — по дополнительному соглашению Сторон."),
          mkClause("3.3.", "Расчеты в безналичном порядке в национальной валюте — сум."),
          mkClause("3.4.", "ЭСФ выставляется через my.soliq.uz в течение 3 рабочих дней (ст. 222 НК РУз)."),
          mkEmpty(),
          mkSection("4. КАЧЕСТВО И КОМПЛЕКТНОСТЬ."),
          mkClause("4.1.", "Качество соответствует стандартам завода-изготовителя. Товар свободен от прав третьих лиц."),
          mkEmpty(),
          mkSection("5. УСЛОВИЯ ГАРАНТИИ."),
          mkClause("5.1.", t.warrantyClause),
          mkClause("5.2.", t.serviceClause),
          mkEmpty(),
          mkSection("6. УСЛОВИЯ ПОСТАВКИ."),
          mkClause("6.1.", t.deliveryClause),
          mkEmpty(),
          mkSection("7. СДАЧА-ПРИЁМКА."),
          mkClause("7.1.", "Передача оформляется товарной накладной. Право собственности — с момента полной оплаты."),
          mkClause("7.2.", "Акт приема-передачи подписывается в течение 2 рабочих дней. Недостатки устраняются до 30 дней."),
          mkEmpty(),
          mkSection("8. ОТВЕТСТВЕННОСТЬ СТОРОН."),
          mkClause("8.1.", t.penaltySeller),
          mkClause("8.2.", t.penaltyBuyer),
          mkClause("8.3.", "При просрочке более 30 дней — право приостановить поставку или расторгнуть Договор."),
          mkEmpty(),
          mkSection("9. ФОРС-МАЖОР."),
          mkClause("9.1.", "Освобождение от ответственности при обстоятельствах непреодолимой силы. Уведомление — 5 рабочих дней. Более 30 дней — право расторжения без санкций."),
          mkEmpty(),
          mkSection("10. РАЗРЕШЕНИЕ СПОРОВ."),
          mkClause("10.1.", "Претензионный порядок обязателен, срок — 15 дней. При недостижении — Экономический суд г. Ташкента."),
          mkEmpty(),
          mkSection("11. ЗАКЛЮЧИТЕЛЬНЫЕ ПОЛОЖЕНИЯ."),
          mkClause("11.1.", "Договор вступает в силу с даты подписания до полного исполнения обязательств."),
          mkClause("11.2.", t.copiesClause),
          mkEmpty(),
          mkSection("12. РЕКВИЗИТЫ СТОРОН."),
          rekvTable,
          mkEmpty(),
          mkSection("13. ПОДПИСИ И ПЕЧАТИ СТОРОН."),
          signTable,
        ],
      },
    ],
  });
}

/** Серверный рендер: Document → Buffer (донор скачивал Blob через file-saver). */
export async function renderContractDocx(input: ContractDocxInput): Promise<Buffer> {
  const doc = buildContractDocument(input);
  return Packer.toBuffer(doc);
}
