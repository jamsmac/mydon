import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import { entity, coffeeBunkerConfig, coffeeContainerReturn, coffeeContainerTare, coffeeIngredient, coffeeOrder, coffeeRefill, machinePlacement, productNameAlias } from "@mydon/db";
import { sql } from "drizzle-orm";
import { bunkerPeriod, netWeight, normFor, normalizeSourceKey, orderIsDelivered, parseNormRecipe, type BunkerPeriod, type Coverage, type NormRecipeLine } from "@mydon/shared";
import { DB, type Db } from "../db/db.module";

/**
 * Норма против факта по периодам бункера (срез F, задача 3).
 *
 * ЧТО ЭТО. `bunkerPeriod()`/`parseNormRecipe()`/`normFor()` (`@mydon/shared`)
 * уже решили, ЧТО считать нормой одной чашки и КОГДА периоду можно доверять
 * (см. их шапки — там же цифры разведки: 885 пар, 447 полных, причины
 * неполноты). Эта служба — единственное, чего ещё не было: сборка входа для
 * них из живой БД (пары заливка→возврат, автомат по machine_placement,
 * товар по product_name_alias, разбор состава карточки).
 *
 * ГЛАВНЫЙ РУЛИНГ (R-F2), уже реализованный в `bunkerPeriod()`, а не здесь:
 * разница считается ТОЛЬКО на периодах с полнотой «полный». Эта служба лишь
 * честно передаёт входные данные (включая `null`, где данных нет) —
 * подделывать полноту подсовыванием заглушек нельзя, иначе весь смысл среза
 * теряется уже на границе с БД.
 */

/** Период бункера с именами для витрины — `BunkerPeriod` из `@mydon/shared` не хранит их (чистое ядро, без БД). */
export interface NormFactPeriod extends BunkerPeriod {
  locationName: string | null;
  ingredientName: string | null;
}

/** Итог — ТОЛЬКО по периодам с полнотой «полный» (правило живёт в ядре, см. `bunkerPeriod()`). */
export interface NormFactTotal {
  факт: number;
  норма: number;
  разница: number;
  периодов: number;
}

/** Один неполный период — сгруппированы по причине, чтобы витрина не листала сотни строк. */
export interface NormFactExcludedGroup {
  причина: Exclude<Coverage, "полный">;
  периодов: number;
}

export interface NormFactReport {
  from: string;
  to: string;
  periods: NormFactPeriod[];
  итог: NormFactTotal;
  внеИтога: { периодов: number; причины: NormFactExcludedGroup[] };
  /**
   * Сырьё тратится на ВЫДАННЫЙ напиток (`orderIsDelivered`, R-F5), а в базе
   * материализован `countable` («годится в выручку») — другое правило.
   * Расхождение обязано быть видно числом, а не тонуть молча в разнице
   * подсчётов (факт 12 плана).
   */
  расхождениеDeliveredCountable: number;
}

/** Пара «заливка → возврат» с координатами и сырым ингредиентом заливки — вход для `bunkerPeriod()`. */
interface СыраяПара {
  position: number;
  containerNumber: number;
  locationId: string;
  fillDate: string;
  returnDate: string;
  /** Нетто (вес минус тара), г. null — тара набора не откалибрована. */
  fillNet: number | null;
  returnNet: number | null;
  /** `coffee_refill.ingredient_id` этой конкретной заливки — не всей позиции. */
  ingredientIdRaw: string | null;
}

/** Одна проданная (выданная) чашка, привязанная к точке через `machine_placement`. */
interface ЧашкаТочки {
  date: string;
  /** Карточка товара (entity id) — `null`, если имя не опознано (нет карточки/алиаса). */
  productId: string | null;
}

@Injectable()
export class NormFactService {
  constructor(@Inject(DB) private readonly db: Db) {}

  private static readonly ДАТА_RE = /^\d{4}-\d{2}-\d{2}$/;

