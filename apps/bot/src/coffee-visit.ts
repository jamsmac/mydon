import type { StaffReply } from "./staff";

/**
 * Обход точки: точка выбирается ОДИН раз, дальше на ней делают всё подряд.
 *
 * Раньше каждый мастер начинался с выбора точки. На обходе это значило: залил
 * бункер 1 — выбери точку; залил бункер 2 — выбери ту же точку; внёс воду —
 * выбери её же в третий раз. Из девяти точек в списке промахнуться легко, и
 * тогда заливка уезжает на чужую машину. Одна и та же точка, названная трижды,
 * — это не аккуратность, а три возможности ошибиться вместо одной.
 *
 * Поэтому после каждой записи мастер возвращает не «конец», а меню точки:
 * ещё бункер, расходники, завершить. Точка живёт в разговоре до «завершить».
 */

export interface VisitState {
  locationId: string;
  locationName: string;
  /** Сколько бункеров залито за этот обход — для сводки в конце. */
  refills: number;
  /** Внесены ли расходники: повторный заход перезапишет, и об этом стоит сказать. */
  consumables: boolean;
  /**
   * Обход НАЧАЛСЯ: на точке уже есть хотя бы одна запись (заливка или
   * расходники). Ставится только фактом записи в Core — saveRefill и cc:save.
   *
   * Без этого признака обходом считалась любая пара «точка + имя», и «Отмена»
   * в мастере, начатом напрямую из меню, фабриковала обход, которого не было:
   * человек запирался на ошибочно выбранной точке без кнопки выбора другой.
   */
  started: boolean;
}

export type VisitCallback =
  | { kind: "more" }
  | { kind: "consumables" }
  | { kind: "finish" }
  | { kind: "next" };

export function parseVisitCallback(data: string): VisitCallback | null {
  switch (data) {
    case "cv:more":
      return { kind: "more" };
    case "cv:cons":
      return { kind: "consumables" };
    case "cv:done":
      return { kind: "finish" };
    case "cv:next":
      return { kind: "next" };
    default:
      return null;
  }
}

/**
 * Меню точки. «Ещё бункер» первым: на обходе это самое частое действие, восемь
 * позиций на машину против одного ввода расходников.
 */
export function visitKeyboard(state: VisitState): NonNullable<StaffReply["keyboard"]> {
  return {
    inline_keyboard: [
      [{ text: "➕ Ещё бункер", callback_data: "cv:more" }],
      [
        {
          text: state.consumables ? "💧 Расходники (внесены)" : "💧 Расходники",
          callback_data: "cv:cons",
        },
      ],
      [{ text: "🏁 Завершить точку", callback_data: "cv:done" }],
    ],
  };
}

/** Что сделано на точке — читается перед уходом с неё, пока можно вернуться. */
export function visitSummary(state: VisitState): string {
  const parts: string[] = [];
  parts.push(state.refills === 0 ? "бункеры не заливал" : `залито бункеров: ${state.refills}`);
  parts.push(state.consumables ? "расходники внесены" : "расходники не вносил");
  return `🏁 «${state.locationName}» — ${parts.join(", ")}.`;
}

/** Клавиатура после ухода с точки: сразу взять следующую, не набирая слово заново. */
export function nextLocationKeyboard(): NonNullable<StaffReply["keyboard"]> {
  return {
    inline_keyboard: [[{ text: "➡️ Следующая точка", callback_data: "cv:next" }]],
  };
}

/**
 * Состояние обхода из ЛЮБОГО кофейного мастера, а не только из меню точки.
 *
 * Заливка и расходники носят точку внутри своих данных (`continueVisitRefill`,
 * `continueVisitConsumable` кладут её туда), поэтому бросив подшаг, вернуться
 * на точку можно — надо лишь знать, куда возвращаться. Без этого «Отмена» на
 * экране выбора бункера уносила весь обход: четыре записанные заливки, счётчик
 * и предложение внести расходники исчезали, потому что слот беседы один.
 */
export function visitFromFlow(conv: { flow: string; data: Record<string, unknown> } | null): VisitState | null {
  if (!conv) return null;
  if (conv.flow !== "coffee-visit" && conv.flow !== "coffee-refill" && conv.flow !== "coffee-consumable") {
    return null;
  }
  const visit = visitOf(conv.data);
  // Возвращать есть куда только если обход НАЧАЛСЯ — на точке что-то записано.
  // Мастер, открытый напрямую из меню, тоже носит точку в данных, но «Отмена»
  // в нём должна вести к выбору точки, а не в меню обхода, которого не было.
  return visit !== null && visit.started ? visit : null;
}

/**
 * Разбор нажатия покажет, наша ли это кнопка, но НЕ скажет, живой ли обход:
 * это два разных вопроса, и барьер в диспетчере должен задавать оба.
 */

/** Достать состояние обхода из данных разговора. Неполное — обход не считается начатым. */
export function visitOf(data: Record<string, unknown>): VisitState | null {
  const locationId = typeof data.locationId === "string" ? data.locationId : "";
  const locationName = typeof data.locationName === "string" ? data.locationName : "";
  if (!locationId || !locationName) return null;
  return {
    locationId,
    locationName,
    refills: typeof data.refills === "number" ? data.refills : 0,
    consumables: data.consumables === true,
    started: data.started === true,
  };
}
