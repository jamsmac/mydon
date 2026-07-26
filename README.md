# MYDON

Единый контур управления всеми направлениями: **GLOBERENT**, **VendHub**, **TRent** и личный контур.
Один продукт, один интерфейс, разные движки под капотом.

## Требования
- Node.js ≥ 20
- pnpm 10 (`corepack enable`)

## Быстрый старт
```bash
pnpm install
cp .env.example .env   # заполнить значения
pnpm build             # сборка всех пакетов и приложений
pnpm dev               # запуск в режиме разработки
```

## Структура
| Путь | Назначение |
|---|---|
| `apps/core` | API + БД (NestJS): реестр сущностей, шина событий, очередь approvals |
| `apps/agents` | AgentOS: исполнение, политики автономии T0–T4 |
| `apps/bot` | Telegram — основной канал (брифинг, approvals, вопросы) |
| `apps/cc` | Веб-дашборд (Next.js): оболочка / Command Center |
| `packages/db` | Drizzle-схема MYDON Core |
| `packages/shared` | Общие типы, утилиты, константы |
| `packages/connectors` | VHM24, Multikassa, Zadarma, cbu.uz |

## Команды
| Команда | Действие |
|---|---|
| `pnpm build` | Собрать всё (Turborepo) |
| `pnpm dev` | Режим разработки |
| `pnpm lint` | Проверка ESLint |
| `pnpm typecheck` | Проверка типов |
| `pnpm format` | Форматирование Prettier |

Контекст и правила — в [CLAUDE.md](./CLAUDE.md). Архитектура — в `~/Developer/mydon-audit/ARCHITECTURE.html`.
