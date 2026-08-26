/**
 * Разовый перенос фискальных полей снека из реестра MYDON и mydon-stock.
 *
 * Без флагов — ПРИМЕРКА: этот скрипт CI не зовёт, он ходит в прод руками.
 * Это намеренно отличается от backfill-product-ids, который без флагов пишет,
 * потому что его запускает CI. Допустимы только `--dry-run` и `--apply`.
 */
import path from "node:path";
import { config as loadEnv } from "dotenv";
import { and, eq, isNull } from "drizzle-orm";
import postgres from "postgres";
import {
  BARCODE_DIGITS,
  FISCAL_FIELDS,
  IKPU_DIGITS,
  classifyIkpu,
  normalizeFiscalInput,
  productIndex,
  resolveCatalogName,
  type ProductIndex,
} from "@mydon/shared";
import { разобратьАргументы } from "./backfill-product-ids";
import { createDb, type Database } from "./index";
import { entity, vendingAlias, vendingProduct } from "./schema";

export interface DonorFiscalProductRow {
  id: number;
  name: string;
  ourvend_name: string | null;
  ikpu_code: string | null;
  barcode: string | null;
  is_marked: boolean;
  /** EAV `product/block_size`; только для отчёта, никогда не пишется. */
  block_size?: number | null;
}

export interface DonorIkpuDictRow {
  code: string;
  name: string;
}

export interface FiscalDonorReader {
  products(): Promise<DonorFiscalProductRow[]>;
  ikpuDict(): Promise<DonorIkpuDictRow[]>;
}

export type FiscalSkipReason =
  | "category"
  | "unknown_ikpu"
  | "conflict"
  | "length_defect"
  | "name_conflict"
  | "unresolved";

export interface FiscalFieldReport {
  /** Что решил записать снимок данных до открытия транзакции. */
  planned: { raw: string; canon: string; value: string }[];
  /** Что действительно изменил UPDATE ... RETURNING; в примерке всегда пусто. */
  written: { raw: string; canon: string; value: string }[];
  skipped: { raw: string; reason: FiscalSkipReason; detail: string }[];
}

export interface PackSizeMismatch {
  product: string;
  ours: number;
  donor: number;
}

export interface FiscalImportReport {
  apply: boolean;
  ikpu: FiscalFieldReport;
  barcode: FiscalFieldReport;
  marked: FiscalFieldReport;
  packSizeMismatches: PackSizeMismatch[];
  unresolvedDonorNames: string[];
}

interface PriceCard {
  id: string;
  canon: string;
  ikpu: string | null;
  barcode: string | null;
  marked: boolean;
  packSize?: number;
}

interface FiscalPlan {
  ikpu: { productId: string; raw: string; canon: string; value: string; source: "entity" | "donor" }[];
  barcode: { productId: string; raw: string; canon: string; value: string; source: "entity" }[];
  marked: { productId: string; raw: string; canon: string }[];
  skipped: { field: "ikpu" | "barcode"; raw: string; reason: FiscalSkipReason; detail: string }[];
  packSizeMismatches: PackSizeMismatch[];
  unresolvedDonorNames: string[];
}

type FiscalWritten = Pick<FiscalPlan, "ikpu" | "barcode" | "marked">;

function attrValue(attrs: Record<string, unknown>, key: string): string | null {
  const value = attrs[key];
  if (value === null || value === undefined) return null;
  return normalizeFiscalInput(String(value));
}

function validDigits(value: string, lengths: readonly number[]): boolean {
  return /^\d+$/.test(value) && lengths.includes(value.length);
}

function distinct(values: readonly (string | null)[]): string[] {
  return [...new Set(values.filter((value): value is string => value !== null))];
}

function resolveDonorProduct(index: ProductIndex, row: DonorFiscalProductRow) {
  const byName = resolveCatalogName(index, row.name);
  if (byName.kind !== "miss") return byName;
  if (row.ourvend_name?.trim()) return resolveCatalogName(index, row.ourvend_name);
  return byName;
}

