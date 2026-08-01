"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { PRODUCT_KINDS, PRODUCT_KIND_LABELS, RESALE_FIELDS } from "@mydon/shared";
import { saveEntity } from "../app/card/actions";
import type { Entity } from "../lib/core";
import { MONO_KEYS } from "../lib/labels";

const mono = { fontFamily: "'IBM Plex Mono', ui-monospace, monospace" } as const;

/**
 * Поля карточки товара, которыми управляет отдельный блок «Товар»: принцип
 * (перепродажа/рецепт), перепродажные поля и авто-история цены покупки. Их
 * убираем из общего списка attrs, чтобы не задвоить те же поля.
 */
const PRODUCT_KEYS = new Set<string>(["вид", ...RESALE_FIELDS, "история цены покупки"]);

/**
 * Редактор карточки: как в ПО владельца — поля пополняются и меняются на месте.
 * Пустое значение убирает поле; внизу можно добавить новое.
 */
export function EntityEditor({ entity }: { entity: Entity }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [adding, setAdding] = useState(false);

  function onSave(form: FormData) {
    start(async () => {
      const res = await saveEntity(entity.id, form);
      setMsg(res.ok ? { ok: true, text: "Сохранено" } : { ok: false, text: res.error ?? "Ошибка" });
      if (res.ok) {
        setAdding(false);
        setEditing(false);
        router.refresh();
      }
    });
  }

  const isProduct = entity.type === "product";
  const attrsAll = Object.entries(entity.attrs ?? {});
  // У товара принцип и перепродажные поля живут в своём блоке; из общего списка
  // их убираем, иначе те же поля появятся дважды.
  const attrs = isProduct ? attrsAll.filter(([k]) => !PRODUCT_KEYS.has(k)) : attrsAll;
  const [editing, setEditing] = useState(false);
  const initialKind = typeof entity.attrs?.["вид"] === "string" ? String(entity.attrs["вид"]) : "";
  const [kind, setKind] = useState(initialKind);
  const buyHistory = entity.attrs?.["история цены покупки"];

  // Сначала ЧТЕНИЕ — паспорт записи, как в дизайне. Правка — по кнопке.
  if (!editing) {
    return (
      <>
        <div className="pass">
          <div className="f">
            <div className="k">Название</div>
            <div className="val">{entity.name}</div>
          </div>
          <div className="f">
            <div className="k">Номер / код</div>
            <div className="val mono">{entity.externalRef ?? "—"}</div>
          </div>
          {attrsAll.map(([key, value]) => (
            <div className="f" key={key}>
              <div className="k">{key === "вид" ? "Принцип карточки" : key}</div>
              <div className={`val ${MONO_KEYS.has(key) ? "mono" : ""}`}>
                {key === "вид" && typeof value === "string" && value in PRODUCT_KIND_LABELS
                  ? PRODUCT_KIND_LABELS[value as keyof typeof PRODUCT_KIND_LABELS]
                  : (key === "цена" || key === "цена покупки" || key === "цена продажи") &&
                      typeof value === "number"
                    ? `${Number(value).toLocaleString("ru-RU")} сум`
                    : String(value ?? "—")}
              </div>
            </div>
          ))}
        </div>
        <div style={{ display: "flex", gap: 9, marginTop: 14, flexWrap: "wrap" }}>
          <button type="button" className="btn pri" onClick={() => setEditing(true)}>
            Изменить
          </button>
        </div>
        {msg && <p className={msg.ok ? "ok-text" : "err-text"}>{msg.text}</p>}
      </>
    );
  }

  return (
    <form action={onSave} className="form card">
      <label>
        <span>Название</span>
        <input name="name" defaultValue={entity.name} />
      </label>
      <label>
        <span>Номер (серийник, ИНН, штрих-код)</span>
        <input name="externalRef" defaultValue={entity.externalRef ?? ""} style={mono} />
      </label>

      {isProduct && (
        <fieldset className="form card" style={{ margin: 0 }}>
          <legend>Товар</legend>
          <label>
            <span>Принцип карточки</span>
            <select name="attr:вид" value={kind} onChange={(e) => setKind(e.target.value)}>
              <option value="">— не выбран —</option>
              {PRODUCT_KINDS.map((k) => (
                <option value={k} key={k}>
                  {PRODUCT_KIND_LABELS[k]}
                </option>
              ))}
            </select>
            <small className="hint">
              Перепродажа — куплен и продан как есть (нужна цена покупки). Рецепт —
              готовится из ингредиентов (состав добавим следующим шагом).
            </small>
          </label>

          {kind === "перепродажа" &&
            RESALE_FIELDS.map((f) => (
              <label key={f}>
                <span>{f}</span>
                <input
                  name={`attr:${f}`}
                  defaultValue={String(entity.attrs?.[f] ?? "")}
                  inputMode={f.startsWith("цена") ? "numeric" : undefined}
                />
              </label>
            ))}

          {typeof buyHistory === "string" && buyHistory.length > 0 && (
            <>
              {/* Историю ведёт Core сам; сохраняем её скрытым полем, иначе форма,
                  собирающая attrs заново, затёрла бы её. */}
              <input type="hidden" name="attr:история цены покупки" value={buyHistory} />
              <p className="hint">
                История цены покупки: <b>{buyHistory}</b>. Ведётся сама при смене цены —
                менять руками не нужно.
              </p>
            </>
          )}
        </fieldset>
      )}

      {attrs.map(([key, value]) => (
        <label key={key}>
          <span>{key}</span>
          <input
            name={`attr:${key}`}
            defaultValue={String(value ?? "")}
            style={MONO_KEYS.has(key) ? mono : undefined}
          />
          <small className="hint">Очисти поле и сохрани — оно исчезнет из карточки.</small>
        </label>
      ))}

      {adding ? (
        <div style={{ display: "flex", gap: 8 }}>
          <label style={{ flex: 1 }}>
            <span>Новое поле</span>
            <input name="newKey" placeholder="например: объём" autoFocus />
          </label>
          <label style={{ flex: 1 }}>
            <span>Значение</span>
            <input name="newValue" placeholder="0.5 л" />
          </label>
        </div>
      ) : (
        <button type="button" className="btn" onClick={() => setAdding(true)}>
          + Поле
        </button>
      )}

      <div className="form-actions">
        <button type="submit" className="btn primary" disabled={pending}>
          {pending ? "Сохраняю…" : "Сохранить"}
        </button>
        <button type="button" className="btn ghost" onClick={() => setEditing(false)}>
          Отмена
        </button>
        {msg && <span className={msg.ok ? "ok-text" : "err-text"}>{msg.text}</span>}
      </div>
    </form>
  );
}
