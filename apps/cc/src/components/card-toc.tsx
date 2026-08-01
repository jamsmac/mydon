"use client";

import { useEffect, useState } from "react";

/**
 * Оглавление карточки: липкая строка-переход по её секциям.
 *
 * Карточка — длинный свиток (утверждение, фото, где стоит, рецепт, склад…).
 * Оглавление собирается САМО из того, что реально отрисовано: сканируем
 * `[data-toc]` и берём лишь непустые секции (компонент мог вернуть null — тогда
 * его обёртка пустая, и в оглавление он не попадёт). Клик — плавный переход.
 *
 * Одна секция — оглавление ни к чему, не показываем.
 */
export function CardToc() {
  const [items, setItems] = useState<{ id: string; label: string }[]>([]);

  useEffect(() => {
    const els = Array.from(document.querySelectorAll<HTMLElement>("[data-toc]"));
    setItems(
      els
        .filter((el) => el.id && el.offsetHeight > 0)
        .map((el) => ({ id: el.id, label: el.getAttribute("data-toc") ?? el.id })),
    );
  }, []);

  if (items.length < 2) return null;

  const go = (id: string) => {
    const el = document.getElementById(id);
    if (!el) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
  };

  return (
    <nav className="cardtoc" aria-label="Разделы карточки">
      {items.map((i) => (
        <button key={i.id} type="button" className="ctchip" onClick={() => go(i.id)}>
          {i.label}
        </button>
      ))}
    </nav>
  );
}
