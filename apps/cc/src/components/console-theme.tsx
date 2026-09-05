"use client";

import { useEffect } from "react";

/**
 * Тёмная тема на маршруте агентского слоя (правило дизайна §4).
 *
 * Ставится из клиента, а не в разметке: `data-theme` живёт на `<html>`, а его
 * отдаёт корневой layout — общий для светлых бизнес-экранов. Возвращаем
 * прежнее значение при уходе со страницы, иначе тёмная тема «протекла» бы на
 * соседний экран после SPA-навигации.
 */
export function ConsoleTheme() {
  useEffect(() => {
    const el = document.documentElement;
    const prev = el.dataset.theme;
    el.dataset.theme = "dark";
    return () => {
      if (prev === undefined) delete el.dataset.theme;
      else el.dataset.theme = prev;
    };
  }, []);
  return null;
}
