/**
 * Крышка бункера: состояние взвешивания и приведение к одному основанию
 * (решение владельца 12.09.2026 вместо допущения R-B-19).
 *
 * ЧТО БЫЛО. R-B-19 требовал взвешивать ВСЕГДА с крышкой и сам называл своё
 * основание допущением: «крышка всегда при бункере; если её снимают и
 * оставляют на аппарате — ответ переворачивается». Важно в нём не «с крышкой»,
 * а то, что «до» и «после» обязаны быть в ОДНОМ состоянии: разнобой даёт
 * ошибку ровно в вес крышки КАЖДЫЙ цикл — при 27 наборах это систематический
 * сдвиг, а не случайный.
 *
 * ЧТО СТАЛО. Состояние перестаёт быть требованием к человеку и становится
 * СВОЙСТВОМ ЗАМЕРА: техник взвешивает так, как удобно в этот момент, и
 * отмечает, было ли на бункере крышка. Зная вес крышки этого бункера, система
 * приводит любые два замера к одному основанию сама.
 *
 * ЧЕГО НЕ ДЕЛАЕМ. Вес крышки неизвестен — не угадываем и не подставляем
 * «обычный» (R-B-9): два замера в разных состояниях просто НЕ сравниваются, и
 * это сказано словами. Один раз взвесить крышку дешевле, чем годами носить
 * систематический сдвиг.
 */

/** Было ли на бункере крышка в момент взвешивания. */
export const WEIGH_BASES = ["with_lid", "without_lid"] as const;
export type WeighBasis = (typeof WEIGH_BASES)[number];

export const WEIGH_BASIS_LABELS: Record<WeighBasis, string> = {
  with_lid: "с крышкой",
  without_lid: "без крышки",
};

/** Основание хранения: приводим всё к весу С КРЫШКОЙ — как и решал R-B-19. */
export const CANONICAL_BASIS: WeighBasis = "with_lid";

export function isWeighBasis(v: unknown): v is WeighBasis {
  return v === "with_lid" || v === "without_lid";
}

/**
 * Привести замер к другому основанию. `null` — привести нельзя: вес крышки у
 * этого бункера неизвестен. Возвращать «как есть» в этом случае нельзя: это и
 * был бы тот самый молчаливый сдвиг в вес крышки.
 */
export function toBasis(
  weight: number,
  from: WeighBasis,
  to: WeighBasis,
  lidWeight: number | null | undefined,
): number | null {
  if (from === to) return weight;
  if (lidWeight == null || !Number.isFinite(lidWeight) || lidWeight <= 0) return null;
  return from === "with_lid" ? weight - lidWeight : weight + lidWeight;
}

/** Замер к каноническому основанию (с крышкой). */
export function toCanonical(weight: number, basis: WeighBasis, lidWeight: number | null | undefined): number | null {
  return toBasis(weight, basis, CANONICAL_BASIS, lidWeight);
}

/**
 * Разница двух замеров («сколько добавили», «сколько вернулось») — только
 * когда оба приводятся к одному основанию. Иначе `null` и причина словами:
 * тихо вычесть разные состояния значит соврать ровно на вес крышки.
 */
export function weighDelta(
  after: { weight: number; basis: WeighBasis },
  before: { weight: number; basis: WeighBasis },
  lidWeight: number | null | undefined,
): { delta: number } | { problem: string } {
  const a = toCanonical(after.weight, after.basis, lidWeight);
  const b = toCanonical(before.weight, before.basis, lidWeight);
  if (a === null || b === null) {
    return {
      problem:
        "замеры в разных состояниях (с крышкой и без), а вес крышки этого бункера неизвестен — взвесьте крышку один раз",
    };
  }
  return { delta: a - b };
}

/**
 * Вес крышки из пары замеров одного бункера подряд: с крышкой минус без
 * крышки. Так его узнают, не снимая бункер с весов дважды в разные дни.
 * Неположительная или неправдоподобно большая разница — отказ: скорее всего
 * перепутаны поля, а не крышка весит 900 г.
 */
export const LID_WEIGHT_MAX = 800;

export function lidWeightFromPair(withLid: number, withoutLid: number): { lidWeight: number } | { problem: string } {
  const d = withLid - withoutLid;
  if (d <= 0) return { problem: "С крышкой должно быть тяжелее, чем без неё — проверьте, не перепутаны ли поля" };
  if (d > LID_WEIGHT_MAX) return { problem: `Разница ${d} г не похожа на вес крышки — проверьте замеры` };
  return { lidWeight: d };
}
