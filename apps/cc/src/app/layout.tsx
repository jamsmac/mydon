import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import localFont from "next/font/local";
import { core } from "../lib/core";
import { Sidebar, TabBar } from "../components/nav";
import { FloatingChat } from "../components/floating-chat";
import { CommandPalette } from "../components/command-palette";
import { HeaderActions } from "../components/header-actions";
import { Background } from "../components/bg/background";
import "./globals.css";

// Шрифты фирменные (ТЗ) — ЛОКАЛЬНЫЕ ФАЙЛЫ, а не `next/font/google`.
// Почему так: `next/font/google` забирает шрифт ПО СЕТИ НА СБОРКЕ, и Next 16 с
// Turbopack при недостижимом `fonts.googleapis.com` не предупреждает, а роняет
// сборку («next/font: error: Failed to fetch `Golos Text` from Google Fonts»).
// `.dockerignore` исключает `**/.next`, поэтому кеша шрифтов в контексте сборки
// нет никогда — каждая сборка ходила в интернет заново, и любой сбой доступа
// останавливал автодеплой на шаге `compose build` (до миграций и переключения
// контейнеров: прод при этом жив, но ни один коммит не выкатывается) и заодно
// весь CI. Теперь файлы лежат в репозитории (`src/fonts`, OFL — лицензии рядом),
// и сборка не зависит от сети вовсе.
//
// Начертания те же, что раньше подключались из Google. Кириллица и латиница
// СЛИТЫ В ОДИН ФАЙЛ на начертание (fontsource-подмножества latin/latin-ext/
// cyrillic/cyrillic-ext, объединённые fontTools): `next/font/local` не умеет
// `unicode-range` на отдельный `src`, а двумя файлами одного веса браузер брал
// бы первый и кириллица снова уезжала бы в системный запасной шрифт — ровно тот
// дефект, из-за которого Syne заменили на Golos Text.
//
// Golos Text вместо Syne + Manrope. Syne подключался ТОЛЬКО с латиницей, а на
// нём висели ВСЕ заголовки — и в них русский текст. То есть кириллические
// заголовки уже сейчас рендерились не Syne, а системным запасным шрифтом:
// дефект был виден глазом как «типографика какая-то не такая», но не читался
// как ошибка. Golos Text — русская гарнитура, кириллица у неё родная.
const golosDisplay = localFont({
  src: [
    { path: "../fonts/golos-text-600.woff2", weight: "600", style: "normal" },
    { path: "../fonts/golos-text-700.woff2", weight: "700", style: "normal" },
  ],
  display: "swap",
  variable: "--font-display",
});
const golosBody = localFont({
  src: [
    { path: "../fonts/golos-text-400.woff2", weight: "400", style: "normal" },
    { path: "../fonts/golos-text-500.woff2", weight: "500", style: "normal" },
    { path: "../fonts/golos-text-600.woff2", weight: "600", style: "normal" },
  ],
  display: "swap",
  variable: "--font-body",
});
const mono = localFont({
  src: [
    { path: "../fonts/ibm-plex-mono-400.woff2", weight: "400", style: "normal" },
    { path: "../fonts/ibm-plex-mono-500.woff2", weight: "500", style: "normal" },
    { path: "../fonts/ibm-plex-mono-600.woff2", weight: "600", style: "normal" },
  ],
  display: "swap",
  variable: "--font-mono",
});

export const metadata: Metadata = {
  title: "MYDON · командный центр",
  description: "Единый контур управления направлениями",
};

export const viewport: Viewport = {
  // Цвет строки браузера следует теме, а не зашит тёмным: раньше на светлой
  // панели телефон продолжал рисовать тёмно-синюю шапку.
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f4f4ee" },
    { media: "(prefers-color-scheme: dark)", color: "#111712" },
  ],
  width: "device-width",
  initialScale: 1,
};

/** Счётчик в меню не должен ронять всю панель, если Core прилёг. */
async function pendingCount(): Promise<number> {
  try {
    return (await core.pendingApprovals()).length;
  } catch {
    return 0;
  }
}

/**
 * Сколько записей ждёт слова владельца — для значка «На утверждение».
 * Считаем плитки очереди: новые карточки плюс карточки с предложенными
 * значениями, чтобы число в меню совпадало с тем, что владелец там увидит.
 */
async function queueCount(): Promise<number> {
  try {
    const { cards, fields } = await core.pendingEntities();
    return cards.length + new Set(fields.map((f) => f.entityId)).size;
  } catch {
    return 0;
  }
}

export default async function RootLayout({ children }: { children: ReactNode }) {
  // «Входящие» = решения агентов + карточки реестра на утверждение. Один счётчик
  // на объединённый вход.
  const [pending, queue] = await Promise.all([pendingCount(), queueCount()]);
  const inbox = pending + queue;

  return (
    <html lang="ru" className={`${golosDisplay.variable} ${golosBody.variable} ${mono.variable}`}>
      <body>
        <Background />
        <div className="app">
          <header className="hdr">
            <svg className="logo" viewBox="0 0 24 24" aria-hidden>
              <path d="M4 20 12 4l8 16-8-5z" fill="#1A6BFF" />
            </svg>
            <h1>MYDON</h1>
            <span className="sub">· командный центр</span>
            <span className="sp" />
            <HeaderActions pendingCount={inbox} />
          </header>

          <div className="body">
            <Sidebar pendingCount={inbox} />
            <main className="scroll">
              <div className="wrap">{children}</div>
            </main>
          </div>

          <TabBar pendingCount={inbox} />
          <FloatingChat />
          <CommandPalette />
        </div>
      </body>
    </html>
  );
}
