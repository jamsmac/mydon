import { normalizeMachineSerial, normalizeProductName } from "@mydon/shared";

/** Stable task source for the machine-owned low-stock lifecycle. */
export const VENDING_LOW_STOCK_ISSUE_SOURCE = "vending-low-stock-issue";

/** One durable issue represents the current refill work for one machine. */
export const VENDING_LOW_STOCK_ISSUE_KIND = "vending.low_stock";

/** Transition/failure events are separate from the existing briefing event. */
export const VENDING_LOW_STOCK_ISSUES_OPENED_EVENT = "vending.low_stock_issues.opened";
export const VENDING_LOW_STOCK_ISSUES_RESOLVED_EVENT = "vending.low_stock_issues.resolved";
export const VENDING_LOW_STOCK_ISSUES_FAILED_EVENT = "vending.low_stock_issues.failed";

/** Exact machine scope: product/day changes refresh the same refill task. */
export function lowStockIssueScope(serial: string): string {
  return normalizeMachineSerial(serial);
}

/** Exact product identity inside a machine-level issue payload. */
export function lowStockIssueProductScope(serial: string, productKey: string): string {
  return `${lowStockIssueScope(serial)}|${normalizeProductName(productKey)}`;
}

/** Stable task idempotency key; exported for guards, backfills and smoke checks. */
export function lowStockIssueTaskClientKey(fingerprint: string): string {
  return `${VENDING_LOW_STOCK_ISSUE_SOURCE}:${fingerprint}`;
}
