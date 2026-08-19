"use client";

import { useEffect, useState, type ReactNode } from "react";

/**
 * Вкладки карточки автомата (образец «Карточка 360»).
 *
 * Контент всех вкладок отрендерен сервером и остаётся смонтированным —
 * скрытие через hidden, а не размонтирование: в панелях живут формы
 * (статус, узлы, раскладка), и потеря их состояния при переключении
 * вкладок стоила бы человеку набранного текста.
 *
 * Любой элемент контента с data-mc-tab="ключ" переключает вкладку — так
 * работают строки «Требует внимания» на Обзоре.
 */
export function CardTabs({
  items,
}: {
  items: { key: string; label: string; badge?: string | undefined; content: ReactNode }[];
}) {
  const first = items[0]?.key ?? "";
  const [active, setActive] = useState(first);

  // Прямая ссылка вида /card/…#t-passport открывает нужную вкладку — и на
  // маунте, и при смене хэша без перезагрузки (переход по ссылке внутри страницы).
  useEffect(() => {
    const apply = () => {
      const k = window.location.hash.replace(/^#t-/, "");
      if (k && items.some((i) => i.key === k)) setActive(k);
    };
    apply();
    window.addEventListener("hashchange", apply);
    return () => window.removeEventListener("hashchange", apply);
  }, []);

  useEffect(() => {
    const h = (e: MouseEvent) => {
      const el = (e.target as HTMLElement).closest?.("[data-mc-tab]");
      if (el instanceof HTMLElement && el.dataset["mcTab"]) {
        setActive(el.dataset["mcTab"]);
        window.history.replaceState(null, "", `#t-${el.dataset["mcTab"]}`);
      }
    };
    document.addEventListener("click", h);
    return () => document.removeEventListener("click", h);
  }, []);

  const open = (k: string) => {
    setActive(k);
    window.history.replaceState(null, "", `#t-${k}`);
  };

  return (
    <>
      <nav className="mc-tabs" role="tablist">
        {items.map((i) => (
          <button
            key={i.key}
            type="button"
            role="tab"
            aria-selected={active === i.key}
            className={active === i.key ? "on" : ""}
            onClick={() => open(i.key)}
          >
            {i.label}
            {i.badge ? <span className="mc-tab-badge">{i.badge}</span> : null}
          </button>
        ))}
      </nav>
      {items.map((i) => (
        <div key={i.key} className="mc-panel" hidden={active !== i.key}>
          {i.content}
        </div>
      ))}
    </>
  );
}
