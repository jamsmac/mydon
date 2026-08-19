import Link from "next/link";
import {
  core,
  CoreUnavailable,
  type Attachment,
  type CoffeeFillStatusRow,
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
  type VendingMachine,
} from "../../../lib/core";
import { MachineCard360 } from "../../../components/machine-card-360";
import { LocationPanel } from "../../../components/location-panel";
import { BunkerTiles } from "../../../components/bunker-tiles";
import {
  MenuEditor,
  type MenuPriceInfo,
  type MenuProductOption,
  type UnlinkedSale,
} from "../../../components/menu-editor";
import { CoreDown } from "../../../components/core-down";
import { PhotoGallery } from "../../../components/photo-gallery";
import { CardToc } from "../../../components/card-toc";
import { DeleteEntityButton } from "../../../components/entity-delete";
import { EntityEditor } from "../../../components/entity-editor";
import { StayTimeline } from "../../../components/machine-stays";
import { EntityApproval } from "../../../components/entity-approval";
import { RecipeEditor, type IngredientOption } from "../../../components/recipe-editor";
import { PlanogramEditor } from "../../../components/planogram-editor";
import { MachineCardPanel } from "../../../components/machine-card-panel";
import { MachinePartsPanel } from "../../../components/machine-parts-panel";
import { StocktakeSession } from "../../../components/stocktake-session";
import {
  PLACE_TYPES,
  normalizeMachineSerial,
  parseMenu,
  parsePlanogram,
  parseRecipe,
} from "@mydon/shared";
import { StockPanel, type WarehouseOption } from "../../../components/stock-panel";
import {
  ComponentInstances,
  ContractorFinance,
  IngredientUsage,
  PlacePlacements,
  ProductEconomy,
  ProductFiscal,
  ProductMachines,
  ProductMenus,
  ProductSalesSection,
  SupplierProducts,
  WarehouseMovements,
  type IngredientUsageRow,
  type PlacementRow,
  type ProductMachineRow,
  type ProductMenuRow,
  type SupplierProductRow,
} from "../../../components/product-card-sections";
import { WarehouseStockView } from "../../../components/warehouse-stock";
import { DOMAIN_TITLES, typeOne } from "../../../lib/labels";
import { when } from "../../../lib/format";

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
  // В меню каких автоматов стоит товар и почём у каждого — детали, которые
  // в самом меню только мешали бы менять цену.
  let productMenus: ProductMenuRow[] = [];
  if (isProduct && entity.domain) {
    try {
      const машины = await core.entitiesOfType(entity.domain, "machine");
      productMachines = машины.flatMap((m) =>
        parsePlanogram(m.attrs)
          .filter((p) => p.productId === entity.id)
          .map((p) => ({ machineId: m.id, machineName: m.name, slot: p.slot })),
      );
      const каталожная = (() => {
        const цена = (v: unknown): number | null => {
          const n = typeof v === "number" ? v : Number(String(v ?? "").replace(",", "."));
          return Number.isFinite(n) && n > 0 ? n : null;
        };
        return цена(a["цена продажи"]) ?? цена(a["цена"]);
      })();
      // Что говорят заказы источника по этому товару — по серийникам автоматов.
      const продано = new Map<string, { price: number; orders: number }>();
      try {
        const срез = await core.rawPrices("gjvending", "order_query");
        const мой = срез.products.find((p) => p.entityId === entity.id);
        for (const m of мой?.machines ?? []) {
          const ключ = normalizeMachineSerial(m.serial);
          const было = продано.get(ключ);
          if (!было || было.orders < m.orders) продано.set(ключ, { price: m.price, orders: m.orders });
        }
      } catch {
        // без среза цен строки просто без «в заказах»
      }
      productMenus = машины
        .map((m) => {
          const строка = parseMenu(m.attrs).find((l) => l.productId === entity.id);
          if (!строка) return null;
          const факт = m.externalRef ? продано.get(normalizeMachineSerial(m.externalRef)) : undefined;
          return {
            machineId: m.id,
            machineName: m.name,
            price: строка.price,
            catalogPrice: каталожная,
            soldPrice: факт?.price ?? null,
            orders: факт?.orders ?? 0,
          };
        })
        .filter((r): r is ProductMenuRow => r !== null)
        .sort((x, y) => x.machineName.localeCompare(y.machineName, "ru"));
    } catch {
      productMachines = [];
      productMenus = [];
    }
  }

  // Товар: продажи по имени карточки (sale.product — текст, FK нет).
  // Дополнение — ошибка не роняет карточку.
  let productSales: Awaited<ReturnType<typeof core.salesByProductCard>> | null = null;
  let unmatchedSales: Awaited<ReturnType<typeof core.salesUnmatched>> = [];
  if (isProduct) {
    try {
      productSales = await core.salesByProductCard(entity.id, 90);
    } catch {
      productSales = null;
    }
    // Кандидаты на привязку имени источника — владелец склеивает сам.
    try {
      unmatchedSales = await core.salesUnmatched(90);
    } catch {
      unmatchedSales = [];
    }
  }

  // Место (точка/склад/мастерская): какие аппараты стоят и стояли.
  // Дополнение — ошибка не роняет карточку.
  const isPlace = (PLACE_TYPES as readonly string[]).includes(entity.type);
  let placements: PlacementRow[] = [];
  if (isPlace) {
    try {
      placements = (await core.coffeePlacements(entity.id)).map((r) => ({
        id: r.id,
        entityId: r.entityId,
        machineName: r.machineName,
        machineRef: r.machineRef,
        startDate: r.startDate,
        endDate: r.endDate,
      }));
    } catch {
      placements = [];
    }
  }

  // Поставщик: товары, где он указан полем «поставщик» (связь по имени).
  // Дополнение — ошибка не роняет карточку.
  const isSupplier = entity.type === "supplier";
  let supplierProducts: SupplierProductRow[] = [];
  if (isSupplier && entity.domain) {
    try {
      const имя = entity.name.trim().toLowerCase();
      const товары = await core.entitiesOfType(entity.domain, "product");
      supplierProducts = товары
        .filter((p) => String((p.attrs ?? {})["поставщик"] ?? "").trim().toLowerCase() === имя)
        .map((p) => {
          const цена = (p.attrs ?? {})["цена покупки"];
          const n = typeof цена === "number" ? цена : Number(String(цена ?? "").replace(",", "."));
          return {
            productId: p.id,
            productName: p.name,
            purchasePrice: Number.isFinite(n) && n > 0 ? n : null,
          };
        });
    } catch {
      supplierProducts = [];
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

  // Запчасть: экземпляры этой номенклатуры в учёте узлов — по серийнику
  // (поле «серийник») и модели (поле «модель» или имя карточки).
  // Дополнение — ошибка не роняет карточку.
  const isComponent = entity.type === "component";
  let componentInstances: Awaited<ReturnType<typeof core.partHistory>> = [];
  if (isComponent) {
    try {
      const серийник = typeof a["серийник"] === "string" ? a["серийник"].trim() : "";
      const модель = typeof a["модель"] === "string" && a["модель"].trim() ? a["модель"].trim() : entity.name;
      componentInstances = await core.partHistory({
        ...(серийник ? { serial: серийник } : {}),
        model: модель,
      });
    } catch {
      componentInstances = [];
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
  let menuProducts: MenuProductOption[] = [];
  if (isMachine) {
    try {
      const cards = entity.domain ? await core.entitiesOfType(entity.domain, "product") : [];
      planogramProducts = cards.map((c) => ({
        id: c.id,
        name: c.name,
        approved: c.approvedAt != null,
      }));
      // Для меню нужны ещё категория (горячий/холодный) и каталожная цена —
      // фолбэк, когда у аппарата нет своей (паттерн slot.price ?? product.price).
      const цена = (v: unknown): number | null => {
        const n = typeof v === "number" ? v : Number(String(v ?? "").replace(",", "."));
        return Number.isFinite(n) && n > 0 ? n : null;
      };
      menuProducts = cards
        .map((c) => {
          const ca = c.attrs ?? {};
          const catRaw = Number(ca["категория"]);
          return {
            id: c.id,
            name: c.name,
            cat: catRaw === 10 || catRaw === 11 ? catRaw : null,
            // «цена продажи» приоритетнее; нечисловая — падаем на «цена».
            price: цена(ca["цена продажи"]) ?? цена(ca["цена"]),
          };
        })
        .sort((a, b) => a.name.localeCompare(b.name, "ru"));
    } catch {
      planogramProducts = [];
      menuProducts = [];
    }
  }
  const planogram = parsePlanogram(entity.attrs);
  const menu = parseMenu(entity.attrs);

  // Другие автоматы направления — источники готового меню («скопировать как шаблон»).
  let menuSources: { id: string; name: string }[] = [];
  if (isMachine && entity.domain) {
    try {
      menuSources = (await core.entitiesOfType(entity.domain, "machine"))
        .filter((m) => m.id !== entity.id && parseMenu(m.attrs).length > 0)
        .map((m) => ({ id: m.id, name: m.name }))
        .sort((a, b) => a.name.localeCompare(b.name, "ru"));
    } catch {
      menuSources = [];
    }
  }

  // История цены по заказам источника — раскрывается в строке меню, а не
  // вываливается сразу. Привязанные к карточке — по productEntityId (при
  // нескольких source-именах на одну карточку берём самое продаваемое),
  // всё, чего нет в меню, уходит в «из истории продаж, не в меню».
  const menuHistory: Record<string, MenuPriceInfo> = {};
  const menuUnlinked: UnlinkedSale[] = [];
  const вМеню = new Set(menu.map((l) => l.productId));
  for (const it of prices) {
    const info: MenuPriceInfo = {
      price: it.price,
      periods: it.periods.map((p) => ({
        price: p.price,
        from: p.from,
        to: p.to ?? null,
        orders: p.orders,
      })),
      orders: it.orders,
      mismatched: it.mismatched > 0,
    };
    if (it.productEntityId) {
      const прежняя = menuHistory[it.productEntityId];
      if (!прежняя || прежняя.orders < info.orders) menuHistory[it.productEntityId] = info;
      if (!вМеню.has(it.productEntityId)) {
        // Одна карточка может продаваться под несколькими source-именами —
        // в списке она ОДНА строка: заказы суммируем, цену берём свежую из
        // самого продаваемого алиаса.
        const есть = menuUnlinked.find((u) => u.productId === it.productEntityId);
        if (есть) {
          if (it.orders > есть.orders) есть.price = it.price;
          есть.orders += it.orders;
        } else {
          menuUnlinked.push({
            product: it.productEntityName ?? it.product,
            price: it.price,
            orders: it.orders,
            productId: it.productEntityId,
          });
        }
      }
    } else {
      menuUnlinked.push({ product: it.product, price: it.price, orders: it.orders, productId: null });
    }
  }
  menuUnlinked.sort((a, b) => b.orders - a.orders);

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

  // Живой срез Ourvend (заполненность/дефицит) по серийнику — если сбор его
  // приносил. Серийники живут в двух форматах (с «c» и без), сверяем канон.
  let liveVending: VendingMachine | null = null;
  if (isMachine && entity.externalRef) {
    try {
      const ключ = normalizeMachineSerial(entity.externalRef);
      liveVending =
        (await core.vendingMachines()).find((m) => normalizeMachineSerial(m.serial) === ключ) ?? null;
    } catch {
      liveVending = null;
    }
  }

  // Кофейные бункеры: уровни точки, где стоит аппарат. Содержимое кофейного —
  // это бункеры, а не слоты; раскладка у него показывается только как легаси,
  // если её кто-то успел заполнить. Дополнение — ошибка не роняет карточку.
  let coffeeBunkers: CoffeeFillStatusRow[] = [];
  if (isMachine) {
    try {
      const [точки, уровни] = await Promise.all([core.coffeeLocations(), core.coffeeFillStatus()]);
      const точка = точки.find((l) => (l.machines ?? []).some((m) => m.entityId === entity.id));
      if (точка) coffeeBunkers = уровни.filter((r) => r.locationId === точка.id);
    } catch {
      coffeeBunkers = [];
    }
  }

  // Карточка автомата — своя вёрстка (образец «Карточка 360»): hero-шапка,
  // KPI и вкладки-виджеты. Остальные типы живут в общей плоской карточке ниже.
  if (isMachine) {
    const mapHref = hasGeo ? `https://maps.google.com/?q=${String(lat)},${String(lng)}` : null;
    return (
      <>
        <div className="page-head">
          <Link
            href={entity.domain ? `/domain/${entity.domain}?tab=vending` : "/registry"}
            className="back"
          >
            ← {entity.domain ? DOMAIN_TITLES[entity.domain] ?? entity.domain : "Реестр"}
          </Link>
        </div>
        <MachineCard360
          entity={entity}
          kind={machineCard?.kind ?? null}
          status={machineCard?.status ?? null}
          statusNote={machineCard?.statusNote ?? null}
          updatedBy={machineCard?.updatedBy ?? null}
          placements={coffeePlacements}
          live={liveVending}
          coffee={
            machineCard?.kind === "coffee"
              ? {
                  linked: coffeeBunkers.length > 0,
                  filled: coffeeBunkers.filter((r) => r.netFillWeight !== null).length,
                }
              : null
          }
          planogramCount={planogram.length}
          partsCount={machineParts.filter((p) => p.removedOn === null).length}
          pricesCount={prices.length}
          photosCount={photos.length}
          hasGeo={hasGeo}
          mapHref={mapHref}
          menuCount={menu.length}
          slots={{
            ingredients: (
              <div className="sect" id="bunkers">
                <div className="sect-h">
                  <h3 className="h2">Ингредиенты по бункерам</h3>
                  {coffeeBunkers.some((r) => r.netFillWeight !== null) && (
                    <span className="chip b">
                      позиций с заливкой:{" "}
                      {coffeeBunkers.filter((r) => r.netFillWeight !== null).length}
                    </span>
                  )}
                </div>
                {coffeeBunkers.length === 0 ? (
                  <div className="empty">
                    <b>Бункеры не привязаны</b>
                    Ингредиенты кофейного живут в восьми бункерах локации. Уровни появятся,
                    когда аппарат будет стоять на кофе-локации с заливками — журнал заливок
                    во вкладке «Кофе-бункеры» рабочего места VendHub.
                  </div>
                ) : (
                  <>
                    <BunkerTiles rows={coffeeBunkers} />
                    <p className="hint" style={{ marginTop: 8 }}>
                      Уровень — чистый вес последней заливки против эталона позиции.
                      Заливки и возвраты — во вкладке «Кофе-бункеры» рабочего места VendHub.
                    </p>
                  </>
                )}
              </div>
            ),
            menu: (
              <>
                <MenuEditor
                  machineId={entity.id}
                  domain={entity.domain ?? null}
                  menu={menu}
                  products={menuProducts}
                  machines={menuSources}
                  history={menuHistory}
                  unlinked={menuUnlinked}
                />
                {/* Расположение по слотам — там же, где ассортимент: что стоит и ГДЕ. */}
                <PlanogramEditor
                  entity={{ id: entity.id }}
                  products={planogramProducts}
                  planogram={planogram}
                />
              </>
            ),
            service: (
              <>
                <MachineCardPanel
                  id={entity.id}
                  kind={machineCard?.kind ?? null}
                  status={machineCard?.status ?? null}
                  statusNote={machineCard?.statusNote ?? null}
                  statusChangedAt={machineCard?.statusChangedAt ?? null}
                  updatedBy={machineCard?.updatedBy ?? null}
                  places={places}
                />
                <MachinePartsPanel machineId={entity.id} parts={machineParts} storage={partsStorage} />
              </>
            ),
            place: (
              <>
                <LocationPanel
                  machineId={entity.id}
                  periods={coffeePlacements.map((p) => ({
                    id: p.id,
                    locationName: p.locationName,
                    startDate: p.startDate,
                    endDate: p.endDate,
                    note: p.note,
                  }))}
                  lat={lat}
                  lng={lng}
                  address={typeof a["адрес"] === "string" ? a["адрес"] : null}
                  sourceStays={stays ? <StayTimeline stays={stays.stays} /> : undefined}
                  {...(stays ? { sourceMoves: stays.moves } : {})}
                />
              </>
            ),
            passport: (
              <>
                <EntityApproval entity={entity} drafts={drafts} />
                <PhotoGallery attachments={photos} />
                <section id="fields">
                  <EntityEditor entity={entity} />
                </section>
                <DeleteEntityButton
                  id={entity.id}
                  domain={entity.domain ?? null}
                  type={entity.type}
                  name={entity.name}
                />
              </>
            ),
          }}
        />
      </>
    );
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

      {isPlace && <PlacePlacements rows={placements} />}

      {isSupplier && <SupplierProducts rows={supplierProducts} />}

      {isComponent && <ComponentInstances rows={componentInstances} />}

      {hasGeo && (
        <div className="card" id="geo" data-toc="Где стоит">
          <div className="result-title">Где стоит</div>
          <p>
            <a
              href={`https://maps.google.com/?q=${String(lat)},${String(lng)}`}
              target="_blank"
              rel="noreferrer"
            >
              Открыть локацию на карте ({String(lat)}, {String(lng)})
            </a>
          </p>
        </div>
      )}

      {isProduct && (
        <>
          <ProductFiscal attrs={a} />
          <ProductEconomy
            attrs={a}
            recipeCost={recipe ? { total: recipe.total, unresolved: recipe.unresolved } : null}
          />
          <ProductMenus rows={productMenus} />
          <ProductMachines rows={productMachines} />
          <ProductSalesSection
            sales={productSales}
            days={90}
            entityId={entity.id}
            unmatched={unmatchedSales}
          />
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

      {isWarehouse && warehouseStock && <WarehouseMovements movements={warehouseStock.movements} />}

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
