# Единый LLM-ledger MYDON

Дата: 2026-08-29
Статус: первая реализация

## Зачем

До этой реализации Bot, CC, Documents и Agents вызывали модели независимо.
Проверка бюджета Agents получала нулевые суммы, фактическое использование API
после ответа не сохранялось, а два процесса могли одновременно пройти одну
дневную границу.

Нужен один серверный источник истины, который **до** платного вызова атомарно
резервирует верхнюю оценку стоимости, а после ответа сохраняет фактические
токены и стоимость.

## Граница первой версии

В ledger входят только метрируемые вызовы:

- Anthropic API помощника Bot и CC;
- Anthropic API генератора документов;
- платный OpenAI-совместимый HTTP-путь Agents;
- платный HTTP-путь embeddings Agents.

Только Claude Agent SDK с явным OAuth, пустыми setting sources,
минимальным child env и доказанным `extra_usage.is_enabled=false`
проходит мимо ledger. До real prompt synthetic `shouldQuery=false` открывает
control channel; код проверяет `accountInfo`, `system/init` и структурный
`usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET()`. `true`, `null`,
недоступные rate limits или изменённая форма ответа блокируют prompt.
Платные usage credits биллятся по API-тарифам; поэтому raw Claude CLI,
Codex CLI и Gemini CLI fail-closed отключены: их preflight не даёт нужного
машиночитаемого доказательства до model dispatch.
Явно локальные модели тоже не уменьшают лимит; неизвестный режим/цена
закрывают вызов.

## Денежный протокол

```text
потребитель                         Core                         провайдер
     | reserve(requestKey, token ceilings) |                       |
     |---------------------------->| advisory lock + SUM     |
     |        allow + id           |                          |
     |<----------------------------|                          |
     |------------------------------- provider request ----->|
     |<------------------------------ response + usage ------|
     | settle(id, usage/outcome)    |                          |
     |---------------------------->|                          |
```

1. `requestKey` идемпотентен. Повтор открытого reserve возвращает ту же строку,
   но потребитель **не повторяет provider dispatch**: готовый ответ ledger не
   хранит. Закрытый ключ и тот же ключ с другим payload возвращаются как
   `replayBlocked`, а не как временная транспортная ошибка.
2. Core берёт транзакционный advisory-lock на сутки `Asia/Tashkent`, считает
   settled и in-flight exposure и сравнивает сумму **с новым резервом**.
3. Глобальный лимит `LLM_GLOBAL_DAILY_BUDGET_USD` (с переходным fallback на
   `AGENT_GLOBAL_BUDGET_USD`) и лимит агента берутся только из Core. Клиент не
   сообщает, сколько ему разрешено потратить.
4. `settle` идемпотентен. Фактическая стоимость может быть выше резерва: деньги
   уже потрачены, поэтому ledger обязан это честно записать.
5. Ошибка после отправки запроса переводит резерв в `failed`; для `unknown`
   exposure равен `max(reserved_usd, actual_usd)`. Частичный usage сохраняется
   как lower bound, но не освобождает резерв. Сбой клиента до
   отправки разрешает `release`.
6. Незавершённый `reserved` не истекает внутри суток. Это сознательный
   fail-closed выбор: падение процесса не должно освобождать деньги для второго
   вызова. На следующих ташкентских сутках запись перестаёт входить в дневную
   сумму.

## Таблицы

`llm_model_price` — версионируемый серверный каталог цен:

- `provider`, каноническая модель и вид расчёта (`tokens | provider_reported`);
- input/output/cache-read и отдельные cache-write 5m/1h rates за MTok;
- фиксированная цена и верхняя граница для provider-reported вызовов;
- интервал действия цены и дата создания записи.

Клиент не передаёт цену или billing mode. При резервировании Core выбирает
действующую строку и сохраняет её snapshot в расходе. Поэтому смена тарифа не
пересчитывает историю, а неизвестная модель закрывается fail-closed.

`llm_spend` хранит одну попытку провайдера:

