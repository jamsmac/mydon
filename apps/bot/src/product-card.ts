import { fiscalFlaws, MARKING, PACKAGE_CODES } from "@mydon/shared";
import type { ProductFiscalFlaw } from "@mydon/shared";
import type { VendingProductCard } from "./core-client";

export const PRODUCT_CARD_HINT = "Напиши: «карточка <товар>», например «карточка Snickers 50gr».";

/** Префикс без `\b` — он не срабатывает после кириллицы. */
export function isProductCardTrigger(text: string): boolean {
  return /^карточка(\s|:|$)/i.test(text.trim());
}

export function parseProductCardCommand(text: string): string | null {
  const match = /^карточка(?:\s*:\s*|\s+)(.*?)\s*$/i.exec(text.trim());
  const product = match?.[1]?.trim() ?? "";
  return product.length > 0 ? product : null;
}

const CATEGORY: Record<VendingProductCard["category"], string> = {
  drink: "напиток",
  snack: "снек",
  other: "другое",
};

const FISCAL_FIELD: Record<ProductFiscalFlaw["field"], string> = {
  ikpu: "ИКПУ",
  mxik: "МХИК",
  vatPct: "НДС",
  barcode: "Штрихкод",
  packageCode: "Упаковка",
  marked: "Маркировка",
};

const поле = (value: string | null | undefined): string => {
  const normalized = value?.trim();
  return normalized ? normalized : "—";
};

const число = (value: number | null): string =>
  value === null
    ? "—"
    : new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 }).format(value).replace(/[\u00a0\u202f]/g, " ");

/** Одна карточка: цены, правила закупа, фискальные поля и явные дыры. */
export function formatProductCard(row: VendingProductCard): string {
  const packageEntry = PACKAGE_CODES.find((item) => item.code === row.fiscal.packageCode);
  const markingEntry = MARKING.find((item) => item.code === (row.fiscal.marked ? "1" : "0"));
  const flaws = fiscalFlaws(row.fiscal);
  const fixed = row.fixedPurchaseQty === null ? "—" : число(row.fixedPurchaseQty);
  const purchaseRule = row.excludedFromPurchase ? "не закупаем" : "закупаем";

  const lines = [
    `🧾 ${row.name} (${CATEGORY[row.category]})`,
    `Закуп ${число(row.purchasePrice)} сум · витрина ${число(row.salePrice)} сум · блок ${число(row.packSize)} · фикс ${fixed} · ${purchaseRule}`,
    "",
    "Фискальные данные:",
    `• ИКПУ: ${поле(row.fiscal.ikpu)}`,
    `• МХИК: ${поле(row.fiscal.mxik)}`,
    `• НДС: ${число(row.fiscal.vatPct)} %`,
    `• Штрихкод: ${поле(row.fiscal.barcode)}`,
    `• Упаковка: ${поле(row.fiscal.packageCode)}${packageEntry ? ` — ${packageEntry.label}` : ""}`,
    `• Маркировка: ${markingEntry?.label ?? "—"}`,
    "",
  ];

  if (flaws.length === 0) {
    lines.push("✅ Чек соберётся.");
  } else {
    lines.push("⚠️ Чек не соберётся:");
    lines.push(...flaws.map((flaw) => `• ${FISCAL_FIELD[flaw.field]}: ${flaw.why}`));
    lines.push("", "Править фискальные поля — в панели: VendHub → Правила закупа → Править.");
  }
  return lines.join("\n");
}
