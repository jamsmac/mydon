// Чистый FEFO-аллокатор: распределить расход `need` по партиям — раньше истекает
// раньше уходит (expiry asc, nulls last), затем раньше получена (receivedAt asc).
// Нехватка партий → хвост {batchId: null} (уходит в минус — реальная усушка).
//
// Перенесено из mydon_1 (~/Developer/mydon_1/src/lib/vendhub/product-stock/fefo.ts),
// АДАПТИРОВАНО под нашу область — снек-донор считал ШТУЧНЫЙ товар, у нас сырьё
// ДРОБНОЕ (кг/л/доли пачки). Правки (R-C3, план 2026-08-21-sloy-C-batches-expiry):
//
//   1) `batchId: number` → `string` — у нас id партии/движения uuid, не serial.
//
//   2) Снят `Math.trunc` в обоих местах (need и remaining партии). У донора
//      `Math.trunc(x)` округлял к целому — для его штучного снека это было
//      осмысленно (нельзя продать пол-батончика). У нас `Math.trunc` молча
//      усушил бы партию матчи с 1,5 кг до 1 кг или обрезал бы 10 600 г
//      MacCoffee до целых грамм по чистой случайности представления числа.
//      Вместо truncation — `Math.max(0, x)` с проверкой `Number.isFinite`:
//      отрицательное или невалидное значение (NaN/Infinity, например от
//      повреждённых данных) трактуется как «взять нечего», а не молча
//      приводится к целому.

export type FefoBatch = { batchId: string; remaining: number; expiryAt: Date | null; receivedAt: Date };
export type FefoLeg = { batchId: string | null; qty: number };

function cmp(a: FefoBatch, b: FefoBatch): number {
  const ea = a.expiryAt ? a.expiryAt.getTime() : Infinity;
  const eb = b.expiryAt ? b.expiryAt.getTime() : Infinity;
  if (ea !== eb) return ea - eb;
  return a.receivedAt.getTime() - b.receivedAt.getTime();
}

// Порог сравнения дробного остатка с нулём. Последовательное вычитание долей
// (кг/л как IEEE754 double) само по себе не копит шум, ПОКА партия полностью
// покрывает остаток (последний шаг всегда берёт ровно `rem`, а `x - x === 0`
// точно в IEEE754). Шум приходит СНАРУЖИ: `need` часто сам — сумма нескольких
// дробных долей (например, потребность по рецептам), которая не обязана
// побитово совпадать с суммой `remaining` партий, даже когда по смыслу партии
// «покрывают потребность день-в-день» (классика: 0.1 + 0.2 !== 0.3). Без
// эпсилон такая разница просочилась бы в отчёт фиктивным хвостом вида
// {batchId: null, qty: 4.44e-17}, ломая и читаемость, и инвариант «Σ qty
// долей = need» на глаз. EPS = 1e-9 на порядки больше типичного шума
// IEEE754-арифметики (~1e-13…1e-16 на разумном числе слагаемых) и на порядки
// меньше минимально значимого шага склада (0.001 — точность qty_received
// numeric(14,3) в stock_batch), так что настоящая нехватка эпсилоном не
// прикроется.
const EPS = 1e-9;

/** Раскладка `need` (>0) по партиям FEFO. Σ qty долей = need (с точностью до EPS). */
export function allocateFEFO(need: number, batches: readonly FefoBatch[]): FefoLeg[] {
  let rem = Number.isFinite(need) ? Math.max(0, need) : 0;
  if (rem <= EPS) return [];

  const legs: FefoLeg[] = [];
  for (const b of [...batches].sort(cmp)) {
    if (rem <= EPS) break;
    const avail = Number.isFinite(b.remaining) ? Math.max(0, b.remaining) : 0;
    if (avail <= EPS) continue;
    const take = Math.min(rem, avail);
    legs.push({ batchId: b.batchId, qty: take });
    rem -= take;
  }
  if (rem > EPS) legs.push({ batchId: null, qty: rem }); // партий не хватило
  return legs;
}