- идентификаторы: `id`, уникальный `request_key`, `day`;
- происхождение: `consumer`, `feature`, `agent_name`, `provider`, `model`;
- жизненный цикл: `reserved | settled | failed | released | denied`;
- деньги: `reserved_usd`, `actual_usd` с точностью до 1e-9 USD;
- usage: input/output/cache aggregate + 5m/1h breakdown, code-execution requests
  для аудита и id ответа провайдера;
- `metadata`, причина ошибки, timestamps.

Exposure строки:

- `reserved` → `reserved_usd`;
- `settled` → `actual_usd`;
- `failed/unknown` → `max(reserved_usd, actual_usd)`; другой `failed` → факт или резерв;
- `released`/`denied` → 0.

История хранит стабильный `agent_id` и snapshot имени: архивирование меняет имя,
но не id, а финансовый след и прежняя подпись должны оставаться неизменными.

## Оценка цены

Для Anthropic тариф хранит input/output, cache read, cache write 5m и 1h.
Резерв считает все input-токены по максимуму этих четырёх input/cache
rates. Settlement использует 5m/1h breakdown; если его нет, aggregate
считается по максимальной cache-write rate. Если присутствуют обе формы,
aggregate обязан равняться сумме 5m+1h. SDK-retry выключен: одна запись
равна одной HTTP-попытке. Неизвестная модель не вызывается.

Для Documents Core добавляет к клиентскому ceiling свой overhead 128 000
input-токенов. Reserve и успешный settlement добавляют ровно один
5-minute container minimum на Messages request, а не на каждый
`code_execution_requests`. Server-owned metadata фиксирует `exact=false`,
`basis=container_5m_minimum`, `monthlyFreePoolApplied=false` и версию политики;
клиент не может это переопределить.
Это lower bound, а не верхняя оценка: точная длительность контейнера и
состояние monthly free pool в ответе недоступны.

OpenAI-совместимый шлюз обязан вернуть usage и фактическую model. Для
token-тарифа `usage.cost` не заменяет server snapshot. Missing/mismatched model
атомарно закрывает строку `failed/unknown`, пишет max из reported/catalog
lower bounds и открывает provider circuit до конца ташкентских суток.
Следующие reserve этого provider отклоняются до ручной сверки/новых суток.
`LLM_PRICE_PROVIDER_ID`/`EMBED_PRICE_PROVIDER_ID` — исчерпывающий routing contract:
в каталоге обязаны быть все active SKU, куда gateway может направить запрос.
Для Agents/embeddings reserve берёт максимальную стоимость всех этих SKU,
но settlement snapshot остаётся snapshot запрошенной модели.

Первая версия намеренно не даёт HTTP-admin для прайса. Новая цена попадает в
`llm_model_price` миграцией: действующая строка закрывается через `valid_to`, а
новая вставляется отдельно. Редактировать прошлую строку нельзя — reservation
всё равно хранит snapshot, а каталог должен оставаться аудируемым.

## Поведение при отказе

Core возвращает действие карточки агента (`pause | downgrade | ask`) вместе с
причиной, но первая версия исполняет безопасный общий результат: провайдер не
вызывается. `downgrade` не изображает переключение модели, пока для цепочки не
описаны проверяемые цены.

Ошибки `budget_denied`, `ledger_unavailable` и `replay_blocked` типизированы.
Они не должны:

- запускать платный API-fallback после отказа подписочного пути;
- превращаться в `no_signal` и закрывать задачу агента как выполненную;
- маскироваться сообщением о сбое Core после уже оплаченного ответа.

Если провайдер уже вернул полезный ответ, а `settle` не дошёл до Core,
Assistant, Documents, Agents chat и embeddings не выбрасывают уже оплаченный
результат. Незакрытый reserve остаётся exposure и защищает лимит; сбой пишется
в лог.

