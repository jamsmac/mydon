"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { approveEntity, approveField, rejectField } from "../app/sources/actions";
import type { ActionResult } from "../app/sources/actions";
import type { Attachment, Entity, EntityDraft } from "../lib/core";
import { typeOne } from "../lib/labels";

/**
 * Ссылка на файл вложения для браузера.
 *
 * Абсолютную (presigned S3) отдаём как есть; относительный путь Core проксируем
 * через маршрут панели — Core наружу закрыт. То же правило, что в галерее фото.
 */
function srcOf(a: Attachment): string {
  return /^https?:\/\//.test(a.url) ? a.url : `/api/attachments/${a.id}/raw`;
}

/** Общий запуск действия: показать ошибку словами, обновить страницу при успехе. */
function useAct() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const act = (fn: () => Promise<ActionResult>) => {
    setError(null);
    start(async () => {
      const res = await fn();
      if (res.ok) router.refresh();
      else setError(res.error ?? "Не получилось");
    });
  };
  return { pending, error, act };
}

/**
 * Карточка-черновик в очереди: заведена не владельцем, ждёт его слова.
 *
 * Фото сотрудника — рядом с именем: «что за ингредиент завели» отвечает снимок,
 * а не только строка. Утвердить можно прямо отсюда, не открывая карточку; ссылка
 * «открыть» остаётся для тех случаев, когда одного взгляда мало.
 */
export function PendingCardTile({
  card,
  photos,
}: {
  card: Entity;
  photos: Attachment[];
}) {
  const { pending, error, act } = useAct();
  const shots = photos.filter((p) => p.kind === "photo");

  return (
    <div className="qcard">
      <div className="qcard-h">
        <div className="qcard-t">
          <Link href={`/card/${card.id}`} className="qcard-name">
            {card.name}
          </Link>
          <span className="mapc">
            {typeOne(card.type)}
            {card.createdFrom ? ` · из источника «${card.createdFrom}»` : " · заведено не тобой"}
          </span>
        </div>
        {shots.length > 0 && (
          <span className="chip">
            {shots.length} фото
          </span>
        )}
      </div>

      {shots.length > 0 && (
        <div className="qshots">
          {shots.slice(0, 4).map((a) => {
            const src = srcOf(a);
            return (
              <a key={a.id} href={src} target="_blank" rel="noreferrer" className="photo-thumb">
                {/* Обычный <img>: файлы приватны и идут через прокси панели. */}
                <img src={src} alt="Фото номенклатуры" loading="lazy" />
              </a>
            );
          })}
          {shots.length > 4 && <span className="qmore">+{shots.length - 4}</span>}
        </div>
      )}

      <div className="qcard-a">
        <button
          type="button"
          className="btn sm ok"
          disabled={pending}
          onClick={() => act(() => approveEntity(card.id))}
        >
          Утвердить
        </button>
        <Link href={`/card/${card.id}`} className="btn sm ghost">
          Открыть
        </Link>
        {error && <span className="err-text">{error}</span>}
      </div>
    </div>
  );
}

/**
 * Предложенные значения одной карточки: подтвердить или отклонить по одному.
 *
 * Значение лежит РЯДОМ с карточкой и фактом не считается, пока владелец не
 * сказал слова. Утвердил — переехало в карточку; отклонил — ушло без следа в
 * ней, след остаётся в журнале.
 */
export function PendingFieldGroup({
  entityId,
  entityName,
  entityType,
  fields,
}: {
  entityId: string;
  entityName: string;
  entityType: string;
  fields: EntityDraft[];
}) {
  const { pending, error, act } = useAct();

  return (
    <div className="qcard">
      <div className="qcard-h">
        <div className="qcard-t">
          <Link href={`/card/${entityId}`} className="qcard-name">
            {entityName}
          </Link>
          <span className="mapc">
            {typeOne(entityType)} · предложено значений: {fields.length}
          </span>
        </div>
      </div>

      <div className="maplist">
        {fields.map((d) => (
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
                onClick={() => act(() => approveField(entityId, d.field))}
              >
                Утвердить
              </button>
              <button
                type="button"
                className="btn sm ghost"
                disabled={pending}
                onClick={() => act(() => rejectField(entityId, d.field))}
              >
                Отклонить
              </button>
            </div>
          </div>
        ))}
      </div>
      {error && (
        <div style={{ marginTop: 8 }}>
          <span className="err-text">{error}</span>
        </div>
      )}
    </div>
  );
}
