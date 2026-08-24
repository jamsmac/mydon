# MYDON — контекст монорепо

> Автономный проект «с нуля». Правила legacy-проектов (VendHub-OS и др.) здесь
> НЕ применяются — они только доноры готового кода по запросу.
> Основание архитектуры — аудит в `~/Developer/mydon-audit/` (11 фронтов + ARCHITECTURE.html).

## Что это

MYDON — единый инструмент управления всеми направлениями владельца.
Один продукт, один интерфейс, разные движки под капотом.

**Три слоя:** Core (данные) · Agents (исполнение) · CC/Shell (интерфейс).
**Принцип:** одна оболочка — много движков. Отдельный движок — да, отдельный интерфейс — нет.

## Направления (домены)

- **GLOBERENT** — дистрибуция погрузчиков HELI (`/globerent`)
- **VendHub** — сеть кофейных автоматов, движок VHM24 отдельный, UI в оболочке (`/vendhub`)
- **Личный контур** — недвижимость, транспорт, накопления (`/personal`, только владелец)
- **MYDON** — Command Center, агенты (`/mydon`)

## Стек (целевой, зафиксирован в ТЗ)

TypeScript (strict) · NestJS · Next.js · PostgreSQL · Drizzle · REST/class-validator · Turborepo · pnpm

## Структура

```
mydon/
├── apps/
│   ├── core/         # API + БД (NestJS) — единый реестр, шина событий, approvals
│   ├── agents/       # AgentOS — исполнение, политики автономии
│   ├── bot/          # Telegram — основной канал: брифинг, approvals, вопросы
│   └── cc/           # веб-дашборд (Next.js) — оболочка/Command Center
├── packages/
│   ├── db/           # Drizzle-схема MYDON Core
│   ├── shared/       # типы, утилиты, константы (TZ)
│   └── connectors/   # VHM24, Multikassa, Zadarma, cbu.uz, n8n
└── docs/
```

## Схема MYDON Core (packages/db)

org · project · entity · person · task · approval · event · document · money_flow · note · audit_log
Принцип: сначала реестр, потом дашборд. Дашборд без данных — картинка.

## Правила разработки

- **TypeScript strict**, без `any`.
- **Часовой пояс Asia/Tashkent** везде, включая cron.
- **Язык:** русский в UI, английский в коде.
- **Секреты:** ни одного ключа в коде. Только `.env` (в `.gitignore`) + `.env.example` в репо.
- **Перенос кода, не переписывание:** готовый рабочий код переносить (`cp`/`git subtree`)
  из доноров (VendHub-OS для оболочки, mydon_1 для Command Center), чинить импорты — не генерировать заново.
- **Ничего не удалять** в проектах-донорах.
- **Базы движков не сливать:** общая оболочка — да, общая БД для всего — нет. VHM24 держит свою схему.
- **Мутирующие формы CC** (apps/cc) — принятая конвенция (решение 24.08.2026,
  миграция Codex принята осознанно): `onSubmit` + `event.preventDefault()` +
  `new FormData(event.currentTarget)` → вызов server action в
  `startTransition`; при `res.ok` — сброс ошибки и `router.refresh()`, при
  отказе — `setError(res.message)`, **поля сохраняют ввод**. НЕ возвращаться
  к `<form action={fn}>`: React 19 сбрасывает неуправляемые поля после
  экшена — ошибка Core теряла бы весь ввод длинных форм. Эталон —
  `components/customs-rates.tsx`; тесты обязаны проверять сохранение ввода
  при ошибке (см. customs-rates.test.tsx).

## Инфраструктура

Hetzner (4 vCPU / 7.6 ГБ / 38 ГБ, диск ~70%) + Tailscale. Fly.io выводится.
Внешний watchdog обязателен (монитор на другом провайдере).

## Доноры кода (только чтение)

- Оболочка (auth/RBAC/дизайн-система): `~/Projects/VendHub-OS/VendHub-OS`
- Command Center + агенты (прототип): `~/Developer/mydon_1`, `~/Developer/mydon-agent-os`
- VendHub-движок: `~/Projects/VendHub/VendHubManager/VHM24`
