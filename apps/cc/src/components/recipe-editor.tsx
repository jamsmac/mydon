"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { UNITS, type Unit } from "@mydon/shared";
import { saveRecipe } from "../app/card/actions";
import type { RecipeView } from "../lib/core";

/** Ингредиент, из которого можно собрать состав. */
export interface IngredientOption {
  id: string;
  name: string;
  /** Карточка утверждена владельцем. false — заведена не им, ждёт слова. */
  approved: boolean;
}

interface Line {
  ingredientId: string;
  quantity: string;
  unit: Unit | "";
}

const sum = (n: number) => `${Math.round(n).toLocaleString("ru-RU")} сум`;

/**
 * Состав рецепта и его себестоимость.
 *
 * Себестоимость считает Core на чтении из текущих цен ингредиентов (`recipe`) —
 * здесь мы её только показываем. Правка состава уходит отдельным сохранением и
 * не трогает прочие поля карточки; после сохранения страница перечитывает
 * пересчитанную себестоимость.
 */
export function RecipeEditor({
  entity,
  ingredients,
  recipe,
}: {
  entity: { id: string };
  ingredients: IngredientOption[];
  recipe: RecipeView;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [lines, setLines] = useState<Line[]>(
    recipe.lines.map((l) => ({
      ingredientId: l.ingredientId,
      quantity: String(l.quantity),
      unit: (UNITS as readonly string[]).includes(l.unit) ? (l.unit as Unit) : "",
    })),
  );

  const nameOf = new Map(ingredients.map((i) => [i.id, i.name]));

  function set(i: number, patch: Partial<Line>) {
    setLines((prev) => prev.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  }
  function add() {
    setLines((prev) => [...prev, { ingredientId: "", quantity: "", unit: "" }]);
  }
  function remove(i: number) {
    setLines((prev) => prev.filter((_, j) => j !== i));
  }

  function onSave() {
    start(async () => {
      const payload = lines
        .map((l) => ({ ingredientId: l.ingredientId, quantity: Number(l.quantity), unit: l.unit }))
        .filter((l) => l.ingredientId && Number.isFinite(l.quantity) && l.quantity > 0 && l.unit);
      const res = await saveRecipe(entity.id, payload);
      setMsg(res.ok ? { ok: true, text: "Состав сохранён" } : { ok: false, text: res.error ?? "Ошибка" });
      if (res.ok) router.refresh();
    });
  }

  const noIngredients = ingredients.length === 0;

  return (
    <div className="sect">
      <div className="sect-h">
        <h3 className="h2">Рецепт</h3>
        {recipe.unresolved > 0 ? (
          <span className="chip b">себестоимость неполна</span>
        ) : recipe.lines.length > 0 ? (
          <span className="chip">себестоимость: {sum(recipe.total)}</span>
        ) : (
          <span className="chip">состав пуст</span>
        )}
      </div>

      {/* Посчитанная себестоимость — из текущих цен ингредиентов, слева направо
          как в паспорте. Строки, что посчитать не удалось, названы честно. */}
      {recipe.lines.length > 0 && (
        <div className="pass" style={{ marginBottom: 12 }}>
          {recipe.lines.map((l, i) => (
            <div className="f" key={i}>
              <div className="k">
                {/* Имя — ссылка на карточку: из состава к остатку и приходу
                    ингредиента вёл только поиск, теперь один клик. */}
                {l.ingredientName ? (
                  <Link href={`/card/${l.ingredientId}`}>{l.ingredientName}</Link>
                ) : (
                  "ингредиент удалён"
                )}
                {!l.approved && l.ingredientName ? " (ждёт утверждения)" : ""}
              </div>
              <div className="val">
                {l.quantity} {l.unit}
                {l.cost !== null ? ` · ${sum(l.cost)}` : l.why ? ` · ${l.why}` : ""}
              </div>
            </div>
          ))}
          <div className="f">
            <div className="k">
              <b>Себестоимость</b>
            </div>
            <div className="val">
              <b>{sum(recipe.total)}</b>
              {recipe.unresolved > 0
                ? ` · не посчитано строк: ${recipe.unresolved}`
                : ""}
            </div>
          </div>
        </div>
      )}

      {noIngredients ? (
        <p className="hint">
          Ингредиентов пока нет. Заведи карточки с типом «ингредиент» (цена покупки и
          единица) — из них и собирается состав.
        </p>
      ) : (
        <>
          {lines.map((l, i) => (
            <div key={i} style={{ display: "flex", gap: 8, marginBottom: 8, alignItems: "flex-end" }}>
              <label style={{ flex: 2 }}>
                <span>Ингредиент</span>
                <select
                  value={l.ingredientId}
                  onChange={(e) => set(i, { ingredientId: e.target.value })}
                >
                  <option value="">— выбери —</option>
                  {/* Уже удалённый из справочника ингредиент всё равно показываем,
                      чтобы строку не подменило молча. */}
                  {l.ingredientId && !nameOf.has(l.ingredientId) && (
                    <option value={l.ingredientId}>ингредиент удалён</option>
                  )}
                  {ingredients.map((ing) => (
                    <option value={ing.id} key={ing.id}>
                      {ing.name}
                      {ing.approved ? "" : " (ждёт утверждения)"}
                    </option>
                  ))}
                </select>
              </label>
              <label style={{ flex: 1 }}>
                <span>Сколько</span>
                <input
                  value={l.quantity}
                  inputMode="decimal"
                  onChange={(e) => set(i, { quantity: e.target.value })}
                  placeholder="18"
                />
              </label>
              <label style={{ flex: 1 }}>
                <span>Единица</span>
                <select value={l.unit} onChange={(e) => set(i, { unit: e.target.value as Unit })}>
                  <option value="">—</option>
                  {UNITS.map((u) => (
                    <option value={u} key={u}>
                      {u}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                className="btn ghost"
                onClick={() => remove(i)}
                aria-label="Убрать строку"
              >
                ✕
              </button>
            </div>
          ))}

          <div style={{ display: "flex", gap: 9, marginTop: 6, flexWrap: "wrap" }}>
            <button type="button" className="btn" onClick={add}>
              + Ингредиент
            </button>
            <button type="button" className="btn pri" onClick={onSave} disabled={pending}>
              {pending ? "Сохраняю…" : "Сохранить состав"}
            </button>
            {msg && <span className={msg.ok ? "ok-text" : "err-text"}>{msg.text}</span>}
          </div>
          <p className="hint" style={{ marginTop: 8 }}>
            Количество — на одну порцию товара. Себестоимость считается из цены покупки
            ингредиента: положишь 18&nbsp;г зёрен при цене 80&nbsp;000 сум за «кг» — выйдет
            1&nbsp;440 сум. Расход по продажам добавим следующим шагом.
          </p>
        </>
      )}
    </div>
  );
}
