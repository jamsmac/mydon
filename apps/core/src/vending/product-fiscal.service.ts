import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { auditLog, event, vendingProduct } from "@mydon/db";
import {
  fiscalReady,
  normalizeFiscalInput,
  validateFiscalPatch,
  type ProductFiscal,
  type ProductFiscalPatch,
} from "@mydon/shared";
import { DB, type Db } from "../db/db.module";

export type FiscalUpdateResult =
  | {
      ok: true;
      product: string;
      before: ProductFiscal;
      after: ProductFiscal;
      readyBefore: boolean;
      readyAfter: boolean;
    }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "invalid"; errors: string[] };

@Injectable()
export class ProductFiscalService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async update(
    productId: string,
    patch: ProductFiscalPatch,
    actor: string,
    now: Date,
  ): Promise<FiscalUpdateResult> {
    const touched = (Object.keys(patch) as (keyof ProductFiscalPatch)[]).filter(
      (key) => patch[key] !== undefined,
    );
    if (touched.length === 0) {
      throw new BadRequestException("нечего менять: укажи хотя бы одно фискальное поле");
    }

    // Собираем только реально названные ключи: `{ ikpu: "…", barcode:
    // undefined }` не должен превратить сохранённый штрихкод в `undefined`
    // внутри полного `after` аудита.
    const normalized: ProductFiscalPatch = {};
    if (patch.ikpu !== undefined) normalized.ikpu = normalizeFiscalInput(patch.ikpu);
    if (patch.mxik !== undefined) normalized.mxik = normalizeFiscalInput(patch.mxik);
    if (patch.barcode !== undefined) normalized.barcode = normalizeFiscalInput(patch.barcode);
    if (patch.vatPct !== undefined) normalized.vatPct = patch.vatPct;
    if (patch.packageCode !== undefined) normalized.packageCode = patch.packageCode;
    if (patch.marked !== undefined) normalized.marked = patch.marked;

    const errors = validateFiscalPatch(normalized);
    if (errors.length > 0) return { ok: false, reason: "invalid", errors };

    return this.db.transaction(async (tx): Promise<FiscalUpdateResult> => {
      // Полный before/after имеет смысл только под блокировкой строки: две
      // одновременные формы иначе обе записали бы в аудит один старый before.
      const [row] = await tx
        .select({
          id: vendingProduct.id,
          name: vendingProduct.name,
          ikpu: vendingProduct.ikpu,
          mxik: vendingProduct.mxik,
          vatPct: vendingProduct.vatPct,
          barcode: vendingProduct.barcode,
          packageCode: vendingProduct.packageCode,
          marked: vendingProduct.marked,
        })
        .from(vendingProduct)
        .where(eq(vendingProduct.id, productId))
        .limit(1)
        .for("update");
      if (!row) return { ok: false, reason: "not_found" };

      const before: ProductFiscal = {
        ikpu: row.ikpu,
        mxik: row.mxik,
        vatPct: row.vatPct,
        barcode: row.barcode,
        packageCode: row.packageCode,
        marked: row.marked,
      };
      const after: ProductFiscal = { ...before, ...normalized };
      const readyBefore = fiscalReady(before);
      const readyAfter = fiscalReady(after);

      await tx
        .update(vendingProduct)
        .set({ ...normalized, updatedAt: now })
        .where(eq(vendingProduct.id, productId));
      await tx.insert(event).values({
        source: "owner",
        type: "vending.product_fiscal_changed",
        payload: { product: row.name, before, after, readyBefore, readyAfter, actor },
      });
      await tx.insert(auditLog).values({
        actorKind: "human",
        actorRef: actor,
        action: "vending.product.set_fiscal",
        target: productId,
        before,
        after,
      });
      return { ok: true, product: row.name, before, after, readyBefore, readyAfter };
    });
  }
}
