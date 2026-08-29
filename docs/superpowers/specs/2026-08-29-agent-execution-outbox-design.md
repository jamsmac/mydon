# Durable execution и outbox задач агента

Дата: 2026-08-29
Статус: первая вертикальная реализация после единого LLM-ledger

## Цель

Закрыть разрыв между результатом навыка и внутренними эффектами MYDON. После
того как результат записан в Core, stale takeover не должен повторно вызывать
LLM, создавать второй approval/event/memory или публиковать второй отчёт в
Notion.

Эта фаза не заявляет общий `exactly once`. PostgreSQL и внешний API нельзя
закоммитить одной транзакцией, а Telegram и Notion не дают достаточного
идемпотентного ключа для любого первого вызова. Гарантия фазы начинается после
успешного durable checkpoint; окно `provider response -> checkpoint` требует
следующей архитектурной фазы, где provider dispatch принадлежит durable job.

## Инварианты

1. Идентичность вычисления — `task_id + execution_attempt_id`. `run_id` не
   входит в ключ результата: он меняется при takeover и служит только текущим
   fencing token.
2. Checkpoint принимается только от текущего `run_id` и того же
   `execution_attempt_id` под блокировкой строки task.
3. Core сам считает hash входа задачи и hash payload. Exact replay возвращает
   существующий checkpoint; другой payload под тем же attempt получает `409`.
4. Takeover читает готовый checkpoint и не вызывает навык/LLM повторно.
5. Approval, `agent.action`, delta-memory, итог task, audit и intent доставки
   создаются одной транзакцией `commit-agent-outcome`.
6. Повтор commit с тем же hash возвращает сохранённые IDs. Другой commit под
   тем же attempt запрещён.
7. Дневной action cap повторно проверяет Core под advisory lock в той же
   транзакции, где создаётся `agent.action`. Два worker не могут оба пройти
   последний свободный слот.
8. Изменившийся input задачи не получает старый результат автоматически.
   Execution блокируется/оставляется для явного решения владельца.
9. Owner retry не удаляет историю: ready checkpoint переводится в
   `abandoned`, затем только явное owner-only действие разрешает новый attempt.
10. Внешний Notion-вызов не выполняется внутри task transaction. В ней
    создаётся только immutable outbox intent.

## Состояния

`task_agent_execution`:

- `ready` — checkpoint сохранён, внутренний outcome ещё не применён;
- `committed` — task outcome и все Core-local effects применены атомарно;
- `abandoned` — владелец явно отказался от checkpoint и разрешил новый attempt.

`outbox_delivery`:

- `pending` — intent готов;
- `dispatching` — один worker получил fencing token до внешнего вызова;
- `sent | skipped` — однозначный терминальный исход;
- `unknown` — внешний сервис мог принять запрос, автоматический повтор запрещён;
- `dead` — payload невалиден или провайдер однозначно отклонил все bounded-попытки.

Первый dispatcher выбирает at-most-once для Notion: intent помечается
`dispatching` до `pages.create`. Сбой после удалённого принятия не создаёт
автоматический дубль, но оставляет видимый `unknown/dispatching` для ручной
reconciliation.

## Поток задачи

1. Agents получает durable claim из Core и возможный checkpoint прежней
   generation.
2. Если checkpoint отсутствует, навык вычисляет `proposal | no_signal`.
3. До approval/event/memory/executor вызывается checkpoint endpoint.
4. Политика выбирает outcome. В task-mode любой ещё не durable executor понижается до
   `approval_requested`: внешняя мутация не имеет права обогнать checkpoint/outbox.
5. `commit-agent-outcome` атомарно применяет внутренние эффекты, закрывает task
   и добавляет Notion intent.
6. Отдельный dispatcher забирает intent, публикует и фиксирует исход.

## Явные границы этой фазы

- Cron invocation пока не имеет общей execution row; scheduled LLM остаётся
  fail-closed при replay. Cron approval/event/memory дедуплицируются stable `clientKey`,
  но это не заменяет durable provider result.
- Assistant, Documents, CC и Telegram требуют отдельного `llm_result`,
  artifact store и inbox/outbox. Особенно важно добавить `operationHash`
  фактического provider payload: текущий reserve hash не доказывает, что под
  тем же request key пришёл тот же prompt.
- Task executor не запускается, пока его эффект не переведён в типизированный allowlisted
  durable outbox. Произвольную внешнюю мутацию через commit endpoint выполнять нельзя.
- Автоматического retry для `unknown` внешней доставки нет.

## Приёмка

- падение после checkpoint и takeover не вызывает реализацию навыка повторно;
- exact checkpoint/commit replay возвращает тот же результат;
- hash mismatch и stale `run_id` не создают ни одного эффекта;
- два concurrent commit создают один approval и один `agent.action`;
- при cap=1 из двух concurrent commit проходит один;
- потерянный HTTP-ответ commit восстанавливает прежний `approval_id`;
- Notion intent и task close появляются в одной транзакции;
- внешний Notion-клиент не вызывается из Core transaction;
- owner retry оставляет abandoned историю;
- миграция проходит на чистом PostgreSQL 17 и поверх схемы `0075`.
