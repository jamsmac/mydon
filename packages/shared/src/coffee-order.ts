/**
 * Что считать продажей кофе — одно правило на всю систему.
 *
 * ЗАЧЕМ ОТДЕЛЬНЫМ МОДУЛЕМ. Выручка на дашборде и расход сырья в сверке обязаны
 * опираться на одно и то же множество заказов. Стоит правилу разойтись на два
 * места — и отчёты начнут спорить друг с другом цифрами, а разобраться, какая
 * из них верна, будет уже нечем.
 *
 * ДВА СЛОВАРЯ. Панель gjvending отдаёт одни и те же поля по-разному:
 *   • прямой сбор из API — коды: `cash`, `userDefined`, `testShipment`, `vip`,
 *     `credit`, `cash0`, `send`; оплата `paid`/`returned`; выдача числом
 *     (`2` — доставлен, `10` — доставка подтверждена, по словарю sources.ts);
 *   • выгрузка из интерфейса — подписи: `Cash payment`, `Custom payment`,
 *     `测试出货`, `vip`; оплата `Paid`/`Refunded`; выдача `Delivered`/
 *     `Delivery confirmed`/`Delivery failure`/`Not delivered`.
 * Обе формы живые: 56 256 строк собраны первым способом, 23 285 — вторым.
 * Поэтому нормализуем оба, а не выбираем «правильный».
 */

/** Заказ в том виде, в каком он пришёл из источника (любой из двух форм). */
export interface CoffeeOrderSource {
  paymentStatus?: string | null;
  orderResource?: string | null;
  brewStatus?: string | null;
  amount?: number | string | null;
}

const norm = (v: string | null | undefined): string => (v ?? "").trim().toLowerCase();

/**
 * Каналы, которые не бывают продажей независимо от цены: тестовая выдача при
 * настройке автомата и ручная выдача оператором.
 *
 * `vip` здесь НЕ значится, и это решение данных, а не вкуса: из 2704
 * оплаченных vip-заказов у 2693 сумма оплаты равна цене — это платёжный канал
 * (карта), а не комплимент. Ярлык канала признаком бесплатности не является;
 * бесплатной выдачу делает НУЛЕВАЯ ЦЕНА — у настоящих бесплатных каналов
 * (testShipment 3960/3960, send 2/2) цена ноль во всех строках без исключения.
 */
const NEVER_SALE_RESOURCES = new Set(["testshipment", "测试出货", "send"]);

/** Оплата прошла и не возвращена. */
export function orderIsPaid(o: CoffeeOrderSource): boolean {
  return norm(o.paymentStatus) === "paid";
}

/** Выдача действительно состоялась — по ней и списывается сырьё. */
export function orderIsDelivered(o: CoffeeOrderSource): boolean {
  const s = norm(o.brewStatus);
  // Коды из прямого сбора: 2 — доставлен, 10 — доставка подтверждена
  // (словарь fulfilment в sources.ts). Подписи — из выгрузки интерфейса.
  return s === "2" || s === "10" || s === "delivered" || s === "delivery confirmed";
}

/**
 * Строка идёт в выручку: оплачена, цена не нулевая и канал не служебный.
 *
 * Нулевая цена отсекает и vip-комплименты (11 строк из 2704), и `cash0`
 * (142 бесплатные чашки со статусом paid) — ровно те выдачи, которые сам
 * источник кодирует нулём, каким бы каналом они ни шли.
 *
 * Отказ выдачи продажу НЕ отменяет — деньги взяты, и это отдельная беда,
 * которую видно по `orderIsDelivered`. Смешать их значило бы молча списать
 * недоданные чашки из выручки и потерять сам факт отказа.
 */
export function orderIsCountable(o: CoffeeOrderSource): boolean {
  const сумма = Number(o.amount ?? 0);
  return orderIsPaid(o) && Number.isFinite(сумма) && сумма > 0 && !NEVER_SALE_RESOURCES.has(norm(o.orderResource));
}

/**
 * Канал оплаты — физические наличные, а не безнал/карта (ревью I3: единое
 * правило вместо литерального `Set` в `collections.service.ts`).
 *
 * `cash`, `cash0` (бесплатная выдача тем же каналом) и `credit` (продажа в
 * долг — деньги ФИЗИЧЕСКИ не берутся, но по учётной логике «Деньги в
 * автоматах» это тоже не снятые наличные) — наличные. `vip` — платёжная
 * карта (см. `coffee-order.ts` выше: 2693 из 2704 оплачены на полную цену),
 * `userDefined`/«Custom payment» — безналичный канал устройства. Ни тот, ни
 * другой наличными не являются — их сумма не лежит физически в автомате и не
 * ждёт инкассации.
 */
const CASH_RESOURCES = new Set(["cash", "cash0", "cash payment", "credit"]);

export function orderIsCash(o: CoffeeOrderSource): boolean {
  return CASH_RESOURCES.has(norm(o.orderResource));
}
