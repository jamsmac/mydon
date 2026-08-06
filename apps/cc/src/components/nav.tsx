"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { DOMAIN_LABELS, DOMAINS } from "@mydon/shared";
import { Ic } from "./icons";

/**
 * Навигация — структура из дизайна Claude Design: три группы на компьютере,
 * пять пунктов внизу на телефоне. Помощник — плавающая кнопка, не пункт меню.
 */
const MAIN = [
  { href: "/mydon", icon: "home", label: "Главное" },
  { href: "/tasks", icon: "tasks", label: "Задачи" },
  // Один вход вместо двух очередей: решения агентов + карточки на утверждение.
  { href: "/inbox", icon: "dec", label: "Входящие", hot: true },
  { href: "/team", icon: "team", label: "Команда" },
  { href: "/agents", icon: "agents", label: "Агенты" },
];
// «Автоматы» и «Кофе-бункеры» — теперь вкладки рабочего места VendHub
// (/domain/vendhub), а не отдельные пункты: операционка живёт при направлении.
const SYSTEM = [
  // Обслуживание — сквозной контур: графики и журнал работ по всему парку,
  // а не операционка одного направления.
  { href: "/maintenance", icon: "box", label: "Обслуживание" },
  { href: "/registry", icon: "reg", label: "Реестр" },
  { href: "/audit", icon: "jour", label: "Журнал" },
  { href: "/system", icon: "reg", label: "Система" },
];

function isActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(href + "/");
}

/** Боковое меню — только на компьютере. */
export function Sidebar({ pendingCount }: { pendingCount: number }) {
  const pathname = usePathname();
  const item = (n: { href: string; icon: string; label: string; hot?: boolean }) => (
    <Link
      key={n.href}
      href={n.href}
      aria-current={isActive(pathname, n.href) ? "page" : undefined}
    >
      <Ic name={n.icon} />
      {n.label}
      {n.hot && pendingCount > 0 && <span className="bdg2">{pendingCount}</span>}
    </Link>
  );
  return (
    <nav className="side" aria-label="Разделы">
      <div className="gl">Обзор</div>
      {MAIN.map(item)}
      <div className="gl">Направления</div>
      {DOMAINS.filter((d) => d !== "mydon").map((d) =>
        item({ href: `/domain/${d}`, icon: "biz", label: DOMAIN_LABELS[d] }),
      )}
      <div className="gl">Система</div>
      {SYSTEM.map(item)}
    </nav>
  );
}

/** Нижняя панель — основной способ навигации на телефоне. */
export function TabBar({ pendingCount }: { pendingCount: number }) {
  const pathname = usePathname();
  return (
    <nav className="tabbar" aria-label="Разделы">
      {MAIN.map((n) => (
        <Link
          key={n.href}
          href={n.href}
          aria-current={isActive(pathname, n.href) ? "page" : undefined}
        >
          <Ic name={n.icon} />
          {n.hot && pendingCount > 0 && (
            <span className="bdg" aria-label={`решений: ${pendingCount}`} />
          )}
          <span>{n.label}</span>
        </Link>
      ))}
    </nav>
  );
}
