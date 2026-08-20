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

/**
 * Сливает готовые ленты источников, сортирует по `ts` убыв.
 *
 * `limit` не имеет значения по умолчанию: без него отдаётся ВСЯ отсортированная
 * лента. Раньше здесь стоял неявный `= 50`, и страница резала историю до
 * вызова фильтра «деньги»/«снек»/«кофе» на service-tab — фильтр по виду видел
 * уже обрезанные 50 строк вместо всех, а «инкассации» в ленте почти не
 * попадали (ревью C2). Резать до 50 для показа — дело потребителя (см.
 * `.slice(0, 50)` в `service-tab.tsx` уже ПОСЛЕ фильтра по виду).
 */
export function mergeServiceFeed(items: readonly ServiceFeedItem[][], limit?: number): ServiceFeedItem[] {
  const merged = items.flat().sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime());
  return limit === undefined ? merged : merged.slice(0, limit);
}

/**
 * Раскрывает служебную ссылку на автора (`createdBy`/`operatorName`) в
 * читаемое имя для ленты (ревью I1).
 *
 * `person:<uuid>` — ищем сотрудника в списке `people`; не нашли — `null`
 * (лучше молчание, чем сырой UUID в интерфейсе). `import:*` — массовая
 * историческая загрузка, а не человек. `bot` — заявка пришла из Telegram без
 * привязки к конкретному оператору (см. `collections.controller.ts`).
 * Остальное (уже разрешённое имя, `owner`, логин) — как есть.
 */
export function resolveActor(raw: string | null, people: readonly { id: string; name: string }[]): string | null {
  if (raw === null) return null;
  const val = raw.trim();
  if (val === "") return null;
  if (val.startsWith("person:")) {
    const id = val.slice("person:".length);
    return people.find((p) => p.id === id)?.name ?? null;
  }
  if (val.startsWith("import:")) return "импорт";
  if (val === "bot") return "бот";
  return val;
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
