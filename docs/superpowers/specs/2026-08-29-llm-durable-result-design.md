# Durable provider jobs и результаты task-mode LLM

Дата: 2026-08-29
Статус: утверждённый bounded design для v3

## Цель и честная гарантия

Эта фаза закрывает окно `provider response -> task checkpoint` для порученных
агентам задач. Core выдаёт не более одного application-level dispatch grant на
одну физическую provider attempt, хранит принятый результат неизменяемо и
возвращает его следующей worker generation без повторного платного вызова.

Это не `exactly once`. Без idempotency/status API провайдера остаётся
неустранимое окно `dispatch grant -> wire -> durable complete`: запрос мог уйти,
а ответ мог не попасть в Core. Такой job становится `unknown` и никогда не
переходит обратно в состояние, из которого разрешён автоматический dispatch.

## Граница v3

Входит только task-mode Agents:

- metered OpenAI-compatible chat для `assess-ideas` и `coach-review`;
- metered OpenAI-compatible embeddings, которые вызываются этими workflows;
- resume после crash/takeover до существующего task checkpoint;
- атомарное сохранение результата и settlement его `llm_spend`.

Не входят cron, Bot, CC, Documents, local/subscription gateways, произвольные
executor effects и внешняя доставка артефактов. Они остаются следующими
вертикальными срезами.

## Корень execution до provider

`task_agent_execution` создаётся новым `POST /tasks/:id/agent-run/start` до
чтения/LLM и получает состояние `active`.

Execution фиксирует:

- `task_id`, неизменяемый `execution_attempt_id`, `agent_name`, `skill`;
- `task_input_hash`, рассчитанный Core из task snapshot на момент start;
- `workflow_version`, bounded `execution_plan` и его canonical SHA-256;
- `started_at`.

Plan содержит только versioned allowlist шагов и маршрутов: `stepKey`,
`chat|embedding`, feature, adapter/version, provider и ограниченную model chain.
Максимум 8 шагов, 3 model attempts на шаг и 100 млн token ceiling. Exact replay
start возвращает прежний execution; другой skill/input/plan под тем же attempt
получает `409`.

Каждый metered route дополнительно фиксирует secret-free `endpointProfile`:
`openai-chat-completions:sha256:<64 lowercase hex>` либо
`openai-embeddings:sha256:<64 lowercase hex>`. Hash считается Agents от
canonical effective HTTP(S) base URL; URL с credentials, query, fragment или
другой схемой отклоняется. Сам URL в plan/job/result не сохраняется. Если между
start и provider wire изменился endpoint, provider, adapter, billing mode или
тип gateway, worker отправляет `workflow_changed` и Core durable-блокирует
execution **до** внешнего вызова. Продолжение возможно только через явный owner
retry, который создаёт новый execution attempt с новым plan.

Переходы execution:

```text
absent -> active -> ready -> committed
             \-------> abandoned  (только owner retry)
                   ready -> abandoned (только owner retry)
```

В `active` checkpoint-поля nullable. Checkpoint атомарно проверяет неизменный
task input, terminal manifest всех job и переводит строку в `ready`; он больше
не вставляет execution впервые.

## Таблицы provider job

### `agent_task_llm_job`

Одна строка — одна физическая fallback attempt:

- FK `task_agent_execution_id` с `RESTRICT`;
- `step_key`, `provider_attempt_no`, `kind`, `feature`;
- `adapter`, `adapter_version`, `provider`, `model`, token ceilings;
- server-derived уникальный `job_key`;
- `operation_hash` — SHA-256 canonical operation envelope;
- nullable `request_payload` — точный provider JSON body без auth/secrets;
- nullable unique FK `spend_id`;
- state, dispatch token/run/timestamps, terminal reason/timestamps.

Уникальны `(execution, step_key, provider_attempt_no)` и `job_key`. Payload
ограничен по размеру, не попадает в `llm_spend.metadata` и логи и очищается
после terminal result. Core считает operation hash сам из:

```text
schema version + execution id + workflow version + step key + attempt no +
adapter/version + provider + endpoint profile + exact ordered provider body
```

### `agent_task_llm_authorization`

Budget denial не должен заставлять повторно платить за уже сохранённый ранний
шаг многошагового workflow. Поэтому job в `waiting_budget` может иметь по одной
authorization на ledger-day. Authorization хранит `job_id`, day, уникальный
`spend_id` и `denied|granted`. Новый день создаёт новый request key; первый
granted spend навсегда прикрепляется к job и переводит его в `ready`.

