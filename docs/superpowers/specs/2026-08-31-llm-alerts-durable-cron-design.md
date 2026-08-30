# LLM operational alerts and durable scheduled provider jobs

Date: 2026-08-31
Status: implementation design

## Goal

MYDON must proactively notify the owner in Telegram when an LLM outcome is
ambiguous or dead, a reservation is stuck, a provider circuit is open, or the
daily exposure reaches 80% of the configured global cap. Scheduled metered LLM
work must use the same durable provider-job protocol as assigned agent tasks.

## Non-goals

- Telegram alerts never call an LLM.
- This change does not move non-LLM collectors (OurVend, coffee, maintenance,
  Globerent, FX) into provider jobs.
- The first slice does not backfill cron ticks missed while the Agents process
  was completely offline. Durability starts when the occurrence task is
  materialized; pending occurrences are then recovered by polling.
- `assess-ideas` remains unscheduled until its bounded dynamic memory-write
  workflow is designed. The active scheduled metered flow is `coach-review`.

## Alert flow

```text
Core monitor (every minute, Asia/Tashkent)
  -> idempotent event.client_key
  -> RulesService immediate rule
  -> Bot Notifier
  -> owner Telegram
  -> notification_delivery ack after successful send
```

The monitor covers:

- `llm_spend(status=failed,outcome=unknown)`;
- `agent_task_llm_job(status=unknown)`;
- `outbox_delivery(status=unknown|dead)`;
- settlement-spool fallback older than the stuck threshold and any dead file;
- reservations older than five minutes;
- current-day provider circuits;
- `globalExposureUsd / globalCapUsd >= 0.8` when the cap is valid and positive.

Incident identity is stable and secret-free. Database incidents use row UUIDs
only inside a SHA-256 event key; Telegram payloads contain counts, provider,
model, destination, timestamps and USD totals, never request bodies, provider
errors, tokens, filesystem paths, reservation IDs or credentials. Settlement
spool monitoring exposes only hashes of safe file identity metadata.

Precedence prevents duplicate noise:

1. an unknown task job owns its linked spend, so the spend is not also reported
   as a stuck reservation;
2. a spend that opened a circuit is represented by the circuit incident, not a
   second generic unknown incident;
3. budget is notified at most once per Tashkent day;
4. the event unique key resolves races between Core replicas.

Resolvable aggregate incidents (stuck reservations, spool fallback, circuit,
budget) emit one recovery event when healthy again. Immutable unknown/dead rows
remain open until a future explicit reconciliation path changes their state.

Bot startup uses a bounded seven-day lookback. Core-side
`notification_delivery` remains the source of truth, so already delivered
events do not repeat while events created during Bot downtime are recovered.

## Durable cron flow

```text
Croner planned fire time
  -> POST /tasks/agent-schedule/ensure
  -> task(source=agent-schedule, stable clientKey)
  -> scheduled queue poll/claim
  -> task_agent_execution
  -> agent_task_llm_job + authorization + immutable result
  -> checkpoint + atomic commit + delivery outbox
```

Occurrence identity is server-derived from version, agent name, skill, exact
cron expression and planned UTC fire time:

```text
agent-schedule:v1:<sha256(canonical occurrence)>
```

Core validates that agent and skill are paired, stores a title containing the
exact skill, and treats a different payload under the same key as a conflict.
Two replicas therefore produce one task, one execution attempt and at most one
physical provider dispatch. A crash after materialization is recovered by the
scheduled queue poller using the existing lease/takeover protocol.

System occurrences are excluded from the default Tasks list and workload, but
remain queryable as `agentInvocation=scheduled` for audit and owner recovery.

## Independent pauses

- `AGENTS_TASKS_PAUSED` gates only assigned/UI tasks.
- `AGENTS_SCHEDULES_PAUSED` gates cron materialization and claiming of scheduled
  occurrence tasks.
- Work already claimed before a pause may finish; a pause is an admission gate,
  not cancellation.
- Settlement and delivery outboxes drain under both pauses.

The cron callback no longer calls `runSkill` for metered scheduled skills. A
fail-closed guard rejects any future direct metered cron path so it cannot fall
back to the legacy ledger that stores money but not the reusable provider
result.

## Failure semantics

- A lost dispatch response becomes `unknown` and is never redispatched.
- A budget denial keeps the same occurrence/execution and may obtain the next
  day's authorization according to the existing task policy.
- A changed task input, workflow plan or occurrence identity blocks replay.
- Alert delivery is at-least-once until Core records the Telegram ack.
- Alert evaluation failures are logged and retried on the next protected tick;
  they never affect LLM admission or application health.

## Rollout

Old and new scheduled paths use different request identities and must not be
active together. Production rollout therefore pauses schedules, replaces the
Agents container, verifies that no legacy scheduled attempt is in flight, then
unpauses schedules. Assigned tasks may remain paused throughout this cutover.

Required verification includes exact 80% boundary, invalid/zero cap, duplicate
Core/Agents replicas, Bot restart catch-up, alert ack retry, pause cross-product,
crash/replay after durable result, and proof that an unknown job never becomes
dispatchable again.
