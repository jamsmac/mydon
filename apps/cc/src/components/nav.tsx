"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { DOMAIN_LABELS, DOMAINS } from "@mydon/shared";
import { Ic } from "./icons";

/**
 * Навигация — структура из дизайна Claude Design: три группы на компьютере,
 * нижняя панель на телефоне. Помощник — плавающая кнопка, не пункт меню.
 *
 * ⚠️ В нижнюю панель попадает ТОЛЬКО `MAIN` — сквозные пункты, ни одного
 * направления. Сайдбар при этом скрыт ниже 900 px. То есть в рабочее место
 * (`/domain/*`) с телефона нельзя попасть отсюда вовсе; вход туда даёт блок
 * «Направления» на главной (`app/mydon/page.tsx`). Прежде чем убирать его
 * оттуда — завести направления сюда.
 */
const MAIN = [
  { href: "/mydon", icon: "home", label: "Главное" },
  { href: "/tasks", icon: "tasks", label: "Задачи" },
  // Один вход вместо двух очередей: решения агентов + карточки на утверждение.
  { href: "/inbox", icon: "dec", label: "Входящие", hot: true },
  { href: "/team", icon: "team", label: "Команда" },
  // «Действия» — лента «кто из сотрудников что сделал»: прямой ответ на
  // главный вопрос владельца, раньше размазанный по пяти экранам.
  { href: "/team/actions", icon: "jour", label: "Действия" },
  { href: "/agents", icon: "agents", label: "Агенты" },
  // «Навыки» — витрина того, что агенты умеют: вопрос «что оно вообще может»
  // владелец задаёт чаще, чем «как настроен вот этот агент».
  { href: "/skills", icon: "spark", label: "Навыки" },
];
// «Автоматы» и «Кофе-бункеры» — теперь вкладки рабочего места VendHub
// (/domain/vendhub), а не отдельные пункты: операционка живёт при направлении.
// «Обслуживание», «Узлы» и «Места» ОТСЮДА УБРАНЫ (решение владельца
// 09.09.2026) и стали группой «Парк» рабочего места VendHub. Три года эти
// экраны числились «сквозными контурами — не операционкой одного направления»;
// посылка была в том, что ими воспользуется и GLOBERENT. Слово владельца сняло
// её: «у GLOBERENT другая деятельность, при необходимости скопируем методы».
// Код это подтверждал и до разговора — `places-view` и `maintenance-view`
// спрашивают Core строкой `entitiesOfType("vendhub", …)`, то есть экраны были
// вендинговыми всегда, сквозными их делала только подпись в меню. Адреса
// /maintenance, /parts, /places ЖИВЫ: на них ссылаются карточки, бот и
// закладки, и тело у них общее с вкладками «Парка».
const SYSTEM = [
  { href: "/registry", icon: "reg", label: "Реестр" },
  // «Документы» — репозиторий знаний (роутеры, память, паспорта, навыки) с
  // диска образа: сквозной справочник, а не операционка направления. В SYSTEM,
  // а не в MAIN: таббар телефона уже занят семью пунктами.
  { href: "/docs", icon: "jour", label: "Документы" },
  // «Мозг» — тот же репозиторий знаний, но связями: кто на кого ссылается,
  // чей это навык, каким инструментом он лезет наружу. Рядом с «Документами»
  // намеренно: это два взгляда на одни и те же файлы.
  { href: "/brain", icon: "sky", label: "Мозг" },
  // «Артефакты» — кольцо того, что произвели бот и агенты: документы, фото,
  // чеки из хранилища `attachment` (срез A3). Рядом с «Документами» и «Мозгом»
  // намеренно: те — знания с диска образа, это — файлы из хранилища; три
  // взгляда на «что у нас есть». В SYSTEM, а не в MAIN: таббар телефона
  // занят семью пунктами.
  { href: "/artifacts", icon: "jour", label: "Артефакты" },
  // «Приложения» — здоровье источников: что ходит наружу (OurVend, курс,
  // Notion, бот) и что читает только Core. Рядом с «Рутинами» и «Прогонами»:
  // это тот же пульт агентского слоя, только про связь, а не про расписание.
  { href: "/apps", icon: "bell", label: "Приложения" },
  // «Рутины» и «Прогоны» — пульт агентского слоя: когда сработает и как прошло.
  // В SYSTEM, а не в MAIN: пункт сквозной (расписания всех направлений сразу),
  // а таббар телефона уже занят семью пунктами — восьмой вытеснил бы «Агентов».
  { href: "/crons", icon: "clock", label: "Рутины" },
  { href: "/flows", icon: "clock", label: "Прогоны" },
  { href: "/audit", icon: "jour", label: "Журнал" },
  // «Активация», а не «Система»: одно слово стояло и на группе меню, и на
  // пункте внутри неё, и фраза «это в Системе» не сообщала ничего. Сам экран
  // называется «Система · Активация» — берём вторую половину, она и описывает
  // содержимое: мозг агентов, память, паузы, бюджеты, доступ.
  { href: "/system", icon: "reg", label: "Активация" },
];

function isActive(pathname: string, href: string): boolean {
  if (!(pathname === href || pathname.startsWith(href + "/"))) return false;
  // Побеждает самый длинный совпавший пункт: «/team/actions» не должен
  // подсвечивать заодно и «Команду» — активной должна быть одна вкладка.
  return ![...MAIN, ...SYSTEM].some(
    (i) => i.href.length > href.length && (pathname === i.href || pathname.startsWith(i.href + "/")),
  );
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
