import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { IBM_Plex_Mono, Manrope, Syne } from "next/font/google";
import { core } from "../lib/core";
import { Sidebar, TabBar } from "../components/nav";
import { FloatingChat } from "../components/floating-chat";
import { HeaderActions } from "../components/header-actions";
import { Background } from "../components/bg/background";
import "./globals.css";

// Шрифты фирменные (ТЗ). next/font забирает их на сборке и раздаёт со своего
// сервера — в рантайме наружу не ходим, панель работает и без интернета.
const syne = Syne({
  subsets: ["latin"],
  weight: ["700", "800"],
  variable: "--font-display",
});
const manrope = Manrope({
  subsets: ["latin", "cyrillic"],
  weight: ["400", "500", "600"],
  variable: "--font-body",
});
const mono = IBM_Plex_Mono({
  subsets: ["latin", "cyrillic"],
  weight: ["400", "500", "600"],
  variable: "--font-mono",
});

export const metadata: Metadata = {
  title: "MYDON · командный центр",
  description: "Единый контур управления направлениями",
};

export const viewport: Viewport = {
  themeColor: "#0A1628",
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
  const [pending, queue] = await Promise.all([pendingCount(), queueCount()]);

  return (
    <html lang="ru" className={`${syne.variable} ${manrope.variable} ${mono.variable}`}>
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
            <HeaderActions pendingCount={pending} />
          </header>

          <div className="body">
            <Sidebar pendingCount={pending} queueCount={queue} />
            <main className="scroll">
              <div className="wrap">{children}</div>
            </main>
          </div>

          <TabBar pendingCount={pending} />
          <FloatingChat />
        </div>
      </body>
    </html>
  );
}
