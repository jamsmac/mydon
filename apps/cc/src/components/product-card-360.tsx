import type { ReactNode } from "react";
import type { Entity } from "../lib/core";
import { CardTabs } from "./card-tabs";
import { when } from "../lib/format";

/** Категория товара: 10 — кофейные (горячие), 11 — прохладительные. */
const CAT_EMOJI: Record<number, string> = { 10: "☕", 11: "🥤" };
const CAT_LABEL: Record<number, string> = { 10: "Coffee", 11: "Drinks" };

const sum = (n: number) => n.toLocaleString("ru-RU");

/**
 * Карточка товара — та же логика, что у карточки автомата: шапка с главным,
 * кольцо полноты, KPI-плитки и вкладки. Разделы товара свои: рецепт (у товаров
 * с составом), где продаётся, продажи, паспорт.
 */
export function ProductCard360({
  entity,
  price,
  purchasePrice,
  recipeCost,
  recipeLines,
  menusCount,
  slotsCount,
  salesCount,
  photosCount,
  isRecipe,
  slots,
}: {
  entity: Entity;
  price: number | null;
  purchasePrice: number | null;
  /** Себестоимость по составу — у товаров-рецептов. */
  recipeCost: number | null;
  recipeLines: number;
  menusCount: number;
  slotsCount: number;
  salesCount: number | null;
  photosCount: number;
  isRecipe: boolean;
  slots: {
    recipe: ReactNode;
    menus: ReactNode;
    sales: ReactNode;
    passport: ReactNode;
  };
}) {
  const a = entity.attrs ?? {};
  const approved = entity.approvedAt != null;
  const catRaw = Number(a["категория"]);
  const cat = catRaw === 10 || catRaw === 11 ? catRaw : null;
  const ikpu = typeof a["ИКПУ"] === "string" && a["ИКПУ"].trim() !== "" ? a["ИКПУ"] : null;
  const маржа =
    price !== null && (recipeCost ?? purchasePrice) !== null
      ? price - (recipeCost ?? purchasePrice)!
      : null;

  // Полнота карточки: то, чего не хватает, чтобы товар считался заведённым.
  const метки: [boolean, string, string][] = [
    [approved, "Карточка не утверждена", "passport"],
    [price !== null, "Цена продажи не указана", "passport"],
    [cat !== null, "Категория не размечена (горячий/холодный)", "passport"],
    [ikpu !== null, "ИКПУ не заполнен — без него нет чека", "passport"],
    [menusCount > 0, "Не стоит ни в одном меню", "menus"],
    [photosCount > 0, "Нет фото", "passport"],
    isRecipe
      ? [recipeLines > 0, "Состав рецепта пуст", "recipe"]
      : [purchasePrice !== null, "Цена покупки не указана — не посчитать маржу", "passport"],
  ];
  const заполнено = метки.filter(([ok]) => ok).length;
  const pct = Math.round((заполнено / метки.length) * 100);
  const внимание = метки.filter(([ok]) => !ok);
  const r = 22;
  const c = 2 * Math.PI * r;

  return (
    <div className="mc">
      <header className="mc-hero">
        <div className="mc-ava" aria-hidden>
          {cat !== null ? CAT_EMOJI[cat] : "📦"}
        </div>
        <div className="mc-id">
          <h1>{entity.name}</h1>
          <p className="mc-sub">
            {price !== null ? `${sum(price)} сум` : "цена не указана"}
            {ikpu ? <> · ИКПУ <span className="mono">{ikpu}</span></> : null}
          </p>
          <div className="mc-badges">
            {cat !== null && <span className="chip b">{CAT_LABEL[cat]}</span>}
            {isRecipe ? (
              <span className="chip" data-mc-tab="recipe" role="button" tabIndex={0}>
                рецепт · {recipeLines} ингр.
              </span>
            ) : (
              <span className="chip">перепродажа</span>
            )}
            {!approved && (
              <span className="chip h" data-mc-tab="passport" role="button" tabIndex={0}>
                ждёт утверждения
              </span>
            )}
            {menusCount > 0 && (
              <span className="chip g" data-mc-tab="menus" role="button" tabIndex={0}>
                в меню {menusCount}
              </span>
            )}
          </div>
        </div>
        <div className="mc-ring" title={`Полнота карточки: ${pct}%`}>
          <svg width="52" height="52" aria-hidden>
            <circle cx="26" cy="26" r={r} fill="none" stroke="var(--line)" strokeWidth="5" />
            <circle
              cx="26"
              cy="26"
              r={r}
              fill="none"
              stroke="var(--accent)"
              strokeWidth="5"
              strokeDasharray={c}
              strokeDashoffset={c * (1 - pct / 100)}
              strokeLinecap="round"
            />
          </svg>
          <b className="mono">{pct}%</b>
        </div>
      </header>

      <div className="mc-meta">
        <span>
          обновлено <b>{when(entity.updatedAt)}</b>
        </span>
        {entity.createdFrom && (
          <span>
            источник <b>{entity.createdFrom}</b>
          </span>
        )}
      </div>

      <CardTabs
        items={[
          {
            key: "overview",
            label: "Обзор",
            content: (
              <>
                <div className="tiles mc-kpis">
                  <div className="tile">
                    <span className="lab">Цена продажи</span>
                    <div className="v">{price !== null ? sum(price) : "—"}</div>
                    <div className="foot">
                      <span className="mk" />
                      каталожная · её берут аппараты
                    </div>
                  </div>
                  <div className={`tile${маржа !== null && маржа <= 0 ? " is-hot" : ""}`}>
                    <span className="lab">{isRecipe ? "Себестоимость" : "Цена покупки"}</span>
                    <div className="v">
                      {(recipeCost ?? purchasePrice) !== null ? sum((recipeCost ?? purchasePrice)!) : "—"}
                    </div>
                    <div className="foot">
                      <span className="mk" />
                      {маржа !== null ? `маржа ${sum(маржа)}` : isRecipe ? "по составу" : "не указана"}
                    </div>
                  </div>
                  <div className="tile" data-mc-tab="menus" role="button" tabIndex={0}>
                    <span className="lab">В меню</span>
                    <div className="v">{menusCount}</div>
                    <div className="foot">
                      <span className="mk" />
                      аппаратов{slotsCount > 0 ? ` · слотов ${slotsCount}` : ""}
                      <span className="go">→</span>
                    </div>
                  </div>
                  {salesCount !== null && (
                    <div className="tile" data-mc-tab="sales" role="button" tabIndex={0}>
                      <span className="lab">Продано · 90 дней</span>
                      <div className="v">{sum(salesCount)}</div>
                      <div className="foot">
                        <span className="mk" />
                        по журналу продаж<span className="go">→</span>
                      </div>
                    </div>
                  )}
                  {isRecipe && (
                    <div className="tile" data-mc-tab="recipe" role="button" tabIndex={0}>
                      <span className="lab">Рецепт</span>
                      <div className="v">{recipeLines}</div>
                      <div className="foot">
                        <span className="mk" />
                        ингредиентов<span className="go">→</span>
                      </div>
                    </div>
                  )}
                </div>

                <div className="mc-grid">
                  <div className="card">
                    <h3 className="h2">Требует внимания</h3>
                    {внимание.length === 0 ? (
                      <p className="hint">Карточка заполнена — дозаполнять нечего.</p>
                    ) : (
                      <div className="rows">
                        {внимание.map(([, text, tab]) => (
                          <div className="row mc-attn" key={text} data-mc-tab={tab} role="button" tabIndex={0}>
                            <div className="t">
                              <b>{text}</b>
                            </div>
                            <span className="pill">исправить →</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </>
            ),
          },
          ...(isRecipe
            ? [
                {
                  key: "recipe",
                  label: "Рецепт",
                  badge: recipeLines > 0 ? String(recipeLines) : undefined,
                  content: slots.recipe,
                },
              ]
            : []),
          {
            key: "menus",
            label: "Где продаётся",
            badge: menusCount > 0 ? String(menusCount) : undefined,
            content: slots.menus,
          },
          { key: "sales", label: "Продажи", content: slots.sales },
          { key: "passport", label: "Паспорт", content: slots.passport },
        ]}
      />
    </div>
  );
}
