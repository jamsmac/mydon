import Link from "next/link";
import {
  core,
  CoreUnavailable,
  type Attachment,
  type Entity,
  type EntityDraft,
  type MachineProductPrice,
  type MachineStays,
  type RecipeView,
  type IngredientStock,
  type WarehouseStock,
} from "../../../lib/core";
import { CoreDown } from "../../../components/core-down";
import { PhotoGallery } from "../../../components/photo-gallery";
import { CardToc } from "../../../components/card-toc";
import { DeleteEntityButton } from "../../../components/entity-delete";
import { EntityEditor } from "../../../components/entity-editor";
import { StayTimeline } from "../../../components/machine-stays";
import { MachinePricesView } from "../../../components/prices-view";
import { EntityApproval } from "../../../components/entity-approval";
import { RecipeEditor, type IngredientOption } from "../../../components/recipe-editor";
import { PlanogramEditor } from "../../../components/planogram-editor";
import { StocktakeSession } from "../../../components/stocktake-session";
import { parsePlanogram } from "@mydon/shared";
import { StockPanel, type WarehouseOption } from "../../../components/stock-panel";
import { WarehouseStockView } from "../../../components/warehouse-stock";
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

  // Фото карточки (приложил сотрудник при заведении). Дополнение — ошибка не
  // должна ронять карточку.
  let photos: Attachment[] = [];
  try {
    photos = await core.attachments("entity", entity.id);
  } catch {
    photos = [];
  }

  const a = entity.attrs ?? {};
  // Источник истины — типизированная точка (проверена по диапазону на записи).
  // Пока карточка не мигрировала — принимаем координаты из attrs (строкой/числом).
  const coord = (v: unknown): string | null =>
    typeof v === "number" && Number.isFinite(v)
      ? String(v)
      : typeof v === "string" && v.trim().length > 0
        ? v.trim()
        : null;
  const lat = entity.geo ? String(entity.geo.lat) : coord(a["широта"]);
  const lng = entity.geo ? String(entity.geo.lng) : coord(a["долгота"]);
  const hasGeo = lat !== null && lng !== null;

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

  // Склад ингредиента: остаток по складам + приход. Список складов того же
  // направления — на них заводится приход. Ошибка здесь не роняет карточку.
  const isIngredient = entity.type === "ingredient";
  let stock: IngredientStock | null = null;
  let warehouses: WarehouseOption[] = [];
  if (isIngredient) {
    try {
      stock = await core.ingredientStock(entity.id);
    } catch {
      stock = null;
    }
    try {
      const cards = entity.domain ? await core.entitiesOfType(entity.domain, "warehouse") : [];
      warehouses = cards.map((c) => ({ id: c.id, name: c.name }));
    } catch {
      warehouses = [];
    }
  }

  // Остаток склада: что и сколько лежит.
  const isWarehouse = entity.type === "warehouse";
  let warehouseStock: WarehouseStock | null = null;
  if (isWarehouse) {
    try {
      warehouseStock = await core.warehouseStock(entity.id);
    } catch {
      warehouseStock = null;
    }
  }

  // Планограмма автомата: какой товар в каком слоте. Товары того же направления —
  // из них расставляется раскладка. Ошибка здесь не роняет карточку.
  const isMachine = entity.type === "machine";
  let planogramProducts: { id: string; name: string; approved: boolean }[] = [];
  if (isMachine) {
    try {
      const cards = entity.domain ? await core.entitiesOfType(entity.domain, "product") : [];
      planogramProducts = cards.map((c) => ({
        id: c.id,
        name: c.name,
        approved: c.approvedAt != null,
      }));
    } catch {
      planogramProducts = [];
    }
  }
  const planogram = parsePlanogram(entity.attrs);

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

      <CardToc />

      <section id="appr" data-toc="Утверждение">
        <EntityApproval entity={entity} drafts={drafts} />
      </section>

      <section id="photo" data-toc="Фото">
        <PhotoGallery attachments={photos} />
      </section>

      {hasGeo && (
        <div className="card" id="geo" data-toc="Где стоит">
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
        <div className="sect" id="stays" data-toc="Где стоял">
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
        <div className="sect" id="prices" data-toc="Цены">
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

      {isMachine && (
        <PlanogramEditor
          entity={{ id: entity.id }}
          products={planogramProducts}
          planogram={planogram}
        />
      )}

      {isRecipe && recipe && (
        <section id="recipe" data-toc="Рецепт">
          <RecipeEditor entity={{ id: entity.id }} ingredients={ingredients} recipe={recipe} />
        </section>
      )}

      {isIngredient && stock && (
        <section id="stock" data-toc="Склад">
          <StockPanel
            ingredientId={entity.id}
            baseUnitHint={stock.baseUnit}
            stock={stock}
            warehouses={warehouses}
          />
        </section>
      )}

      {isWarehouse && warehouseStock && (
        <section id="whstock" data-toc="Остаток">
          <WarehouseStockView stock={warehouseStock} />
        </section>
      )}

      {isWarehouse && warehouseStock && warehouseStock.items.length > 0 && (
        <StocktakeSession warehouseId={entity.id} items={warehouseStock.items} />
      )}

      <section id="fields" data-toc="Поля">
        <EntityEditor entity={entity} />
      </section>

      <DeleteEntityButton
        id={entity.id}
        domain={entity.domain ?? null}
        type={entity.type}
        name={entity.name}
      />
    </>
  );
}
