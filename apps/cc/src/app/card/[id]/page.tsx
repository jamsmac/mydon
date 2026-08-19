import Link from "next/link";
import {
  core,
  CoreUnavailable,
  type Attachment,
  type CoffeePlacementRow,
  type Entity,
  type EntityDraft,
  type MachineProductPrice,
  type MachineStays,
  type RecipeView,
  type IngredientStock,
  type WarehouseStock,
  type FinanceFlow,
  type GrContract,
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
import { MachineCardPanel } from "../../../components/machine-card-panel";
import { MachinePartsPanel } from "../../../components/machine-parts-panel";
import { StocktakeSession } from "../../../components/stocktake-session";
import { PLACE_TYPES, parsePlanogram, parseRecipe } from "@mydon/shared";
import { StockPanel, type WarehouseOption } from "../../../components/stock-panel";
import {
  ContractorFinance,
  IngredientUsage,
  ProductEconomy,
  ProductFiscal,
  ProductMachines,
  type IngredientUsageRow,
  type ProductMachineRow,
} from "../../../components/product-card-sections";
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

  // Кофе-размещения: на каких кофе-точках этот аппарат работал (история с
  // периодами, ведёт привязка в Кофе-бункерах). Дополнение — ошибка не роняет.
  let coffeePlacements: CoffeePlacementRow[] = [];
  // Места, куда автомат можно поставить: точки продаж, склады, мастерские.
  // Нужны при смене состояния — «в ремонте» без адреса теряет автомат из виду.
  let places: { id: string; name: string; type: string }[] = [];
  if (entity.type === "machine") {
    try {
      coffeePlacements = (await core.coffeePlacements()).filter((p) => p.entityId === entity.id);
    } catch {
      coffeePlacements = [];
    }
    // Направление у карточки может быть не проставлено — тогда списка мест
    // просто не будет, а выбор скроется. Молча подставить «vendhub» нельзя:
    // это показало бы чужие склады как свои.
    const domain = entity.domain;
    if (domain) {
      try {
        const списки = await Promise.all(
          PLACE_TYPES.map(async (t) =>
            (await core.entitiesOfType(domain, t)).map((e) => ({ id: e.id, name: e.name, type: t })),
          ),
        );
        places = списки.flat().sort((a, b) => a.name.localeCompare(b.name, "ru"));
      } catch {
        places = [];
      }
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
  // «В каких рецептах» — обратный разбор составов товаров направления.
  let ingredientUsage: IngredientUsageRow[] = [];
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
    // Обратная связь «в каких рецептах»: состав лежит в attrs товаров, поэтому
    // это чтение реестра, а не новый эндпоинт.
    try {
      const товары = entity.domain ? await core.entitiesOfType(entity.domain, "product") : [];
      ingredientUsage = товары.flatMap((p) =>
        parseRecipe(p.attrs)
          .filter((l) => l.ingredientId === entity.id)
          .map((l) => ({ productId: p.id, productName: p.name, quantity: l.quantity, unit: l.unit })),
      );
    } catch {
      ingredientUsage = [];
    }
  }

  // Товар: в каких автоматах стоит — обратный разбор раскладок всех автоматов
  // направления. Данные уже в реестре, эндпоинт не нужен. Дополнение — ошибка
  // не роняет карточку.
  const isProduct = entity.type === "product";
  let productMachines: ProductMachineRow[] = [];
  if (isProduct && entity.domain) {
    try {
      const машины = await core.entitiesOfType(entity.domain, "machine");
      productMachines = машины.flatMap((m) =>
        parsePlanogram(m.attrs)
          .filter((p) => p.productId === entity.id)
          .map((p) => ({ machineId: m.id, machineName: m.name, slot: p.slot })),
      );
    } catch {
      productMachines = [];
    }
  }

  // Контрагент: договоры и платежи из финансового контура. Связь — по имени:
  // финансовый справочник контрагентов ведётся отдельно от реестра, и id у них
  // разные. Дополнение — ошибка не роняет карточку.
  const isContractor = entity.type === "contractor";
  let contractorContracts: GrContract[] = [];
  let contractorFlows: FinanceFlow[] = [];
  if (isContractor && entity.domain) {
    try {
      const имя = entity.name.trim().toLowerCase();
      const [стороны, потоки, договоры] = await Promise.all([
        core.financeCounterparties(entity.domain),
        core.financeFlows(entity.domain),
        core.contracts(entity.domain),
      ]);
      const своя = стороны.find((c) => c.name.trim().toLowerCase() === имя) ?? null;
      contractorFlows = потоки.filter(
        (f) =>
          (своя !== null && f.counterpartyId === своя.id) ||
          f.counterparty?.trim().toLowerCase() === имя ||
          f.counterpartyEntityName?.trim().toLowerCase() === имя,
      );
      contractorContracts = договоры.filter((c) => своя !== null && c.clientId === своя.id);
    } catch {
      contractorContracts = [];
      contractorFlows = [];
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

  // Карточка автомата: вид и состояние. Ошибка чтения не роняет страницу —
  // блок просто не покажется, остальное о карточке важнее.
  let machineCard: Awaited<ReturnType<typeof core.machineCard>> = null;
  if (isMachine) {
    try {
      machineCard = await core.machineCard(entity.id);
    } catch {
      machineCard = null;
    }
  }

  // Узлы автомата (периоды) + склад свободных узлов для установки.
  // Дополнение — ошибка не роняет карточку.
  let machineParts: Awaited<ReturnType<typeof core.machineParts>> = [];
  let partsStorage: Awaited<ReturnType<typeof core.machinePartsStorage>> = [];
  if (isMachine) {
    try {
      [machineParts, partsStorage] = await Promise.all([
        core.machineParts(entity.id),
        core.machinePartsStorage(),
      ]);
    } catch {
      machineParts = [];
      partsStorage = [];
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

      <CardToc />

      <section id="appr" data-toc="Утверждение">
        <EntityApproval entity={entity} drafts={drafts} />
      </section>

      <section id="photo" data-toc="Фото">
        <PhotoGallery attachments={photos} />
      </section>

      {isContractor && <ContractorFinance contracts={contractorContracts} flows={contractorFlows} />}

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

      {isMachine && (
        <div className="sect" id="placements" data-toc="Где стоит">
          <div className="sect-h">
            <h3 className="h2">Где стоит</h3>
            {coffeePlacements.length > 0 && (
              <span className="chip b">периодов: {coffeePlacements.length}</span>
            )}
          </div>
          {coffeePlacements.length === 0 ? (
            /*
              Пустой раздел показываем НАРОЧНО. Раньше он просто исчезал, и
              аппарат без места выглядел так же, как аппарат на месте, — а это
              разные вещи: во втором случае мы знаем, где он, в первом нет.
            */
            <div className="empty">
              <b>Место не записано</b>
              Неизвестно, где этот аппарат. Поставьте его на место в разделе «Автомат»
              (склад, мастерская или точка продаж) — тогда он появится на карте и в отчётах по точке.
            </div>
          ) : (
            <div className="rows">
              {coffeePlacements.map((p) => (
                <div className="row" key={p.id}>
                  <div className="t">
                    <b>{p.locationName}</b>
                    <small>
                      {p.startDate ?? "с неизвестной даты"} — {p.endDate ?? "сейчас"}
                      {p.note ? ` · ${p.note}` : ""}
                    </small>
                  </div>
                  <span className={`pill ${p.endDate === null ? "ok" : ""}`}>
                    {p.endDate === null ? "стоит сейчас" : "история"}
                  </span>
                </div>
              ))}
            </div>
          )}
          <p className="hint" style={{ marginTop: 8 }}>
            Место — карточка реестра: точка продаж, склад или мастерская. Перестановка
            закрывает период и открывает новый, поэтому видно, где аппарат стоял раньше.
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
        <MachineCardPanel
          id={entity.id}
          kind={machineCard?.kind ?? null}
          status={machineCard?.status ?? null}
          statusNote={machineCard?.statusNote ?? null}
          statusChangedAt={machineCard?.statusChangedAt ?? null}
          updatedBy={machineCard?.updatedBy ?? null}
          places={places}
        />
      )}

      {isMachine && (
        <MachinePartsPanel machineId={entity.id} parts={machineParts} storage={partsStorage} />
      )}

      {isMachine && (
        <PlanogramEditor
          entity={{ id: entity.id }}
          products={planogramProducts}
          planogram={planogram}
        />
      )}

      {isProduct && (
        <>
          <ProductFiscal attrs={a} />
          <ProductEconomy
            attrs={a}
            recipeCost={recipe ? { total: recipe.total, unresolved: recipe.unresolved } : null}
          />
          <ProductMachines rows={productMachines} />
        </>
      )}

      {isRecipe && recipe && (
        <section id="recipe" data-toc="Рецепт">
          <RecipeEditor entity={{ id: entity.id }} ingredients={ingredients} recipe={recipe} />
        </section>
      )}

      {isIngredient && <IngredientUsage rows={ingredientUsage} />}

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
