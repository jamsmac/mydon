/**
 * Мини-график-столбики для дашборда — динамика без библиотек и клиентского JS.
 * Высота столбика нормируется к максимуму ряда; подпись значения — в title
 * (наведение). Пустой ряд не рисует пустую рамку — секция сама решает,
 * показывать ли график.
 */
export interface MiniBar {
  /** Подпись периода («08-01», «нед 31»). */
  label: string;
  value: number;
  /** Текст всплывашки; по умолчанию «label: value». */
  title?: string;
}

export function MiniBars({ bars, hot = false }: { bars: MiniBar[]; hot?: boolean }) {
  if (bars.length === 0) return null;
  const max = Math.max(...bars.map((b) => b.value), 1);
  return (
    <div className="mini-bars">
      {bars.map((b, i) => (
        <div
          className="mb-col"
          key={`${b.label}-${i}`}
          title={b.title ?? `${b.label}: ${Math.round(b.value).toLocaleString("ru-RU")}`}
        >
          <div className="mb-track">
            <div
              className={`mb-fill ${hot ? "hot" : ""}`}
              style={{ height: `${Math.max(3, Math.round((b.value / max) * 100))}%` }}
            />
          </div>
          {/* Подписи прореживаем: каждая — шум при 30 столбиках. */}
          <div className="mb-label">{bars.length <= 8 || i % Math.ceil(bars.length / 6) === 0 ? b.label : ""}</div>
        </div>
      ))}
    </div>
  );
}