Следующая bounded-фаза добавила общий transport retry закрывающих операций:
`settle`, `fail` и `release` повторяют тот же URL и byte-identical JSON только
при неоднозначном/временном транспортном исходе (`network/timeout`, ошибка
чтения ответа, HTTP `408/425/429/5xx`). Число попыток и backoff ограничены, а
каждая попытка получает новый timeout. Валидный `Retry-After` учитывается, но
также ограничен верхней границей ожидания. Обычные `4xx`, включая конфликт
`409`, не повторяются. `reserve` по-прежнему имеет ровно одну transport-попытку:
скрытый retry после потерянного ответа мог бы разрешить вызывающему повторный
provider dispatch, которого ledger v1 доказать не умеет.

Это предотвращает большинство новых transient-зависаний. Bounded retry
остаётся быстрым первым контуром, а переживающий рестарт durable-контур
описан ниже.

## Durable settlement outbox legacy-потребителей

Bot, CC и cron-пути Agents закрывают ledger через producer-side
single-host spool. Это не транзакционный outbox Core: точное знание о
provider result сначала возникает в процессе-потребителе, поэтому
сетевой endpoint сам по себе не мог закрыть crash-window.

Жизненный цикл одной legacy-попытки:

1. **Pre-reserve.** До одной HTTP-попытки `reserve` producer создаёт
   durable-запись на основе `requestKey`. `reserve` по-прежнему никогда не
   повторяется скрыто.
2. **Fallback после reserve.** Получив reservation id, producer атомарно
   заменяет запись на консервативный `fail(outcome=unknown)`. Provider
   dispatch запрещён, пока этот fallback не зафиксирован успешным
   `fsync`. После crash такая запись не освобождает деньги, а закрывает
   reservation как неизвестный исход.
3. **Exact перед close.** Когда provider вернул usage/ошибку или клиент
   доказал, что dispatch не начинался, producer сначала заменяет fallback
   на exact `settle`, `fail` или `release`, и только потом зовёт Core.
4. **Атомарная запись.** Каждая смена состояния пишется во временный
   файл в той же файловой системе, делает `fsync` файла, `rename` и `fsync`
   каталога. Только успешный конечный `fsync` образует durable-границу.
5. **Доставка.** Быстрый путь сразу пытается закрыть Core тем же exact
   payload. После потери ответа запись удаляется только после exact replay,
   подтверждённого Core.

Каждый producer пишет в свой persistent-каталог; общий drainer обходит все
каталоги независимо от `AGENTS_SCHEDULES_PAUSED` и `AGENTS_TASKS_PAUSED`.
Пауза новых работ не может превратить уже потраченные деньги в вечный
pending. Service token, provider credentials, prompt и output в spool не пишутся.

Состояния доставки типизированы: `pending`, `retrying`, `processing`,
`dead`. Network/timeout, `408/425/429/5xx` повторяются с bounded backoff;
неисправимый payload, превышение общего потолка попыток и exact-conflict
становятся `dead`, а не hot-loop. Мониторинг агрегирует pending/retrying/
processing/dead, fallback/exact, старейшую запись и следующий retry;
reservation id и payload в UI не возвращаются. Недоступный spool показывается
как «не проверен», а не как нуль.

Это at-least-once exact delivery, а не exactly-once claim: два drainer могут
одновременно повторить один close. Безопасность даёт exact-idempotency Core,
а не недоказанная локальная блокировка.

## Durable execution задач агента

Lease worker и денежная попытка — разные сущности:

- `agent_run_id` и `agent_run_generation` меняются при stale takeover и служат
  CAS-владением;
- `agent_execution_attempt_id` переживает takeover и входит в request key
  `task:<taskId>:execution:<attemptId>:attempt:<N>`;
- `agent_execution_retry_at` откладывает доказанно безопасный pre-provider
  `budget_denied` до следующей полуночи `Asia/Tashkent`;
- `agent_execution_blocked_at/reason` останавливают `replay_blocked` или denial,
  перед которым уже была другая начатая metered-попытка.