/** Чистый план: ни БД, ни времени, ни побочных эффектов. */
export function planFiscalImport(input: {
  priceCards: PriceCard[];
  registryCards: { name: string; attrs: Record<string, unknown> }[];
  donorProducts: DonorFiscalProductRow[];
  donorIkpuDict: DonorIkpuDictRow[];
  priceIndex: ProductIndex;
}): FiscalPlan {
  const registryByProduct = new Map<string, { name: string; attrs: Record<string, unknown> }[]>();
  const skipped: FiscalPlan["skipped"] = [];

  for (const card of input.registryCards) {
    const resolution = resolveCatalogName(input.priceIndex, card.name);
    if (resolution.kind === "hit") {
      const list = registryByProduct.get(resolution.id) ?? [];
      list.push(card);
      registryByProduct.set(resolution.id, list);
    } else if (resolution.kind === "conflict") {
      if (attrValue(card.attrs, FISCAL_FIELDS[0])) {
        skipped.push({
          field: "ikpu",
          raw: card.name,
          reason: "name_conflict",
          detail: `имя карточки «${resolution.byName}», алиас ведёт к «${resolution.byAlias}»`,
        });
      }
      if (attrValue(card.attrs, "штрихкод")) {
        skipped.push({
          field: "barcode",
          raw: card.name,
          reason: "name_conflict",
          detail: `имя карточки «${resolution.byName}», алиас ведёт к «${resolution.byAlias}»`,
        });
      }
    }
  }

  const donorByProduct = new Map<string, DonorFiscalProductRow[]>();
  const unresolved = new Set<string>();
  for (const row of input.donorProducts) {
    const resolution = resolveDonorProduct(input.priceIndex, row);
    if (resolution.kind === "hit") {
      const list = donorByProduct.get(resolution.id) ?? [];
      list.push(row);
      donorByProduct.set(resolution.id, list);
      continue;
    }
    unresolved.add(row.name);
    const detail =
      resolution.kind === "conflict"
        ? `имя карточки «${resolution.byName}», алиас ведёт к «${resolution.byAlias}»`
        : "карточка прайса не найдена";
    const reason: FiscalSkipReason = resolution.kind === "conflict" ? "name_conflict" : "unresolved";
    if (normalizeFiscalInput(row.ikpu_code)) skipped.push({ field: "ikpu", raw: row.name, reason, detail });
  }

  const dict = new Map(input.donorIkpuDict.map((row) => [row.code, row.name]));
  const ikpu: FiscalPlan["ikpu"] = [];
  const barcode: FiscalPlan["barcode"] = [];
  const marked: FiscalPlan["marked"] = [];
  const packSizeMismatches: PackSizeMismatch[] = [];

  for (const price of input.priceCards) {
    const registry = registryByProduct.get(price.id) ?? [];
    const donors = donorByProduct.get(price.id) ?? [];
    const entityIkpu = distinct(registry.map((card) => attrValue(card.attrs, FISCAL_FIELDS[0])));
    const entityBarcode = distinct(registry.map((card) => attrValue(card.attrs, "штрихкод")));

    if (entityIkpu.length > 1) {
      skipped.push({
        field: "ikpu",
        raw: price.canon,
        reason: "conflict",
        detail: `в реестре несколько ИКПУ: ${entityIkpu.join(", ")}`,
      });
    } else if (entityIkpu.length === 1) {
      const value = entityIkpu[0];
      if (!validDigits(value, [IKPU_DIGITS])) {
        skipped.push({
          field: "ikpu",
          raw: price.canon,
          reason: "length_defect",
          detail: `ожидалось ${IKPU_DIGITS} цифр, получено ${value.length}`,
        });
      } else if (price.ikpu !== null) {
        if (normalizeFiscalInput(price.ikpu) !== value) {
          skipped.push({
            field: "ikpu",
            raw: price.canon,
            reason: "conflict",
            detail: `у нас ${price.ikpu}, реестр ${value}`,
          });
        }
      } else {
        const raw = registry.find((card) => attrValue(card.attrs, FISCAL_FIELDS[0]) === value)?.name ?? price.canon;
        ikpu.push({ productId: price.id, raw, canon: price.canon, value, source: "entity" });
      }
    } else {
      const donorCodes = distinct(donors.map((row) => normalizeFiscalInput(row.ikpu_code)));
      if (donorCodes.length > 1) {
        skipped.push({
          field: "ikpu",
          raw: price.canon,
          reason: "conflict",
          detail: `донор несёт несколько ИКПУ: ${donorCodes.join(", ")}`,
        });
      } else if (donorCodes.length === 1) {
        const value = donorCodes[0];
        if (price.ikpu !== null) {
          if (normalizeFiscalInput(price.ikpu) !== value) {
            skipped.push({
              field: "ikpu",
              raw: price.canon,
              reason: "conflict",
              detail: `у нас ${price.ikpu}, донор ${value}`,
            });
          }
        } else if (!validDigits(value, [IKPU_DIGITS])) {
          skipped.push({
            field: "ikpu",
            raw: price.canon,
            reason: "length_defect",
            detail: `ожидалось ${IKPU_DIGITS} цифр, получено ${value.length}`,
          });
        } else {
          const classification = classifyIkpu(value, dict);
          if (classification.kind === "sku") {
            const raw = donors.find((row) => normalizeFiscalInput(row.ikpu_code) === value)?.name ?? price.canon;
            ikpu.push({ productId: price.id, raw, canon: price.canon, value, source: "donor" });
          } else if (classification.kind === "category") {
            skipped.push({
              field: "ikpu",
              raw: price.canon,
              reason: "category",
              detail: dict.get(value) ?? value,
            });
          } else {
            skipped.push({
              field: "ikpu",
              raw: price.canon,
              reason: "unknown_ikpu",
              detail: classification.why,
            });
          }
        }
      }
    }

    if (entityBarcode.length > 1) {
      skipped.push({
        field: "barcode",
        raw: price.canon,
        reason: "conflict",
        detail: `в реестре несколько штрихкодов: ${entityBarcode.join(", ")}`,
      });
    } else if (entityBarcode.length === 1) {
      const value = entityBarcode[0];
      if (!validDigits(value, BARCODE_DIGITS)) {
        skipped.push({
          field: "barcode",
          raw: price.canon,
          reason: "length_defect",
          detail: `ожидалось ${BARCODE_DIGITS.join("/")} цифр, получено ${value.length}`,
        });
      } else if (price.barcode !== null) {
        if (normalizeFiscalInput(price.barcode) !== value) {
          skipped.push({
            field: "barcode",
            raw: price.canon,
            reason: "conflict",
            detail: `у нас ${price.barcode}, реестр ${value}`,
          });
        }
      } else {
        const raw = registry.find((card) => attrValue(card.attrs, "штрихкод") === value)?.name ?? price.canon;
        barcode.push({ productId: price.id, raw, canon: price.canon, value, source: "entity" });
      }
    }

    const markedDonor = donors.find((row) => row.is_marked === true);
    if (!price.marked && markedDonor) {
      marked.push({ productId: price.id, raw: markedDonor.name, canon: price.canon });
    }

    const blockSizes = [...new Set(donors.map((row) => row.block_size).filter((v): v is number => Number.isInteger(v)))];
    if (price.packSize !== undefined) {
      for (const donor of blockSizes) {
        if (donor !== price.packSize) {
          packSizeMismatches.push({ product: price.canon, ours: price.packSize, donor });
        }
      }
    }
  }

  return {
    ikpu,
    barcode,
    marked,
    skipped,
    packSizeMismatches,
    unresolvedDonorNames: [...unresolved].sort((a, b) => a.localeCompare(b, "ru")),
  };
}