### `agent_task_llm_result`

Одна immutable строка на job: `success|provider_rejection`, typed bounded JSON
(chat text либо vector, normalized usage, provider request id, resolved model,
reported cost/error), `result_hash`, `received_at`. Exact replay completion
возвращает строку; другой hash получает `409` и audit incident.

## Job API и автомат

Все маршруты только `POST`, потому что GET в текущем Core намеренно читается
без service token.

1. `POST /tasks/:id/agent-run/start` — создаёт/resumes `active` execution.
2. `POST /tasks/:id/agent-run/llm-jobs/ensure` — под task/run fence проверяет
   plan, canonicalizes exact envelope, создаёт job и сегодняшнюю authorization.
   Job+reserve либо их exact replay происходят в одной DB transaction.
3. `POST /tasks/:id/agent-run/llm-jobs/:jobId/claim-dispatch` — CAS
   `ready -> dispatching`. Dispatch token генерирует Agents до вызова; lost HTTP
   response можно повторить тем же token и получить тот же grant/payload.
4. `POST /tasks/:id/agent-run/llm-jobs/:jobId/complete` — принимает только
   исходный dispatch token, но не требует актуальный run id. Это позволяет
   старой generation сохранить уже оплаченный late result, не позволяя ей
   checkpoint/commit effects. Result + ledger settlement + terminal job
   фиксируются одной Core transaction.

```text
absent -> waiting_budget -> ready -> dispatching -> succeeded
             |                         |          -> rejected
             |                         `--------> unknown
             `--(new ledger day)--> waiting_budget

ready -> cancelled
unknown -> succeeded | rejected   (только late evidence, тот же token)
```

`unknown` никогда не возвращается в `ready/dispatching`. Watchdog или takeover
может перевести просроченный/in-flight job в `unknown`; spend остаётся reserved
exposure до late result или ручной reconciliation. Fallback N+1 разрешён только
после durable `rejected` N. Timeout, fetch error, 5xx и невалидный 2xx считаются
ambiguous; allowlisted 4xx — definitive rejection.

## Resume и task checkpoint

Claim возвращает active execution/plan, даже если checkpoint ещё нет. Worker
запускает тот же versioned workflow через `TaskLlmSession`:

- `ensure` возвращает сохранённый result либо авторизованный job;
- dispatch выполняется ровно тем exact payload, который вернул Core;
- `complete` сохраняет результат до возврата его навыку;
- skill parsing остаётся детерминированным и затем создаёт checkpoint v2.

Checkpoint включает manifest всех job execution (`jobId`, step, status,
operationHash, resultHash), запрещает `waiting_budget|ready|dispatching|unknown`
и связывает итог навыка с уже durable provider results.

## Crash/race matrix

- До commit `ensure`: job/spend нет, retry безопасен.
- После job+reserve, до dispatch claim: takeover использует тот же ready job.
- Потерян ответ claim: тот же client token восстанавливает grant; другой token
  запрещён.
- После grant, до/после wire без complete: `unknown`, auto retry запрещён.
- После complete commit, до/после потерянного HTTP response: exact complete или
  ensure возвращает immutable result.
- После result, до task checkpoint: takeover повторно использует result.
- Task edit до start/ensure/checkpoint: hash mismatch блокирует применение.
- Route/config drift после start: ноль provider-вызовов, execution получает
  `workflow_changed`; owner retry начинает новый attempt с актуальным plan.
- Takeover во время provider: нового grant нет; старый token может сохранить
  result, но старый run не проходит checkpoint fence.
- Owner retry оставляет old execution/jobs/results для аудита; только
  undispatched ready job отменяется с release резерва.

## Приёмка

- concurrent ensure с одинаковым payload создаёт один job/spend, с другим —
  `409` и block;
- same/different claim token и lost-response path проверены;
- stale takeover не выдаёт второй grant, late complete сохраняется;
- result hash replay/mismatch проверены;
- `result + settlement` откатываются или коммитятся вместе;
- rejected разрешает следующий allowlisted attempt, unknown запрещает;
- denial после уже durable первого шага resumes второй шаг на новых сутках без
  повторного provider вызова первого;
- checkpoint невозможен при незавершённом/unknown job;
- миграция проходит на чистом PostgreSQL 17 и поверх `0076`.
