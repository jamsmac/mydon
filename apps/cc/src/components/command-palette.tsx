"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { searchRegistry, type PaletteHit } from "../app/actions";

/**
 * Палитра ⌘K: «Найти карточку или отчёт» (из обложки VendHub).
 *
 * Открывается по Cmd/Ctrl+K или кнопкой поиска в шапке (через событие
 * `mydon:palette-open`). Ищет карточки реестра и отчёты источников, переход —
 * Enter или клик. Esc закрывает. Оформление текущее (тёмное).
 */
export function CommandPalette() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<PaletteHit[]>([]);
  const [active, setActive] = useState(0);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const close = useCallback(() => {
    setOpen(false);
    setQ("");
    setHits([]);
    setActive(0);
  }, []);

  // Открытие: Cmd/Ctrl+K и событие от кнопки в шапке.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    const onOpen = () => setOpen(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("mydon:palette-open", onOpen);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mydon:palette-open", onOpen);
    };
  }, []);

  // Фокус в поле при открытии.
  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  // Поиск с задержкой: не дёргаем Core на каждую букву.
  useEffect(() => {
    if (!open) return;
    const query = q.trim();
    if (query.length < 2) {
      setHits([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    let cancelled = false;
    const t = setTimeout(() => {
      void searchRegistry(query).then((res) => {
        if (cancelled) return;
        setHits(res);
        setActive(0);
        setLoading(false);
      });
    }, 180);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [q, open]);

  if (!open) return null;

  const goTo = (h: PaletteHit) => {
    close();
    router.push(h.href);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") close();
    else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, hits.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter" && hits[active]) {
      e.preventDefault();
      goTo(hits[active]);
    }
  };

  return (
    <div className="cmdk-back" onClick={close} role="presentation">
      <div
        className="cmdk"
        role="dialog"
        aria-modal="true"
        aria-label="Поиск по реестру и отчётам"
        onClick={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          className="cmdk-in"
          placeholder="Найти карточку или отчёт…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={onKeyDown}
          aria-label="Запрос поиска"
        />
        <div className="cmdk-list">
          {q.trim().length < 2 ? (
            <div className="cmdk-empty">Введи хотя бы два символа названия.</div>
          ) : loading ? (
            <div className="cmdk-empty">Ищу…</div>
          ) : hits.length === 0 ? (
            <div className="cmdk-empty">Ничего не найдено по «{q.trim()}».</div>
          ) : (
            hits.map((h, i) => (
              <button
                key={`${h.kind}:${h.href}`}
                type="button"
                className={`cmdk-row ${i === active ? "on" : ""}`}
                onMouseEnter={() => setActive(i)}
                onClick={() => goTo(h)}
              >
                <span className={`cmdk-k ${h.kind}`}>{h.kind === "card" ? "карточка" : "отчёт"}</span>
                <span className="cmdk-t">{h.title}</span>
                <span className="cmdk-s">{h.sub}</span>
              </button>
            ))
          )}
        </div>
        <div className="cmdk-foot">
          <span><b>↑↓</b> выбрать</span>
          <span><b>↵</b> открыть</span>
          <span><b>esc</b> закрыть</span>
        </div>
      </div>
    </div>
  );
}
