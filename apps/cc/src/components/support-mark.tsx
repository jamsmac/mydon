import { supportLabel, supportOf, SUPPORT_WORD } from "@mydon/shared";

/**
 * Опора под цифрой (Н-3, Н-4): на скольких фактах она стоит.
 *
 * ПОЧЕМУ РЯДОМ С ЧИСЛОМ, А НЕ В ПРИМЕЧАНИИ. Главный риск метода накопления —
 * посчитать на половине данных и выдать уверенно неверное число (так появился
 * «минус 18 г сахара»). Примечание внизу страницы читают после того, как уже
 * поверили цифре; пометка на самой цифре — до.
 *
 * ПОРОГ ДОВЕРИЯ — НЕ ПОРОГ СОКРЫТИЯ (Н-4). Слабая цифра показывается так же,
 * как сильная; меняется одно слово. Спрятать её значит заставить искать другим
 * путём — и найдут, но уже без пометки.
 */
export function SupportMark({ facts, of, unit }: { facts: number; of?: number | null; unit: string }) {
  const s = supportOf(facts, of ?? null);
  return (
    <span className={`support support-${s.strength}`} title={supportLabel(s, unit)}>
      {SUPPORT_WORD[s.strength]}
      {s.strength !== "none" && (
        <>
          {" · "}
          {s.facts}
          {s.of === null ? "" : ` из ${s.of}`}
        </>
      )}
    </span>
  );
}
