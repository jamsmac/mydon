import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { IBM_Plex_Mono, Manrope, Syne } from "next/font/google";
import { core } from "../lib/core";
import { Sidebar, TabBar } from "../components/nav";
import { FloatingChat } from "../components/floating-chat";
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
  weight: ["400", "500"],
  variable: "--font-mono",
});

export const metadata: Metadata = {
  title: "MYDON",
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

export default async function RootLayout({ children }: { children: ReactNode }) {
  const pending = await pendingCount();

  return (
    <html lang="ru" className={`${syne.variable} ${manrope.variable} ${mono.variable}`}>
      <body>
        <div className="shell">
          <header className="topbar">
            <span className="brand">
              MY<span>DON</span>
            </span>
            <span className="where">Asia/Tashkent</span>
          </header>

          <div className="body">
            <Sidebar pendingCount={pending} />
            <main>{children}</main>
          </div>

          <TabBar pendingCount={pending} />
          <FloatingChat />
        </div>
      </body>
    </html>
  );
}
