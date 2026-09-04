"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import Link from "next/link";
import { partLabel } from "@mydon/shared";
import type { PartUnit } from "../lib/core";
import { movePartUnit } from "../app/parts/actions";

/** Сколько суток узел лежит на этом месте — по началу открытого периода. */
export function daysSince(since: string | undefined, today: string): number | null {
  if (!since) return null;
  const a = Date.parse(`${since}T00:00:00Z`);
  const b = Date.parse(`${today}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.max(0, Math.round((b - a) / 86_400_000));
}

const дата = (d: string | undefined): string => (d ? d.split("-").reverse().join(".") : "—");

/**
 * Одна работа — одна кнопка (У3): на мойке жмут «Помыл», на сушке — «На склад».
 *
 * Дольше трёх суток на мойке — то же, о чём в понедельник напоминает `parts-audit`
 * у vendhub-ops: строка помечается тревожной, чтобы зависшая мойка была видна
 * здесь, а не только в задаче.
 */
export function WashingList({
  units,
  action,
  today,
  staleAfterDays = 3,
}: {
  units: PartUnit[];
  action: { to: "washed" | "warehouse"; label: string; okText: string };
  today: string;
  staleAfterDays?: number;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ id: string; kind: "ok" | "err"; text: string } | null>(null);

  if (units.length === 0) return null;

  return (
    <div className="rows">
      {units.map((u) => {
        const days = daysSince(u.where?.since, today);
        const stale = action.to === "washed" && days !== null && days > staleAfterDays;
        const note = msg?.id === u.id ? msg : null;
        return (
          <div key={u.id} className={`row${stale ? " hot" : ""}`}>
            <span className="t">
              <b>
                <Link href={`/parts/${u.id}`}>{u.inventoryNo ?? "без номера"}</Link>
              </b>
              <small>
                {partLabel(u.partKind)}
                {u.setNumber !== null ? ` · набор ${u.setNumber}` : ""}
                {u.partKind === "hopper" && u.tareWeight === null ? " · тара не внесена" : ""}
                {` · с ${дата(u.where?.since)}`}
                {days !== null ? ` · ${days} сут.` : ""}
              </small>
            </span>
            {note && <span className={note.kind === "ok" ? "ok-text" : "err-text"}>{note.text}</span>}
            <button
              type="button"
              className="btn sm"
              disabled={pending}
              onClick={() =>
                start(async () => {
                  const res = await movePartUnit(u.id, action.to);
                  setMsg({ id: u.id, kind: res.ok ? "ok" : "err", text: res.ok ? action.okText : (res.error ?? "Ошибка") });
                  if (res.ok) router.refresh();
                })
              }
            >
              {action.label}
            </button>
          </div>
        );
      })}
    </div>
  );
}
