import Link from "next/link";
import {
  core,
  CoreUnavailable,
  type Entity,
  type EntityDraft,
  type MachineProductPrice,
  type MachineStays,
  type RecipeView,
} from "../../../lib/core";
import { CoreDown } from "../../../components/core-down";
import { DeleteEntityButton } from "../../../components/entity-delete";
import { EntityEditor } from "../../../components/entity-editor";
import { StayTimeline } from "../../../components/machine-stays";
import { MachinePricesView } from "../../../components/prices-view";
import { EntityApproval } from "../../../components/entity-approval";
import { RecipeEditor, type IngredientOption } from "../../../components/recipe-editor";
import { DOMAIN_TITLES, typeOne } from "../../../lib/labels";
import { plural, when } from "../../../lib/format";

export const dynamic = "force-dynamic";

/**
 * Карточка записи реестра — как в ПО владельца: все поля на виду,
 * пополняются и меняются на месте.
 */
export default async function EntityCard({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  let entity: Entity;
  try {
    entity = await core.entity(id);
  } catch (err) {
    return <CoreDown detail={err instanceof CoreUnavailable ? err.detail : String(err)} />;
  }

  // История стоянок и цен нужна только автоматам и только если она вообще
  // собрана. Ошибка здесь не должна ронять карточку: это дополнение, а не её суть.
  let stays: MachineStays | null = null;
  let prices: MachineProductPrice[] = [];
  if (entity.type === "machine" && entity.externalRef) {
    const ref = entity.externalRef.toLowerCase();
    try {
      const { machines } = await core.rawStays("gjvending", "order_query");
      stays = machines.find((m) => m.serial.toLowerCase() === ref) ?? null;
    } catch {
      stays = null;
    }
    try {
      const { items } = await core.rawMachinePrices("gjvending", "order_query", entity.externalRef);
      prices = items;
    } catch {
      prices = [];
    }
  }

  // Что предложено этой карточке не владельцем. Ошибка здесь не должна ронять
  // карточку: это дополнение, а не её суть.
  let drafts: EntityDraft[] = [];
  try {
    drafts = await core.entityDrafts(entity.id);
  } catch {
    drafts = [];
  }

  const a = entity.attrs ?? {};
  const lat = a["широта"];
  const lng = a["долгота"];
  const hasGeo = typeof lat === "string" && typeof lng === "string" && lat.length > 0;

  // Рецепт показываем только у товара с принципом «рецепт»: состав из
  // ингредиентов и себестоимость. Ингредиенты берём того же направления —
  // из них собирается состав. Ошибка здесь не роняет карточку.
  const isRecipe = entity.type === "product" && a["вид"] === "рецепт";
  let recipe: RecipeView | null = null;
  let ingredients: IngredientOption[] = [];
  if (isRecipe) {
    try {
      recipe = await core.entityRecipe(entity.id);
    } catch {
      recipe = null;
    }
    try {
      const cards = entity.domain
        ? await core.entitiesOfType(entity.domain, "ingredient")
        : [];
      ingredients = cards.map((c) => ({ id: c.id, name: c.name, approved: c.approvedAt != null }));
    } catch {
      ingredients = [];
    }
  }

  return (
    <>
      <div className="page-head">
        <Link
          href={entity.domain ? `/domain/${entity.domain}?tab=catalog:${entity.type}` : "/registry"}
          className="back"
        >
          ← {entity.domain ? DOMAIN_TITLES[entity.domain] ?? entity.domain : "Реестр"}
        </Link>
        <h1>{entity.name}</h1>
        <p>
          {typeOne(entity.type)}
          {entity.domain ? ` · ${DOMAIN_TITLES[entity.domain] ?? entity.domain}` : ""}
          {` · обновлено ${when(entity.updatedAt)}`}
        </p>
      </div>

      <EntityApproval entity={entity} drafts={drafts} />

      {hasGeo && (
        <div className="card">
          <div className="result-title">Где стоит</div>
          <p>
            <a
              href={`https://maps.google.com/?q=${String(lat)},${String(lng)}`}
              target="_blank"
              rel="noreferrer"
            >
              Открыть точку на карте ({String(lat)}, {String(lng)})
            </a>
          </p>
        </div>
      )}

      {stays && (
        <div className="sect">
          <div className="sect-h">
            <h3 className="h2">Где стоял</h3>
            {stays.moves > 0 ? (
              <span className="chip b">переездов: {stays.moves}</span>
            ) : (
              <span className="chip">не переезжал</span>
            )}
          </div>
          <StayTimeline stays={stays.stays} />
          <p className="hint" style={{ marginTop: 8 }}>
            Восстановлено из заказов источника: адрес и время есть в каждом.
            Точка — период, а не одно значение: переставили автомат, начался новый отрезок.
          </p>
        </div>
      )}

      {prices.length > 0 && (
        <div className="sect">
          <div className="sect-h">
            <h3 className="h2">Чем торгует и почём</h3>
            <span className="chip b">
              {prices.length} {plural(prices.length, "товар", "товара", "товаров")}
            </span>
          </div>
          <MachinePricesView items={prices} />
          <p className="hint" style={{ marginTop: 8 }}>
            Цена восстановлена из заказов и, как точка, является периодом: пока её
            не поменяли, она держится. Сквозной срез — во вкладке «Источники → Цены».
          </p>
        </div>
      )}

      {isRecipe && recipe && (
        <RecipeEditor entity={{ id: entity.id }} ingredients={ingredients} recipe={recipe} />
      )}

      <EntityEditor entity={entity} />

      <DeleteEntityButton
        id={entity.id}
        domain={entity.domain ?? null}
        type={entity.type}
        name={entity.name}
      />
    </>
  );
}
