"use client";

import { useEffect, useState } from "react";
import { Chat } from "./chat";

/**
 * Плавающий помощник: кнопка в углу на любом экране, раскрывается в чат.
 * Не отдельная вкладка — доступен всюду, пишешь и он действует (запрос владельца).
 */
export function FloatingChat() {
  const [open, setOpen] = useState(false);

  // Esc закрывает; при открытом чате запрещаем прокрутку фона на телефоне.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [open]);

  return (
    <>
      <button
        className={`fab ${open ? "hidden" : ""}`}
        onClick={() => setOpen(true)}
        aria-label="Открыть помощника"
      >
        <span aria-hidden>✦</span>
      </button>

      {open && (
        <>
          <div className="fab-overlay" onClick={() => setOpen(false)} />
          <div className="fab-panel" role="dialog" aria-label="Помощник MYDON">
            <div className="fab-head">
              <span className="fab-title">
                <span aria-hidden>✦</span> Помощник
              </span>
              <button className="fab-close" onClick={() => setOpen(false)} aria-label="Закрыть">
                ×
              </button>
            </div>
            <Chat />
          </div>
        </>
      )}
    </>
  );
}