/** Собрать внешний отчёт из плана и фактически записанных строк. */
export function планВОтчёт(plan: FiscalPlan, apply: boolean, written: FiscalWritten): FiscalImportReport {
  const field = (
    name: "ikpu" | "barcode",
    rows: FiscalWritten[typeof name],
  ): FiscalFieldReport => ({
    planned: plan[name].map((row) => ({ raw: row.raw, canon: row.canon, value: row.value })),
    written: rows.map((row) => ({ raw: row.raw, canon: row.canon, value: row.value })),
    skipped: plan.skipped
      .filter((row) => row.field === name)
      .map(({ raw, reason, detail }) => ({ raw, reason, detail })),
  });
  return {
    apply,
    ikpu: field("ikpu", written.ikpu),
    barcode: field("barcode", written.barcode),
    marked: {
      planned: plan.marked.map((row) => ({ raw: row.raw, canon: row.canon, value: "true" })),
      written: written.marked.map((row) => ({ raw: row.raw, canon: row.canon, value: "true" })),
      skipped: [],
    },
    packSizeMismatches: plan.packSizeMismatches,
    unresolvedDonorNames: plan.unresolvedDonorNames,
  };
}

export class ImportFiscalWriteFailure extends Error {
  constructor(
    readonly report: FiscalImportReport,
    readonly reason: unknown,
  ) {
    super(reason instanceof Error ? reason.message : String(reason));
    this.name = "ImportFiscalWriteFailure";
  }
}

