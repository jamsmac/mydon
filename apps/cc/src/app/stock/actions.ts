"use server";

import { revalidatePath } from "next/cache";
import { core, CoreUnavailable, type ImportBatchItem, type ImportBatchesReport } from "../../lib/core";

export interface ImportRunResult {
  ok: boolean;
  report?: ImportBatchesReport;
  error?: string;
}

/**
 * Экран «Импорт закупок» (срез D, задача 4).
 *
 * Единственный вызов ядра, что для предпросмотра, что для настоящей записи:
 * `dryRun: true` ничего не пишет и возвращает тот же отчёт, что и настоящий
 * прогон (R-D7, Task 3) — различие только в значении флага, а не в разных
 * ручках. Витрина (`register-import.tsx`) сама решает, когда какой звать;
 * здесь только проброс к `core.importBatches` и перевод отказа в слова
 * владельца, как у остальных серверных действий панели.
 */
export async function runRegisterImport(input: {
  source: string;
  dryRun: boolean;
  closeOn: string | null;
  items: ImportBatchItem[];
}): Promise<ImportRunResult> {
  try {
    const report = await core.importBatches(input);
    // Настоящая запись меняет остатки и партии — витрины направления должны
    // увидеть свежие данные. Предпросмотр ничего не пишет, перерисовывать нечего.
    if (!input.dryRun) revalidatePath("/domain/vendhub");
    return { ok: true, report };
  } catch (err) {
    if (err instanceof CoreUnavailable) return { ok: false, error: err.detail };
    return { ok: false, error: err instanceof Error ? err.message : "Импорт не удался" };
  }
}

/** Карточки реестра для товаров прайса (У6): план (dryRun) или запись. */
export async function ensureVendingCards(dryRun: boolean): Promise<{
  ok: boolean;
  error?: string;
  report?: { linked: string[]; created: string[]; ambiguous: string[]; already: number };
}> {
  try {
    const report = await core.vendingCards(dryRun);
    if (!dryRun) {
      revalidatePath("/stock/goods");
      revalidatePath("/domain/vendhub");
    }
    return { ok: true, report };
  } catch (err) {
    if (err instanceof CoreUnavailable) return { ok: false, error: err.detail };
    return { ok: false, error: err instanceof Error ? err.message : "Не удалось" };
  }
}
