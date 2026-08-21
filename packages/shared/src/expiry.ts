// Чистый расчёт срока годности партии (без Prisma).
// Срок = expiryAt ?? (manufactureAt | receivedAt) + shelfLifeDays. Флаги по горизонту.
//
// Перенесено ДОСЛОВНО из mydon_1 (~/Developer/mydon_1/src/lib/vendhub/product-stock/expiry.ts)
// без изменений — файл чистый (без Prisma/побочных эффектов), типы совместимы
// со срезом C «партии и сроки годности» (task-2, план 2026-08-21-sloy-C-batches-expiry).

export const DAY = 86400000;
export const DEFAULT_EXPIRING_DAYS = 14;

export type ExpiryFlag = "expired" | "expiring" | "ok" | "none";

export type BatchDates = {
  expiryAt: Date | null;
  manufactureAt: Date | null;
  receivedAt: Date;
};

/** Эффективный срок: явный expiryAt, иначе (производство|получение) + shelfLifeDays. */
export function effectiveExpiry(b: BatchDates, shelfLifeDays: number | null): Date | null {
  if (b.expiryAt) return b.expiryAt;
  if (shelfLifeDays === null || !Number.isFinite(shelfLifeDays) || shelfLifeDays <= 0) return null;
  const start = b.manufactureAt ?? b.receivedAt;
  return new Date(start.getTime() + Math.trunc(shelfLifeDays) * DAY);
}

/** Флаг по сроку: нет срока → none; прошёл → expired; в пределах threshold → expiring; иначе ok. */
export function expiryFlag(expiry: Date | null, now: Date, thresholdDays = DEFAULT_EXPIRING_DAYS): ExpiryFlag {
  if (!expiry) return "none";
  const diffDays = (expiry.getTime() - now.getTime()) / DAY;
  if (diffDays < 0) return "expired";
  if (diffDays <= thresholdDays) return "expiring";
  return "ok";
}

/** Порядок сортировки флагов в отчёте (сначала просроченное). */
export const FLAG_ORDER: Record<ExpiryFlag, number> = { expired: 0, expiring: 1, ok: 2, none: 3 };
