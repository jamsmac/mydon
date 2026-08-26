import { IKPU_DIGITS, type FiscalFlaw } from "./sources";

/** Фискальный блок карточки снека — типизированный, в отличие от entity.attrs. */
export interface ProductFiscal {
  /** ИКПУ, 17 цифр. null — код не выясняли. */
  ikpu: string | null;
  /** МХИК, 17 цифр. Правило донора, не проверенная нами норма. */
  mxik: string | null;
  /** Ставка НДС, целые проценты. 0 законен, пустого не бывает. */
  vatPct: number;
  /** EAN: 8, 12 или 13 цифр. null — не выясняли. */
  barcode: string | null;
  /** Код ОКЕИ. Не идентификатор упаковки каталога Multikassa. */
  packageCode: string;
  /** Требует маркировки (КИЗ). false также используется, когда это не выясняли. */
  marked: boolean;
}

/** Патч: undefined — не трогать, null — очистить только nullable-поле. */
export type ProductFiscalPatch = {
  [K in keyof ProductFiscal]?: ProductFiscal[K] | (null extends ProductFiscal[K] ? null : never);
};

export const FISCAL_DEFAULTS = { vatPct: 12, packageCode: "796", marked: false } as const;

/** Допустимые длины EAN — множество, как у донора. */
export const BARCODE_DIGITS: readonly number[] = [8, 12, 13];

export interface DictEntry {
  code: string;
  label: string;
}

/** Ставки НДС из словаря донора. */
export const VAT_RATES: readonly DictEntry[] = [
  { code: "12", label: "12 % — стандартная" },
  { code: "0", label: "0 % — нулевая (льготная позиция)" },
  { code: "15", label: "15 % — специальная" },
];

/** Семь единиц ОКЕИ из словаря донора; 796 «Штука» — умолчание. */
export const PACKAGE_CODES: readonly DictEntry[] = [
  { code: "796", label: "Штука" },
  { code: "778", label: "Упаковка" },
  { code: "166", label: "Килограмм" },
  { code: "112", label: "Литр" },
  { code: "736", label: "Рулон" },
  { code: "356", label: "Час" },
  { code: "111", label: "Сантиметр кубический" },
];

/** Маркировка из словаря донора. */
export const MARKING: readonly DictEntry[] = [
  { code: "0", label: "Не требуется" },
  { code: "1", label: "Требуется (КИЗ)" },
];

/** Что именно плохо в сохранённом поле. */
export interface ProductFiscalFlaw {
  field: keyof ProductFiscal;
  flaw: FiscalFlaw;
  why: string;
}

/** Разделители набора вырезаются, а не считаются частью кода. */
const РАЗДЕЛИТЕЛИ = /[\s\u00A0\u202F-]/g;

export function normalizeFiscalInput(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const normalized = raw.replace(РАЗДЕЛИТЕЛИ, "");
  return normalized.length === 0 ? null : normalized;
}

const цифры = (value: string, lengths: readonly number[]): boolean =>
  /^\d+$/.test(value) && lengths.includes(value.length);

/** Проверка патча перед записью: тексты подходят Core и форме. */
export function validateFiscalPatch(patch: ProductFiscalPatch): string[] {
  const errors: string[] = [];
  const код = (value: string | null | undefined, lengths: readonly number[], message: string) => {
    if (value === undefined) return;
    const normalized = normalizeFiscalInput(value);
    if (normalized === null) return;
    if (!цифры(normalized, lengths)) errors.push(message);
  };

  код(patch.ikpu, [IKPU_DIGITS], "ИКПУ должен быть 17 цифр или пусто");
  код(patch.mxik, [IKPU_DIGITS], "МХИК должен быть 17 цифр или пусто");
  код(patch.barcode, BARCODE_DIGITS, "Штрихкод должен быть 8/12/13 цифр или пусто");

  if (patch.vatPct !== undefined && !VAT_RATES.some((rate) => Number(rate.code) === patch.vatPct)) {
    errors.push(`Ставка НДС — одно из: ${VAT_RATES.map((rate) => rate.code).join(", ")}`);
  }
  if (patch.packageCode !== undefined && !PACKAGE_CODES.some((item) => item.code === patch.packageCode)) {
    errors.push("Код упаковки — 3 цифры ОКЕИ");
  }
  return errors;
}