export async function importFiscal(
  db: Database,
  donor: FiscalDonorReader,
  opts: { apply: boolean },
): Promise<FiscalImportReport> {
  const [priceRows, registryRows, aliases, donorProducts, donorIkpuDict] = await Promise.all([
    db
      .select({
        id: vendingProduct.id,
        name: vendingProduct.name,
        ikpu: vendingProduct.ikpu,
        barcode: vendingProduct.barcode,
        marked: vendingProduct.marked,
        packSize: vendingProduct.packSize,
      })
      .from(vendingProduct),
    db.select({ name: entity.name, attrs: entity.attrs }).from(entity).where(eq(entity.type, "product")),
    db.select({ productId: vendingAlias.productId, alias: vendingAlias.alias }).from(vendingAlias),
    donor.products(),
    donor.ikpuDict(),
  ]);
  const priceIndex = productIndex(
    priceRows.map((row) => ({ id: row.id, name: row.name })),
    aliases,
  );
  const plan = planFiscalImport({
    priceCards: priceRows.map((row) => ({
      id: row.id,
      canon: row.name,
      ikpu: row.ikpu,
      barcode: row.barcode,
      marked: row.marked,
      packSize: row.packSize,
    })),
    registryCards: registryRows.map((row) => ({ name: row.name, attrs: row.attrs as Record<string, unknown> })),
    donorProducts,
    donorIkpuDict,
    priceIndex,
  });

  if (!opts.apply) return планВОтчёт(plan, false, { ikpu: [], barcode: [], marked: [] });

  const written: FiscalWritten = { ikpu: [], barcode: [], marked: [] };
  const updatedAt = new Date();
  try {
    await db.transaction(async (tx) => {
      for (const row of plan.ikpu) {
        const changed = await tx
          .update(vendingProduct)
          .set({ ikpu: row.value, updatedAt })
          .where(and(eq(vendingProduct.id, row.productId), isNull(vendingProduct.ikpu)))
          .returning({ id: vendingProduct.id });
        if (changed.length > 0) written.ikpu.push(row);
      }
      for (const row of plan.barcode) {
        const changed = await tx
          .update(vendingProduct)
          .set({ barcode: row.value, updatedAt })
          .where(and(eq(vendingProduct.id, row.productId), isNull(vendingProduct.barcode)))
          .returning({ id: vendingProduct.id });
        if (changed.length > 0) written.barcode.push(row);
      }
      for (const row of plan.marked) {
        const changed = await tx
          .update(vendingProduct)
          .set({ marked: true, updatedAt })
          .where(and(eq(vendingProduct.id, row.productId), eq(vendingProduct.marked, false)))
          .returning({ id: vendingProduct.id });
        if (changed.length > 0) written.marked.push(row);
      }
    });
  } catch (error) {
    throw new ImportFiscalWriteFailure(
      планВОтчёт(plan, true, { ikpu: [], barcode: [], marked: [] }),
      error,
    );
  }
  return планВОтчёт(plan, true, written);
}

/** Донор открывается одним read-only по намерению клиентом; методы — только SELECT. */
export function sqlFiscalDonor(
  url: string,
  schema = "public",
): { reader: FiscalDonorReader; close(): Promise<void> } {
  const client = postgres(url, { prepare: false, max: 1, connect_timeout: 10 });
  const reader: FiscalDonorReader = {
    products: async () =>
      (await client`
        select p.id, p.name, p.ourvend_name, p.ikpu_code, p.barcode, p.is_marked,
               av.value_num::int as block_size
          from ${client(schema)}.products p
          left join ${client(schema)}.attribute_defs ad
            on ad.entity = 'product' and ad.key = 'block_size' and ad.active
          left join ${client(schema)}.attribute_values av
            on av.def_id = ad.id and av.entity_id = p.id
         order by p.id`) as unknown as DonorFiscalProductRow[],
    ikpuDict: async () =>
      (await client`
        select e.code, e.name
          from ${client(schema)}.dictionary_entries e
          join ${client(schema)}.dictionaries d on d.id = e.dict_id
         where d.key = 'ikpu'
         order by e.code`) as unknown as DonorIkpuDictRow[],
  };
  return { reader, close: async () => client.end({ timeout: 5 }) };
}