Так stale worker не может ни закрыть чужую generation, ни получить новый
request key и второй раз вызвать платного провайдера. Обычная недоступность
reserve сохраняет тот же attempt: если Core успел создать строку, следующий
проход увидит replay и переведёт задачу в block; если не успел — безопасно
продолжит ту же попытку.

Снять block можно только явным `POST /tasks/:id/agent-run/retry`. Маршрут требует
сразу общий `x-service-token` и отдельный `x-owner-action-token`. Значение
`OWNER_ACTION_TOKEN` передаётся только Core, не Bot/Agents/CC; actor из тела
запроса не принимается. Retry очищает старый execution id, пишет audit-log и
тем самым явно разрешает потенциально повторную оплату.

## Явные границы первой версии

- Ledger гарантирует monetary at-most-once для metered попытки, но не хранит
  provider output. Автоматически повторить закрытый/replayed вызов нельзя.
- Durable-гарантия начинается только после успешного `fsync`. Если процесс
  погиб между provider response и exact-записью, точные usage/cost могут
  потеряться; прежний durable fallback закроет резерв как `unknown`.
- Settlement spool хранит только финансовое закрытие. Оплаченный текст,
  файл, вектор и доставка артефакта им не восстанавливаются.
- Spool охватывает только legacy Bot/CC/Agents. Durable task-mode Agents
  закрывает spend в своей Core-транзакции и в эту очередь не попадает.
- Persistent volume переживает restart/recreate на одном production-host, но не
  является HA-репликацией и не переезжает на standby сам.
- Subscription/local пути сознательно не входят в USD-ledger. Их повтор после
  crash/takeover может потратить квоту подписки или повторить side effect.
- Нет durable result/artifact outbox: сбой Telegram/скачивания после успешного
  settlement может оставить оплаченную генерацию без доставки. Нужен отдельный
  response/artifact outbox.
- Lease-проверка перед side effects не атомарна с `approval`, event, memory или
  внешним Notion. Для exactly-once эффектов нужен task-scoped effect ledger /
  transactional outbox; внешний Notion всё равно требует provider intent.
- Для Documents 5-minute container charge — только известный lower bound.
  Реальная длительность и остаток месячного free pool отсутствуют в ответе,
  поэтому абсолютный hard cap на эту ancillary charge в v1 недоказуем.
- Max-route reserve защищает только исчерпывающий каталог `provider`. Новый SKU,
  на который gateway умеет маршрутизировать, обязан появиться в каталоге до
  включения маршрута.
- HTTP-admin для изменения прайса отсутствует. Прайс версионируется миграциями,
  прошлые строки не редактируются.

## Приёмка

- два конкурентных резерва, каждый из которых отдельно помещается в остаток,
  вместе не проходят;
- повтор `requestKey` не удваивает exposure;
- in-flight и неизвестный failed учитываются в потолке;
- release освобождает резерв, settle заменяет его фактом;
- граница суток считается в `Asia/Tashkent`;
- при отказе ledger провайдерский fake не получает ни одного вызова;
- Bot, CC, Documents, Agents chat и embeddings используют один Core API.
- `settle/fail/release` exact-retry после неоднозначного transport-сбоя, но
  `reserve` никогда не получает скрытую вторую попытку;
- без успешного durable fallback `fsync` provider не вызывается;
- exact close переживает process restart и удаляется только после
  подтверждённого Core replay;
- drainer доставляет очередь при любой комбинации пауз расписаний/задач;
- monitoring отличает пустую очередь от недоступного spool и не возвращает
  id/payload;
- closed replay и payload mismatch блокируют execution, а не hot-loop;
- снять block нельзя одним общим `SERVICE_TOKEN`;
- task lease takeover сохраняет execution attempt и не даёт второй metered
  dispatch.

## Источники тарифа

- [Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing)
- [Anthropic prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)
- [Anthropic code execution tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/code-execution-tool)
- [Anthropic usage credits for paid Claude plans](https://support.claude.com/en/articles/12429409-manage-usage-credits-for-paid-claude-plans)
