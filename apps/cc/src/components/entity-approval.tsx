"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { approveEntity, approveField, rejectField } from "../app/sources/actions";
import type { Entity, EntityDraft } from "../lib/core";

/**
 * Что ждёт слова владельца по этой карточке.
 *
 * Правило простое и одно: данные по автоматам и товарам, вписанные не им,
 * фактом не считаются. Поэтому предложенное значение лежит РЯДОМ с карточкой, а
 * не в ней: пока оно здесь, всё, что считается поверх реестра — фискальная
 * готовность, журнал, сверки, — его не видит.
 *
 * Утвердил — значение переехало в карточку. Отклонил — ушло без следа в ней;
 * след остаётся в журнале действий, где ему и место.
 */
export function EntityApproval({ entity, drafts }: { entity: Entity; drafts: EntityDraft[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const act = (fn: () => Promise<{ ok: boolean; error?: string }>) => {
    setError(null);
    start(async () => {
      const res = await fn();
      if (res.ok) router.refresh();
      else setError(res.error ?? "Не получилось");
    });
  };

  const cardPending = entity.approvedAt === null || entity.approvedAt === undefined;
  if (!cardPending && drafts.length === 0) return null;

  return (
    <div className="sect appr">
      <div className="sect-h">
        <h3 className="h2">Ждёт твоего слова</h3>
        {cardPending && <span className="chip h">карточка не утверждена</span>}
        {drafts.length > 0 && (
          <span className="chip h">
            предложено значений: {drafts.length}
          </span>
        )}
      </div>

      {cardPending && (
        <p className="hint" style={{ marginBottom: 10 }}>
          Карточка заведена{entity.createdFrom ? ` из источника «${entity.createdFrom}»` : " не тобой"},
          поэтому записью реестра ещё не считается. Название и поля взяты у чужой
          системы — подтверди, что это верно.
        </p>
      )}

      {drafts.length > 0 && (
        <div className="maplist">
          {drafts.map((d) => (
            <div className="maprow hot" key={d.field}>
              <div className="mapv">
                <span className="mapl">{d.field}</span>
                <span className="mapc">{d.origin}</span>
              </div>
              <div className="mapt">
                <span className="mapc">сейчас:</span>
                <span className="mono">{d.current ?? "пусто"}</span>
                <span className="mapc">предложено:</span>
                <span className="mono warn">{d.value}</span>
                {d.note && <span className="mapc">{d.note}</span>}
              </div>
              <div className="pact">
                <button
                  type="button"
                  className="btn sm"
                  disabled={pending}
                  onClick={() => act(() => approveField(entity.id, d.field))}
                >
                  Утвердить
                </button>
                <button
                  type="button"
                  className="btn sm ghost"
                  disabled={pending}
                  onClick={() => act(() => rejectField(entity.id, d.field))}
                >
                  Отклонить
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="srcfa" style={{ marginTop: 10 }}>
        {cardPending && (
          <button
            type="button"
            className="btn sm"
            disabled={pending}
            onClick={() => act(() => approveEntity(entity.id))}
          >
            {drafts.length > 0 ? "Утвердить карточку и всё предложенное" : "Утвердить карточку"}
          </button>
        )}
        {error && <span className="err-text">{error}</span>}
      </div>
    </div>
  );
}
