"use client";

/**
 * Граница ошибки рабочего места направления.
 *
 * Без неё падение любого куска страницы отдаёт стандартный экран Next без
 * навигации: человек оказывается в тупике, откуда не выйти иначе как правкой
 * адреса. Страница направления собирает данные из десятка источников, и
 * каждый может ответить не тем — тупик тут не гипотетический.
 */
export default function DomainError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="card" style={{ maxWidth: 620 }}>
      <div className="h2">Раздел не открылся</div>
      <p className="hint" style={{ marginTop: 8 }}>
        Что-то пошло не так при сборке этого экрана. Данные не повреждены — не открылась именно
        страница.
      </p>
      {error.digest && (
        <p className="hint mono" style={{ marginTop: 8 }}>
          код: {error.digest}
        </p>
      )}
      <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
        <button type="button" className="btn sm pri" onClick={reset}>
          Попробовать снова
        </button>
        <a className="btn sm" href="/mydon">
          На главную
        </a>
      </div>
    </div>
  );
}
