import {
  DurableLlmLedger,
  FileLlmSettlementOutbox,
  drainLlmSettlementOutbox,
  type LlmSettlementOutboxDrainResult,
} from "@mydon/llm-ledger-outbox";
import { CoreLlmLedgerClient, type LlmLedger } from "@mydon/shared";

/**
 * Ledger живёт в Core, а не в процессе агентов.
 *
 * Создаём HTTP-адаптер лениво: первый вызов из навыка происходит
 * уже после system-config overlay, поэтому клиент видит актуальные CORE_API_URL
 * и SERVICE_TOKEN. Если они изменятся, кэш сам пересоздастся.
 */
let cached: { key: string; ledger: LlmLedger } | null = null;

export function llmLedgerFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  create: (baseUrl: string, serviceToken: string) => LlmLedger = (baseUrl, serviceToken) =>
    new CoreLlmLedgerClient({ baseUrl, serviceToken }),
): LlmLedger {
  const baseUrl = (env.CORE_API_URL ?? "http://127.0.0.1:3001").trim().replace(/\/$/, "");
  const serviceToken = env.SERVICE_TOKEN ?? "";
  const outboxRoot = (env.LLM_LEDGER_OUTBOX_ROOT ?? "").trim();
  const key = `${baseUrl}\0${serviceToken}\0${outboxRoot}`;
  if (cached?.key !== key) {
    cached = {
      key,
      ledger: new DurableLlmLedger(
        create(baseUrl, serviceToken),
        new FileLlmSettlementOutbox({ rootDir: outboxRoot, producer: "agents" }),
      ),
    };
  }
  return cached.ledger;
}

/** Delivery уже совершённого accounting intent не зависит от агентских пауз. */
export async function drainLlmSettlementOutboxFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): Promise<LlmSettlementOutboxDrainResult | null> {
  const rootDir = (env.LLM_LEDGER_OUTBOX_ROOT ?? "").trim();
  if (rootDir === "") return null;
  const ledger = new CoreLlmLedgerClient({
    baseUrl: (env.CORE_API_URL ?? "http://127.0.0.1:3001").trim().replace(/\/$/, ""),
    serviceToken: env.SERVICE_TOKEN ?? "",
  });
  return drainLlmSettlementOutbox({ rootDir, ledger });
}

/** Только явное `local` делает HTTP-вызов бесплатным. */
export function httpBillingMode(raw: string | undefined): "metered" | "local" {
  return (raw ?? "").trim().toLowerCase() === "local" ? "local" : "metered";
}
