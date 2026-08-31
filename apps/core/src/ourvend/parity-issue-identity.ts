import { normalizeMachineSerial, normalizeProductName } from "@mydon/shared";

/** Reserved task source for the machine-owned parity lifecycle. */
export const PARITY_ISSUE_SOURCE = "ourvend-parity-issue";

/** Transition/failure event types shared with notification rules without a service cycle. */
export const PARITY_ISSUES_OPENED_EVENT = "ourvend.parity_issues.opened";
export const PARITY_ISSUES_RESOLVED_EVENT = "ourvend.parity_issues.resolved";
export const PARITY_ISSUES_FAILED_EVENT = "ourvend.parity_issues.failed";

/** Exact machine/day scope that proves whether a stored parity issue was observed. */
export function parityIssueScope(dt: string, serial: string): string {
  return `${dt}|${normalizeMachineSerial(serial)}`;
}

/** Exact product identity used only to deduplicate details inside a machine/day issue. */
export function parityStockIssueScope(dt: string, serial: string, product: string): string {
  return `${parityIssueScope(dt, serial)}|${normalizeProductName(product)}`;
}