  /**
   * `entity.attrs['состав']` на проде хранится JSON-СТРОКОЙ (двойное
   * кодирование формы ввода), а не вложенным массивом — проверено вживую
   * (`jsonb_typeof(attrs->'состав')` = `string` у всех 19 карточек-рецептов).
   * `parseNormRecipe()` этого специально не прощает (её контракт — уже
   * разобранный массив, см. `norm.ts`): нестрогий разбор входа — забота
   * вызывающего кода, а не чистого ядра. Это и есть та единственная граница.
   */
  private toRecipeArray(raw: unknown): unknown {
    if (typeof raw !== "string") return raw;
    try {
      return JSON.parse(raw);
    } catch {
      return raw; // пусть parseNormRecipe() сам сформулирует ошибку разбора
    }
  }

  /**
   * Сопоставить возвраты наборов с заливками — та же математика, что у
   * `matchReturnsToRefills()` (`@mydon/shared/coffee-calc`, использована в
   * `containerConsumption()`/`reconcileAllLocations()`): возврат закрывает
   * ближайшую предыдущую ещё не закрытую заливку того же (набор, позиция).
   *
   * НЕ переиспользует ту функцию напрямую: этому срезу дополнительно нужен
   * `ingredientId` КОНКРЕТНОЙ заливки (для «позиция неоднозначна» на позиции
   * с двумя ингредиентами — факт 9 плана), а `ContainerFillEvent`/строка
   * результата `matchReturnsToRefills()` его не несёт. Дублировать ~20 строк
   * сопоставления дешевле, чем расширять чужой публичный контракт ради одного
   * вызывающего — и незаметнее для трёх существующих мест, которые его уже
   * используют.
   */
  private matchRefillsToReturns(
    refills: readonly { position: number; containerNumber: number | null; enteredDate: string; filledWeight: number; locationId: string; ingredientId: string | null }[],
    returns: readonly { position: number; containerNumber: number; weight: number; returnedDate: string }[],
    tareByKey: ReadonlyMap<string, number>,
  ): СыраяПара[] {
    const key = (containerNumber: number, position: number) => `${containerNumber}:${position}`;

    const fillsByKey = new Map<
      string,
      { date: string; locationId: string; ingredientId: string | null; net: number | null }[]
    >();
    for (const f of refills) {
      if (f.containerNumber === null) continue; // без номера набора сопоставить не с чем
      const k = key(f.containerNumber, f.position);
      const list = fillsByKey.get(k) ?? [];
      list.push({
        date: String(f.enteredDate),
        locationId: f.locationId,
        ingredientId: f.ingredientId,
        net: netWeight(f.filledWeight, tareByKey.get(k) ?? null),
      });
      fillsByKey.set(k, list);
    }
    for (const list of fillsByKey.values()) list.sort((a, b) => a.date.localeCompare(b.date));

    const sortedReturns = [...returns]
      .map((r) => ({
        position: r.position,
        containerNumber: r.containerNumber,
        date: String(r.returnedDate),
        net: netWeight(r.weight, tareByKey.get(key(r.containerNumber, r.position)) ?? null),
      }))
      .sort((a, b) => a.date.localeCompare(b.date));

    const consumedFillIdx = new Map<string, number>();
    const pairs: СыраяПара[] = [];
    for (const r of sortedReturns) {
      const k = key(r.containerNumber, r.position);
      const list = fillsByKey.get(k) ?? [];
      const from = consumedFillIdx.get(k) ?? 0;
      let picked = -1;
      for (let i = from; i < list.length; i++) {
        if (list[i]!.date <= r.date) picked = i;
        else break;
      }
      if (picked < 0) continue; // возврат без заливки в истории — период не построить
      consumedFillIdx.set(k, picked + 1);
      const fill = list[picked]!;
      pairs.push({
        position: r.position,
        containerNumber: r.containerNumber,
        locationId: fill.locationId,
        fillDate: fill.date,
        returnDate: r.date,
        fillNet: fill.net,
        returnNet: r.net,
        ingredientIdRaw: fill.ingredientId,
      });
    }
    return pairs;
  }

