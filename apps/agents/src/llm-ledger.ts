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
  const key = `${baseUrl}\0${serviceToken}`;
  if (cached?.key !== key) cached = { key, ledger: create(baseUrl, serviceToken) };
  return cached.ledger;
}

/** Только явное `local` делает HTTP-вызов бесплатным. */
export function httpBillingMode(raw: string | undefined): "metered" | "local" {
  return (raw ?? "").trim().toLowerCase() === "local" ? "local" : "metered";
}
