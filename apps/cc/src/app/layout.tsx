import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import localFont from "next/font/local";
import { cookies, headers } from "next/headers";
import Link from "next/link";
import { core } from "../lib/core";
import { ACTOR_COOKIE, declaredAgentRef } from "../lib/actor";
import { CONSOLE_HEADER, THEME_BG, THEME_COOKIE, THEME_HEADER, isThemeChoice, type ThemeChoice } from "../lib/theme";
import { Sidebar, TabBar } from "../components/nav";
import { FloatingChat } from "../components/floating-chat";
import { CommandPalette } from "../components/command-palette";
import { HeaderActions } from "../components/header-actions";
import { Background } from "../components/bg/background";
import { ThemeSync } from "../components/theme-sync";
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

/**
 * Тема и область запроса — из заголовков, которые проставил `src/proxy.ts`
 * (правило — `lib/theme.ts`, одно на сервер и клиент).
 *
 * Заголовка нет (прокси не отработал, адрес вне его matcher) — «системная» и
 * «не консоль»: разметка без атрибутов, как до среза. Первый кадр тогда
 * системный, а клиентский `ThemeSync` поправит его после гидрации — хуже, чем
 * штамп, но не ошибка.
 */
async function requestTheme(): Promise<{ theme: ThemeChoice | null; isConsole: boolean }> {
  const h = await headers();
  const theme = h.get(THEME_HEADER);
  return {
    theme: isThemeChoice(theme) ? theme : null,
    isConsole: h.get(CONSOLE_HEADER) === "1",
  };
}

/**
 * Цвет строки браузера — по ФАКТИЧЕСКОЙ теме, а не только по системной
 * (Р-Д2-5): при штампе `dark` на системно-светлом телефоне статический
 * `viewport` рисовал светлую шапку над тёмной консолью. Функция вместо
 * объекта: статический `viewport` и `generateViewport` в одном сегменте вместе
 * не экспортируются. Без штампа — прежняя пара по медиавыражению.
 */
export async function generateViewport(): Promise<Viewport> {
  const { theme } = await requestTheme();
  return {
    themeColor:
      theme === null
        ? [
            { media: "(prefers-color-scheme: light)", color: THEME_BG.light },
            { media: "(prefers-color-scheme: dark)", color: THEME_BG.dark },
          ]
        : THEME_BG[theme],
    width: "device-width",
    initialScale: 1,
  };
}

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
  const [pending, queue, { theme, isConsole }] = await Promise.all([
    pendingCount(),
    queueCount(),
    requestTheme(),
  ]);
  const inbox = pending + queue;

  // Выбор темы для переключателя — из КУКИ, не из заголовка `x-mydon-theme`:
  // заголовок несёт фактическую тему (на /apps без куки это «dark»), а
  // переключатель показывает ВЫБОР — «как в системе» там законно. Кука —
  // единственный носитель выбора; чужое значение считаем отсутствием выбора,
  // ровно как `themeFor` в прокси (`src/proxy.ts`) — той же дверью
  // `isThemeChoice`, а не копией предиката: две копии «что считается темой»
  // разъехались бы на первом же новом значении.
  const rawTheme = (await cookies()).get(THEME_COOKIE)?.value;
  const themeChoice: ThemeChoice | "system" = isThemeChoice(rawTheme) ? rawTheme : "system";

  // Объявленный агент (R-H-9) — плашкой на КАЖДОЙ странице: пока она видна,
  // записи из этого браузера подписываются агентом, а не владельцем. Без
  // плашки забытое объявление молча отдало бы агенту решения владельца.
  const declaredAgent = declaredAgentRef((await cookies()).get(ACTOR_COOKIE)?.value);

  // Тема — АТРИБУТОМ В РАЗМЕТКЕ, до любого скрипта (Р-Д2-1): прежний ручной
  // штамп темы ставил её из `useEffect` на каждой странице, и первый кадр
  // консоли был светлым.
  // `undefined` — атрибута нет вовсе, работает `prefers-color-scheme`.
  // `suppressHydrationWarning`: клиентский `ThemeSync` вправе поменять атрибут
  // раньше, чем React сверит разметку, — это ожидаемое расхождение, не дефект.
  // `data-console` на `.app` — область, а не тема: точечная сетка холста
  // командного центра включается по нему и только в тёмной теме.
  return (
    <html
      lang="ru"
      className={`${golosDisplay.variable} ${golosBody.variable} ${mono.variable}`}
      data-theme={theme ?? undefined}
      suppressHydrationWarning
    >
      <body>
        <Background />
        <ThemeSync />
        <div className="app" data-console={isConsole ? "true" : undefined}>
          <header className="hdr">
            <svg className="logo" viewBox="0 0 24 24" aria-hidden>
              <path d="M4 20 12 4l8 16-8-5z" fill="#1A6BFF" />
            </svg>
            <h1>MYDON</h1>
            <span className="sub">· командный центр</span>
            <span className="sp" />
            {declaredAgent !== null && (
              <Link href="/actor" className="chip h" title="Записи из этого браузера подписываются агентом — нажми, чтобы вернуть авторство себе">
                действует {declaredAgent.replace("agent:", "агент ")}
              </Link>
            )}
            <HeaderActions pendingCount={inbox} themeChoice={themeChoice} />
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
