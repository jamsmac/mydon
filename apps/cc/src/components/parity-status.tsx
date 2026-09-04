import type { VendingParityStatus } from "../lib/core";

const СЛОВА: Record<Exclude<VendingParityStatus, "ok" | "mismatch">, string> = {
  no_row: "нет строки в таблице",
  no_card: "нет карточки",
  inactive_with_stock: "неактивен, но есть остаток",
  no_warehouse: "склад не выбран",
};

/** Статус строки сверки словами: пустота в таблице — тоже статус, а не «сходится». */
export function ParityStatusPill({ status, diff }: { status: VendingParityStatus; diff: number | null }) {
  if (status === "ok") return <span className="pill ok">сходится</span>;
  if (status === "mismatch") return <span className="pill bad">{diff !== null && diff > 0 ? `+${diff}` : String(diff)}</span>;
  const тревожно = status === "inactive_with_stock" || status === "no_row";
  return <span className={`pill ${тревожно ? "bad" : "act"}`}>{СЛОВА[status]}</span>;
}
