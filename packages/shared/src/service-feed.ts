/**
 * Лента полевых событий обслуживания: кофе, снек и инкассация — один поток.
 *
 * Три источника пишут по-разному (заправка бункера, инкассация, заправка
 * снека), но владельцу нужна ОДНА хронология «что происходило в поле». Эта
 * лента не выбирает победителя и не считает деньги — она только сливает уже
 * готовые события и сортирует их по времени. Тексты строк собирают адаптеры
 * (по одному на источник) — они живут здесь же, потому что формат читаемой
 * строки это тоже чистая функция, а не разметка cc.
 *
 * ВРЕМЯ. `ts` приходит ISO-строкой с зоной; сравнивать строки лексикографически
 * НЕЛЬЗЯ — смешанные зоны (Z и +05:00) врут хронологии. Сортировка всегда через
 * `new Date(ts).getTime()`.
 *
 * НЕИЗВЕСТНОЕ МЕСТО/ИМЯ. `место` не пустое по контракту; null-имя источника
 * (автомат/точка удалены или не указаны) адаптер превращает в «—». `кто» —
 * наоборот, null пропускается как есть: решает потребитель ленты, как
 * показать «неизвестного» исполнителя.
 */

export type ServiceFeedKind = "coffee" | "snack" | "cash";

export interface ServiceFeedItem {
  kind: ServiceFeedKind;
  ts: string;
  место: string;
  текст: string;
  кто: string | null;
}

/** Сливает готовые ленты источников, сортирует по `ts` убыв., режет по лимиту (умолчание 50). */
export function mergeServiceFeed(items: readonly ServiceFeedItem[][], limit = 50): ServiceFeedItem[] {
  return items
    .flat()
    .sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime())
    .slice(0, limit);
}

/** Заправка кофейного бункера → строка ленты. */
export function coffeeRefillToFeed(r: {
  locationName: string;
  position: number;
  ingredientName: string | null;
  filledWeight: number;
  createdAt: string;
  createdBy: string | null;
}): ServiceFeedItem {
  const ингредиент = r.ingredientName ?? "без ингредиента";
  return {
    kind: "coffee",
    ts: r.createdAt,
    место: r.locationName,
    текст: `бункер ${r.position} · ${ингредиент} · залито ${r.filledWeight.toLocaleString("ru-RU")} г`,
    кто: r.createdBy,
  };
}

/** Инкассация → строка ленты. */
export function collectionToFeed(c: {
  machineName: string | null;
  collectedAt: string;
  amount: number | null;
  operatorName: string | null;
}): ServiceFeedItem {
  return {
    kind: "cash",
    ts: c.collectedAt,
    место: c.machineName ?? "—",
    текст:
      c.amount == null ? "инкассация — сумма не введена" : `инкассация ${c.amount.toLocaleString("ru-RU")} сум`,
    кто: c.operatorName,
  };
}

/** Заправка снек-автомата → строка ленты. */
export function vendingRefillToFeed(v: {
  machineName: string | null;
  createdAt: string;
  positions: number;
  units: number;
  createdBy: string | null;
}): ServiceFeedItem {
  return {
    kind: "snack",
    ts: v.createdAt,
    место: v.machineName ?? "—",
    текст: `спирали: ${v.positions.toLocaleString("ru-RU")} поз. · ${v.units.toLocaleString("ru-RU")} шт`,
    кто: v.createdBy,
  };
}
