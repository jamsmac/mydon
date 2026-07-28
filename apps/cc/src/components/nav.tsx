"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { DOMAIN_LABELS, DOMAINS } from "@mydon/shared";

/** Разделы оболочки. Порядок — от «что требует решения» к справочному. */
// Помощник — не в этом списке: он плавающий, доступен на любом экране (FloatingChat).
const MAIN = [
  { href: "/mydon", icon: "◉", label: "Главное" },
  { href: "/approvals", icon: "✋", label: "Решения" },
  { href: "/agents", icon: "⚙", label: "Агенты" },
  { href: "/registry", icon: "▤", label: "Реестр" },
  { href: "/audit", icon: "≡", label: "Журнал" },
];

function isActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(href + "/");
}

/** Боковое меню — только на компьютере. */
export function Sidebar({ pendingCount }: { pendingCount: number }) {
  const pathname = usePathname();
  return (
    <nav className="side" aria-label="Разделы">
      {MAIN.map((item) => (
        <Link
          key={item.href}
          href={item.href}
          className="navlink"
          aria-current={isActive(pathname, item.href) ? "page" : undefined}
        >
          <span aria-hidden>{item.icon}</span>
          {item.label}
          {item.href === "/approvals" && pendingCount > 0 && (
            <span className="badge">{pendingCount}</span>
          )}
        </Link>
      ))}

      <div className="group">Направления</div>
      {DOMAINS.filter((d) => d !== "mydon").map((d) => (
        <Link
          key={d}
          href={`/domain/${d}`}
          className="navlink"
          aria-current={isActive(pathname, `/domain/${d}`) ? "page" : undefined}
        >
          <span aria-hidden>·</span>
          {DOMAIN_LABELS[d]}
        </Link>
      ))}
    </nav>
  );
}

/** Нижняя панель — основной способ навигации на телефоне. */
export function TabBar({ pendingCount }: { pendingCount: number }) {
  const pathname = usePathname();
  return (
    <nav className="tabbar" aria-label="Разделы">
      {MAIN.map((item) => (
        <Link
          key={item.href}
          href={item.href}
          aria-current={isActive(pathname, item.href) ? "page" : undefined}
        >
          <i aria-hidden>{item.icon}</i>
          {item.label}
          {item.href === "/approvals" && pendingCount > 0 && (
            <span className="dot" aria-label={`требуют решения: ${pendingCount}`} />
          )}
        </Link>
      ))}
    </nav>
  );
}
