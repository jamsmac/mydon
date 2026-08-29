import { NotionError, notion, type NotionReport } from "@mydon/connectors";

export interface ClaimedOutboxDelivery {
  id: string;
  key: string;
  destination: string;
  payload: unknown;
  leaseToken: string;
}

export interface AgentOutboxClient {
  claimOutbox(destination: string, workerRef: string): Promise<ClaimedOutboxDelivery | null>;
  completeOutbox(
    id: string,
    leaseToken: string,
    status: "sent" | "skipped" | "unknown" | "dead",
    options?: { providerRef?: string; error?: string },
  ): Promise<unknown>;
}

export interface OutboxDrainResult {
  claimed: number;
  sent: number;
  skipped: number;
  unknown: number;
  dead: number;
}

const DEFAULT_RATE_LIMIT_RETRIES = 2;
const DEFAULT_RATE_LIMIT_DELAY_MS = 1_000;
const MAX_RATE_LIMIT_DELAY_MS = 30_000;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function rateLimitDelay(error: NotionError, retryIndex: number, baseDelayMs: number): number {
  const requested = error.retryAfterMs;
  const fallback = baseDelayMs * 2 ** retryIndex;
  return Math.min(Math.max(requested ?? fallback, 0), MAX_RATE_LIMIT_DELAY_MS);
}

function isDeterministicClientError(error: unknown): error is NotionError {
  // Notion documents 409 as a transient data conflict and asks clients to
  // retry. Retrying a create is too risky for our at-most-once policy, but
  // marking it dead would also pretend the delivery can never recover.
  // Only the explicitly deterministic request/auth/access/not-found statuses
  // are terminal; every other HTTP shape falls through to visible `unknown`.
  return error instanceof NotionError && [400, 401, 403, 404].includes(error.status ?? 0);
}

/**
 * Доставляет уже закоммиченные task reports.
 *
 * Core помечает intent dispatching до возврата claim. Поэтому после
 * неопределённой сетевой ошибки мы только фиксируем unknown и никогда не
 * создаём страницу повторно автоматически.
 */
export async function drainNotionOutbox(
  core: AgentOutboxClient,
  options: {
    env?: NodeJS.ProcessEnv;
    workerRef?: string;
    limit?: number;
    publish?: typeof notion.publish;
    /** Test seam; production uses a real timer while retaining the same outbox lease. */
    sleep?: (ms: number) => Promise<void>;
    maxRateLimitRetries?: number;
    rateLimitBaseDelayMs?: number;
  } = {},
): Promise<OutboxDrainResult> {
  const result: OutboxDrainResult = { claimed: 0, sent: 0, skipped: 0, unknown: 0, dead: 0 };
  const config = notion.fromEnv(options.env ?? process.env);
  const workerRef = options.workerRef ?? `agents:${process.pid}`;
  const limit = Math.min(Math.max(options.limit ?? 10, 1), 100);
  const publish = options.publish ?? notion.publish;
  const sleep = options.sleep ?? wait;
  const maxRateLimitRetries = Math.min(
    Math.max(Math.trunc(options.maxRateLimitRetries ?? DEFAULT_RATE_LIMIT_RETRIES), 0),
    5,
  );
  const rateLimitBaseDelayMs = Math.min(
    Math.max(Math.trunc(options.rateLimitBaseDelayMs ?? DEFAULT_RATE_LIMIT_DELAY_MS), 1),
    MAX_RATE_LIMIT_DELAY_MS,
  );

  for (let index = 0; index < limit; index += 1) {
    const delivery = await core.claimOutbox("notion-report", workerRef);
    if (delivery === null) break;
    result.claimed += 1;

    if (config === null) {
      await core.completeOutbox(delivery.id, delivery.leaseToken, "skipped", {
        error: "Notion не настроен",
      });
      result.skipped += 1;
      continue;
    }

    const report = parseNotionReport(delivery.payload);
    if (report === null) {
      await core.completeOutbox(delivery.id, delivery.leaseToken, "dead", {
        error: "outbox payload не соответствует NotionReport",
      });
      result.dead += 1;
      continue;
    }

    let rateLimitRetries = 0;
    while (true) {
      try {
        const published = await publish(report, config);
        await core.completeOutbox(delivery.id, delivery.leaseToken, "sent", {
          providerRef: published.id,
        });
        result.sent += 1;
        break;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (
          error instanceof NotionError &&
          error.status === 429 &&
          rateLimitRetries < maxRateLimitRetries
        ) {
          // A 429 explicitly means this request was rejected. Retrying under
          // the same dispatching claim is safe: no second worker can claim the
          // intent, and the bounded delay remains far below Core's stale fence.
          const delayMs = rateLimitDelay(error, rateLimitRetries, rateLimitBaseDelayMs);
          rateLimitRetries += 1;
          await sleep(delayMs);
          continue;
        }

        if (
          isDeterministicClientError(error) ||
          (error instanceof NotionError && error.status === 429)
        ) {
          // Every attempt got an explicit 4xx rejection, so Notion did not
          // create a page. Bounded 429 retries exhausted: operator action is
          // preferable to turning the row pending and starting a blind loop.
          await core.completeOutbox(delivery.id, delivery.leaseToken, "dead", {
            error:
              error instanceof NotionError && error.status === 429
                ? `${message}; rate-limit retry exhausted after ${rateLimitRetries + 1} attempts`
                : message,
          });
          result.dead += 1;
        } else {
          // 5xx, timeout and network failures do not prove whether create was
          // accepted. Terminal unknown prevents any automatic provider retry.
          await core.completeOutbox(delivery.id, delivery.leaseToken, "unknown", {
            error: message,
          });
          result.unknown += 1;
        }
        break;
      }
    }
  }

  return result;
}

function parseNotionReport(value: unknown): NotionReport | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const report = (value as Record<string, unknown>).report;
  if (report === null || typeof report !== "object" || Array.isArray(report)) return null;
  const raw = report as Record<string, unknown>;
  if (
    typeof raw.title !== "string" ||
    raw.title.trim() === "" ||
    typeof raw.author !== "string" ||
    raw.author.trim() === "" ||
    !Array.isArray(raw.blocks)
  ) {
    return null;
  }
  const blocks: NotionReport["blocks"] = [];
  for (const value of raw.blocks) {
    const block = parseNotionBlock(value);
    if (block === null) return null;
    blocks.push(block);
  }
  return { title: raw.title, author: raw.author, blocks };
}

function parseNotionBlock(value: unknown): NotionReport["blocks"][number] | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (raw.heading !== undefined && typeof raw.heading !== "string") return null;
  if (
    raw.paragraphs !== undefined &&
    (!Array.isArray(raw.paragraphs) ||
      !raw.paragraphs.every((paragraph) => typeof paragraph === "string"))
  ) {
    return null;
  }
  if (
    raw.bullets !== undefined &&
    (!Array.isArray(raw.bullets) || !raw.bullets.every((bullet) => typeof bullet === "string"))
  ) {
    return null;
  }
  return {
    ...(typeof raw.heading === "string" ? { heading: raw.heading } : {}),
    ...(Array.isArray(raw.paragraphs) ? { paragraphs: raw.paragraphs as string[] } : {}),
    ...(Array.isArray(raw.bullets) ? { bullets: raw.bullets as string[] } : {}),
  };
}