  /**
   * Ингредиент позиции: если у позиции ровно один допустимый ингредиент
   * (`coffee_bunker_config`), он и берётся — независимо от того, что записано
   * в конкретной заливке (обычно там пусто). Если кандидатов 0 или 2+
   * (позиция 3 — Лимонный чай + Матча, факт 9), решает `ingredientId`
   * КОНКРЕТНОЙ заливки; если и его нет — позиция неоднозначна, честно.
   */
  private resolveIngredient(
    position: number,
    ingredientIdRaw: string | null,
    candidatesByPosition: ReadonlyMap<number, string[]>,
  ): { ingredientId: string | null; однозначна: boolean } {
    const candidates = candidatesByPosition.get(position) ?? [];
    if (candidates.length === 1) return { ingredientId: candidates[0]!, однозначна: true };
    if (ingredientIdRaw) return { ingredientId: ingredientIdRaw, однозначна: true };
    return { ingredientId: null, однозначна: false };
  }

  /**
   * Норма и число выданных чашек точки за интервал периода. `норма` — `null`,
   * если за интервал не выдано ни одной чашки (не с чем сверять — «нормы
   * нет», а не «норма ноль»: см. `bunkerPeriod()` R-F2 и норма.test.ts,
   * фикстура «нет нормы за интервал» тоже парная с `чашек: 0`).
   */
  private normaFor(
    cupsByLocation: ReadonlyMap<string, ЧашкаТочки[]>,
    recipeLinesByProduct: ReadonlyMap<string, NormRecipeLine[] | null>,
    locationId: string,
    entityIngredientId: string,
    from: string,
    to: string,
  ): { чашек: number; норма: number | null } {
    const rows = cupsByLocation.get(locationId) ?? [];
    let чашек = 0;
    let норма = 0;
    for (const r of rows) {
      if (r.date < from || r.date > to) continue;
      чашек++;
      if (!r.productId) continue; // имя не опознано — этот товар просто не даёт вклада
      const lines = recipeLinesByProduct.get(r.productId);
      if (!lines) continue; // рецепт не задан/не разобран — тот же принцип
      const line = normFor(lines, 1).get(entityIngredientId);
      if (line) норма += line.qty;
    }
    return { чашек, норма: чашек === 0 ? null : норма };
  }