const REASONS: Record<FiscalSkipReason, string> = {
  category: "категорийный ИКПУ",
  unknown_ikpu: "справочник не подтверждает вид ИКПУ",
  conflict: "непустые значения расходятся",
  length_defect: "неверная длина или состав кода",
  name_conflict: "имя спорит с алиасом",
  unresolved: "карточка прайса не найдена",
};

export function formatFiscalReport(report: FiscalImportReport): string {
  const lines: string[] = [
    report.apply
      ? "Перенос фискальных полей — РЕЖИМ --apply: разрешённые значения записаны."
      : "Перенос фискальных полей — РЕЖИМ ПРИМЕРКА: ничего не записано; ниже — что сделает --apply.",
    "",
    `${"поле".padEnd(14)}${"к записи".padStart(10)}${"записано".padStart(11)}${"пропущено".padStart(12)}`,
  ];
  for (const [label, field] of [
    ["ИКПУ", report.ikpu],
    ["штрихкод", report.barcode],
    ["маркировка", report.marked],
  ] as const) {
    lines.push(
      `${label.padEnd(14)}${String(field.planned.length).padStart(10)}` +
        `${String(field.written.length).padStart(11)}${String(field.skipped.length).padStart(12)}`,
    );
    for (const row of field.planned.slice(0, 50)) lines.push(`  ${row.raw} → ${row.canon} → ${row.value}`);
    if (field.planned.length > 50) lines.push(`  … и ещё ${field.planned.length - 50}`);
    for (const row of field.skipped.slice(0, 50)) {
      lines.push(`  ПРОПУСК · ${row.raw} · ${REASONS[row.reason]}: ${row.detail}`);
    }
    if (field.skipped.length > 50) lines.push(`  … и ещё ${field.skipped.length - 50} пропусков`);
  }
  if (report.packSizeMismatches.length > 0) {
    lines.push("", `Расхождения «Блок, шт» (${report.packSizeMismatches.length}) — только отчёт, ничего не записано:`);
    for (const row of report.packSizeMismatches.slice(0, 50)) {
      lines.push(`  ${row.product}: у нас ${row.ours}, донор ${row.donor}`);
    }
  }
  if (report.unresolvedDonorNames.length > 0) {
    lines.push("", `Имена донора без однозначной карточки (${report.unresolvedDonorNames.length}):`);
    lines.push(`  ${report.unresolvedDonorNames.slice(0, 50).join(" · ")}`);
  }
  lines.push(
    "",
    `ИТОГИ(json): ${JSON.stringify({
      apply: report.apply,
      ikpu: report.apply ? report.ikpu.written.length : report.ikpu.planned.length,
      barcode: report.apply ? report.barcode.written.length : report.barcode.planned.length,
      marked: report.apply ? report.marked.written.length : report.marked.planned.length,
      packSizeMismatches: report.packSizeMismatches.length,
      unresolved: report.unresolvedDonorNames.length,
    })}`,
  );
  return lines.join("\n");
}

function host(url: string): string {
  try {
    return new URL(url).host || "локальный сокет";
  } catch {
    return "неразбираемый адрес";
  }
}

async function main(): Promise<void> {
  loadEnv({ path: path.resolve(__dirname, "../../../.env"), quiet: true });
  const argv = process.argv.slice(2);
  const parsed = разобратьАргументы(argv);
  if (!parsed.ok) {
    console.error(parsed.error);
    process.exit(1);
  }

  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL не задан — перенос фискальных полей выполнять негде.");
    process.exit(1);
  }
  const donorUrl = process.env.STOCK_DATABASE_URL;
  if (!donorUrl) {
    console.error("донор mydon-stock не подключён — это не поломка скрипта, а не выданное окружение");
    process.exit(2);
  }

  const apply = argv.includes("--apply");
  console.log(
    `${apply ? "Режим: ЗАПИСЬ (--apply)." : "Режим: ПРИМЕРКА, записи не будет."} ` +
      `MYDON: ${host(url)} · донор: ${host(donorUrl)}`,
  );
  const { reader, close } = sqlFiscalDonor(donorUrl, process.env.STOCK_SCHEMA || "public");
  try {
    console.log(formatFiscalReport(await importFiscal(createDb(url), reader, { apply })));
  } finally {
    await close();
  }
  process.exit(0);
}

if (require.main === module) {
  main().catch((error: unknown) => {
    if (error instanceof ImportFiscalWriteFailure) console.log(formatFiscalReport(error.report));
    console.error("Перенос фискальных полей упал:", error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