function codeFlaw(
  field: "ikpu" | "mxik" | "barcode",
  raw: string,
  lengths: readonly number[],
): ProductFiscalFlaw | null {
  const normalized = normalizeFiscalInput(raw);
  if (normalized === null) return null;
  if (!/^\d+$/.test(normalized)) {
    return { field, flaw: "неверно", why: "в коде есть не только цифры" };
  }
  if (!lengths.includes(normalized.length)) {
    const expected = lengths.join("/");
    return { field, flaw: "неверно", why: `должно быть ${expected} цифр, а тут ${normalized.length}` };
  }
  return null;
}

/** Что мешает сохранённой карточке собрать корректный чек. */
export function fiscalFlaws(fiscal: ProductFiscal): ProductFiscalFlaw[] {
  const flaws: ProductFiscalFlaw[] = [];

  if (fiscal.ikpu === null || normalizeFiscalInput(fiscal.ikpu) === null) {
    flaws.push({ field: "ikpu", flaw: "нет", why: "код не выяснен" });
  } else {
    const flaw = codeFlaw("ikpu", fiscal.ikpu, [IKPU_DIGITS]);
    if (flaw) flaws.push(flaw);
  }

  if (fiscal.mxik !== null && normalizeFiscalInput(fiscal.mxik) !== null) {
    const flaw = codeFlaw("mxik", fiscal.mxik, [IKPU_DIGITS]);
    if (flaw) flaws.push(flaw);
  }
  if (fiscal.barcode !== null && normalizeFiscalInput(fiscal.barcode) !== null) {
    const flaw = codeFlaw("barcode", fiscal.barcode, BARCODE_DIGITS);
    if (flaw) flaws.push(flaw);
  }
  if (!VAT_RATES.some((rate) => Number(rate.code) === fiscal.vatPct)) {
    flaws.push({ field: "vatPct", flaw: "неверно", why: "ставки нет в фискальном словаре" });
  }
  if (!PACKAGE_CODES.some((item) => item.code === fiscal.packageCode)) {
    flaws.push({ field: "packageCode", flaw: "неверно", why: "кода нет в словаре ОКЕИ" });
  }

  return flaws;
}

/** Чек соберётся: есть ИКПУ верной длины и код упаковки из словаря. */
export function fiscalReady(fiscal: ProductFiscal): boolean {
  const ikpu = normalizeFiscalInput(fiscal.ikpu);
  return ikpu !== null && цифры(ikpu, [IKPU_DIGITS]) && PACKAGE_CODES.some((item) => item.code === fiscal.packageCode);
}

/**
 * Категорийность — цитата справочника владельца, а не догадка о
 * классификаторе. Суффикс `000000` служит независимой сверкой.
 */
export function classifyIkpu(
  code: string,
  dict: ReadonlyMap<string, string>,
): { kind: "sku" } | { kind: "category" } | { kind: "unknown"; why: string } {
  const label = dict.get(code);
  if (label === undefined) {
    return { kind: "unknown", why: "кода нет в справочнике донора — категорийность подтвердить нечем" };
  }
  const поСправочнику = /\(категория\)/i.test(label);
  const поСуффиксу = code.endsWith("000000");
  if (поСправочнику !== поСуффиксу) {
    return {
      kind: "unknown",
      why: `справочник донора говорит «${label}», а суффикс — ${поСуффиксу ? "категорийный" : "SKU"}`,
    };
  }
  return поСправочнику ? { kind: "category" } : { kind: "sku" };
}