  /**
   * `GET /coffee/norm-fact?from=&to=`: норма против факта по периодам
   * бункера, пересекающим `[from, to]`. Тот же приём, что и в
   * `collections.service.ts::reconcile()` (срез К): правило «что считать
   * сходимостью» — здесь, в ядре (через `bunkerPeriod()`), а не на экране.
   *
   * Один проход по всей истории заливок/возвратов/заказов, а не построчные
   * запросы на период: те же четыре full-scan'а, что и в
   * `CollectionsService.reconcile()`, — приемлемо на нынешнем объёме данных
   * (тысячи, не миллионы строк), см. её же комментарий про кэш.
   */
  async report(from: string, to: string): Promise<NormFactReport> {
    if (!NormFactService.ДАТА_RE.test(from) || !NormFactService.ДАТА_RE.test(to)) {
      throw new BadRequestException("Период задаётся датами вида ГГГГ-ММ-ДД: ?from=2025-12-10&to=2026-08-17");
    }
    if (from > to) {
      throw new BadRequestException(`Начало периода (${from}) позже конца (${to})`);
    }

    const [refillRows, returnRows, tareRows, bunkerConfigRows, ingredientRows, placementRows, orderRows, entityRows, aliasRows] =
      await Promise.all([
        this.db
          .select({
            position: coffeeRefill.position,
            containerNumber: coffeeRefill.containerNumber,
            enteredDate: coffeeRefill.enteredDate,
            filledWeight: coffeeRefill.filledWeight,
            locationId: coffeeRefill.locationId,
            ingredientId: coffeeRefill.ingredientId,
          })
          .from(coffeeRefill),
        this.db
          .select({
            position: coffeeContainerReturn.position,
            containerNumber: coffeeContainerReturn.containerNumber,
            weight: coffeeContainerReturn.weight,
            returnedDate: coffeeContainerReturn.returnedDate,
          })
          .from(coffeeContainerReturn),
        this.db
          .select({ containerNumber: coffeeContainerTare.containerNumber, position: coffeeContainerTare.position, tareWeight: coffeeContainerTare.tareWeight })
          .from(coffeeContainerTare),
        this.db.select({ position: coffeeBunkerConfig.position, ingredientId: coffeeBunkerConfig.ingredientId }).from(coffeeBunkerConfig),
        this.db.select({ id: coffeeIngredient.id, name: coffeeIngredient.name, entityId: coffeeIngredient.entityId }).from(coffeeIngredient),
        this.db
          .select({ entityId: machinePlacement.entityId, locationId: machinePlacement.locationId, startDate: machinePlacement.startDate, endDate: machinePlacement.endDate })
          .from(machinePlacement),
        // Выдача считается по Ташкенту (та же зона, что и у ручного ввода
        // заливок/возвратов — `entered_date`/`returned_date` без времени),
        // иначе чашка вечера по UTC уезжала бы в соседние сутки.
        this.db
          .select({
            machineId: coffeeOrder.machineId,
            date: sql<string>`to_char(${coffeeOrder.ts} at time zone 'Asia/Tashkent', 'YYYY-MM-DD')`,
            goodsName: coffeeOrder.goodsName,
            brewStatus: coffeeOrder.brewStatus,
            countable: coffeeOrder.countable,
          })
          .from(coffeeOrder),
        this.db.select({ id: entity.id, type: entity.type, name: entity.name, attrs: entity.attrs }).from(entity),
        this.db.select({ name: productNameAlias.name, entityId: productNameAlias.entityId }).from(productNameAlias),
      ]);

    // ── Справочники ──────────────────────────────────────────────────────
    const tareByKey = new Map<string, number>();
    for (const t of tareRows) if (t.tareWeight !== null) tareByKey.set(`${t.containerNumber}:${t.position}`, t.tareWeight);

    const candidatesByPosition = new Map<number, string[]>();
    for (const c of bunkerConfigRows) candidatesByPosition.set(c.position, [...(candidatesByPosition.get(c.position) ?? []), c.ingredientId]);

    const ingredientNameById = new Map(ingredientRows.map((i) => [i.id, i.name]));
    // Мост «строка бункерного реестра → карточка ингредиента»: норма считается
    // по составу карточки товара, а он ссылается на entity.id, не на
    // coffee_ingredient.id (см. schema.ts, coffeeIngredient.entityId).
    const ingredientEntityId = new Map(ingredientRows.filter((i) => i.entityId !== null).map((i) => [i.id, i.entityId as string]));

    const locationNameById = new Map(entityRows.map((e) => [e.id, e.name]));

    // Карточка товара по имени источника: сперва алиас (R-F6, снековый
    // механизм — `product_name_alias` + `sales.service.ts:459`), иначе прямое
    // совпадение имени карточки (алиасов для кофе пока не заведено ни одного,
    // но прямое имя уже покрывает подавляющее большинство чашек).
    const productByAliasKey = new Map(aliasRows.map((a) => [normalizeSourceKey(a.name), a.entityId]));
    const productByNameKey = new Map(
      entityRows.filter((e) => e.type === "product").map((e) => [normalizeSourceKey(e.name), e.id]),
    );
    const resolveProductId = (goodsName: string): string | null => {
      const key = normalizeSourceKey(goodsName);
      return productByAliasKey.get(key) ?? productByNameKey.get(key) ?? null;
    };

    const recipeLinesByProduct = new Map<string, NormRecipeLine[] | null>();
    for (const e of entityRows) {
      if (e.type !== "product") continue;
      const raw = (e.attrs as Record<string, unknown> | null)?.["состав"];
      const parsed = parseNormRecipe(this.toRecipeArray(raw));
      recipeLinesByProduct.set(e.id, "error" in parsed ? null : parsed);
    }

    // ── Заказы → выданные чашки по точке (мост «автомат → точка», факт 3) ──
    const placementsByMachine = new Map<string, { locationId: string; startDate: string | null; endDate: string | null }[]>();
    for (const p of placementRows) {
      const list = placementsByMachine.get(p.entityId) ?? [];
      list.push({ locationId: p.locationId, startDate: p.startDate ? String(p.startDate) : null, endDate: p.endDate ? String(p.endDate) : null });
      placementsByMachine.set(p.entityId, list);
    }
    const placementCovers = (p: { startDate: string | null; endDate: string | null }, date: string): boolean =>
      (p.startDate === null || p.startDate <= date) && (p.endDate === null || p.endDate >= date);

    const cupsByLocation = new Map<string, ЧашкаТочки[]>();
    let расхождениеDeliveredCountable = 0;
    for (const o of orderRows) {
      const delivered = orderIsDelivered({ brewStatus: o.brewStatus });
      // R-F5 (факт 12): расход сырья обязан идти по `orderIsDelivered`, а не
      // по материализованному `countable` — расхождение видно числом, в
      // окне того же запроса, что и остальной отчёт.
      if (o.date >= from && o.date <= to && delivered !== o.countable) расхождениеDeliveredCountable++;
      if (!delivered || !o.machineId) continue;
      const placement = (placementsByMachine.get(o.machineId) ?? []).find((p) => placementCovers(p, o.date));
      if (!placement) continue; // автомат без размещения на эту дату — чашка не привязана ни к одной точке (факт 3)
      const list = cupsByLocation.get(placement.locationId) ?? [];
      list.push({ date: o.date, productId: resolveProductId(o.goodsName) });
      cupsByLocation.set(placement.locationId, list);
    }

    // ── Пары заливка → возврат → периоды бункера ────────────────────────
    const pairs = this.matchRefillsToReturns(refillRows, returnRows, tareByKey);

    const periods: NormFactPeriod[] = pairs.map((p) => {
      const { ingredientId, однозначна } = this.resolveIngredient(p.position, p.ingredientIdRaw, candidatesByPosition);
      const размещена = p.fillNet !== null && p.returnNet !== null;
      const entityIngredientId = ingredientId ? ingredientEntityId.get(ingredientId) ?? null : null;

      let чашек = 0;
      let норма: number | null = null;
      if (размещена && однозначна && entityIngredientId) {
        const результат = this.normaFor(cupsByLocation, recipeLinesByProduct, p.locationId, entityIngredientId, p.fillDate, p.returnDate);
        чашек = результат.чашек;
        норма = результат.норма;
      }

      const period = bunkerPeriod({
        machineId: p.locationId, // у бункера нет собственного «автомата» — это идентификатор точки (см. schema.ts: coffee_refill.location_id)
        position: p.position,
        ingredientId,
        from: p.fillDate,
        to: p.returnDate,
        размещена,
        однозначна,
        залито: p.fillNet,
        возвращено: p.returnNet,
        норма,
        чашек,
      });
      return {
        ...period,
        locationName: locationNameById.get(p.locationId) ?? null,
        ingredientName: ingredientId ? ingredientNameById.get(ingredientId) ?? null : null,
      };
    });

    // Только периоды, пересекающие запрошенное окно — те, что целиком вне
    // его, не относятся к текущему запросу (та же логика, что и у любого
    // отчёта по датам в этом репо).
    const inWindow = periods.filter((p) => p.to >= from && p.from <= to);

    const полные = inWindow.filter((p) => p.полнота === "полный");
    const внеИтогаRows = inWindow.filter((p) => p.полнота !== "полный");
    const причины = new Map<Coverage, number>();
    for (const p of внеИтогаRows) причины.set(p.полнота, (причины.get(p.полнота) ?? 0) + 1);

    const итог: NormFactTotal = {
      факт: полные.reduce((s, p) => s + p.факт, 0),
      норма: полные.reduce((s, p) => s + (p.норма ?? 0), 0),
      разница: полные.reduce((s, p) => s + (p.разница ?? 0), 0),
      периодов: полные.length,
    };

    return {
      from,
      to,
      periods: inWindow,
      итог,
      внеИтога: {
        периодов: внеИтогаRows.length,
        причины: [...причины.entries()].map(([причина, периодов]) => ({ причина: причина as Exclude<Coverage, "полный">, периодов })),
      },
      расхождениеDeliveredCountable,
    };
  }
}
