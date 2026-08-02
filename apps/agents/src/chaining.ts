/**
 * Цепочки follow-up между агентами (перенос extractNext из mydon-agent-os).
 *
 * Навык может закончить вывод блоком `NEXT:` — что стоит сделать дальше (напр.
 * «после одобрения — оформить договор»). Платформа показывает эти подсказки
 * владельцу и/или заводит следующий шаг. Пока навыки детерминированные, блок
 * пуст; примитив готов к LLM-навыкам, которые будут его писать.
 */

/**
 * Достаёт follow-up из текста. Формат:
 *   NEXT: пункт1; пункт2            — инлайн через `;`
 *   NEXT:                          — маркерами на следующих строках
 *   - пункт1
 *   - пункт2
 * Непустая немаркированная строка после NEXT завершает блок. Максимум 10.
 */
export function extractNext(text: string): string[] {
  const out: string[] = [];
  let inBlock = false;
  for (const ln of String(text ?? "").split(/\r?\n/)) {
    const m = /^\s*NEXT:\s*(.*)$/i.exec(ln);
    if (m) {
      inBlock = true;
      if (m[1].trim()) out.push(...m[1].split(";").map((s) => s.trim()).filter(Boolean));
      continue;
    }
    if (inBlock) {
      const b = /^\s*[-•*]\s*(.+)$/.exec(ln);
      if (b) out.push(b[1].trim());
      else if (ln.trim() === "") continue;
      else break; // немаркированная непустая строка — конец блока
    }
  }
  return out.slice(0, 10);
}
