import type { CoffeeFillStatusRow, CoffeeReconcileGroup } from "./core-client";

/**
 * monitor-coffee-bunkers — проактивный мониторинг кофе-бункеров.
 *
 * Порт `monitor-stock` донора mydon-agent-os (агент vendhub-ops) под уже
 * готовые расчёты Core: недолив заливки (`fillStatusByLocation`, задача 47) и
 * расхождение факт/ожидание расхода (`reconcileAllLocations`, задача 49).
 * Монитор ничего не решает сам — он читает уже посчитанное и эмитит событие
 * на каждый непорядок; какой сигнал будить владельца немедленно, а какой
 * копить до брифинга, решают правила `rules.ts` (те же две тревоги — недолив
 * и расхождение — там разнесены по порогу, как `infra.disk`/`infra.disk.watch`).
 *
 * Тир: T0 (чистое наблюдение). Никаких заявок/закупок здесь не создаётся —
 * это T1-действие и остаётся за человеком (см. docstring monitor-stock донора).
 *
 * "Нет данных" ≠ "ok": `fillStatusByLocation`/`reconcileAllLocations` уже
 * возвращают `status: "unknown"`, когда эталона/данных нет — монитор такие
 * строки просто пропускает (не сигнал, не тишина как норма).
 */

/** Узкий контракт Core-клиента, который нужен монитору (упрощает тесты). */
export interface CoffeeMonitorCoreClient {
  coffeeFillStatus(): Promise<CoffeeFillStatusRow[]>;
  coffeeReconcileAll(from: string, to: string): Promise<CoffeeReconcileGroup[]>;
  recordEvent(input: { source: string; type: string; payload?: Record<string, unknown> }): Promise<unknown>;
}

/** Окно сверки расхода, суток — совпадает с ежедневным циклом бункеров. */
const RECONCILE_WINDOW_DAYS = 3;

export interface CoffeeMonitorResult {
  underfillEvents: number;
  anomalyEvents: number;
  /** Что не удалось прочитать — второй источник всё равно проверяется (см. docstring). */
  errors: string[];
}

export interface RunOptions {
  /** Источник времени (для тестов). */
  now?: () => Date;
}

/** YYYY-MM-DD по Ташкенту. */
function isoDate(d: Date): string {
  return d.toLocaleDateString("sv-SE", { timeZone: "Asia/Tashkent" });
}

/**
 * Один проход мониторинга: читает недолив и сверку, эмитит по событию на
 * каждую проблемную строку. Частичный сбой одного источника не должен
 * скрывать сигналы другого — оба читаются независимо друг от друга.
 */
export async function runCoffeeMonitor(
  core: CoffeeMonitorCoreClient,
  opts: RunOptions = {},
): Promise<CoffeeMonitorResult> {
  const now = opts.now ?? (() => new Date());
  const nowDate = now();
  const to = isoDate(nowDate);
  const from = isoDate(new Date(nowDate.getTime() - RECONCILE_WINDOW_DAYS * 86_400_000));

  const errors: string[] = [];

  let underfillEvents = 0;
  try {
    const fillStatus = await core.coffeeFillStatus();
    for (const row of fillStatus) {
      if (row.status !== "underfill") continue;
      await core.recordEvent({
        source: "coffee-monitor",
        type: "coffee.underfill",
        payload: {
          location: row.locationName,
          position: row.position,
          ingredient: row.ingredientName,
          netFillWeight: row.netFillWeight,
          targetFillWeight: row.targetFillWeight,
          fillRatio: row.fillRatio,
        },
      });
      underfillEvents += 1;
    }
  } catch (err) {
    errors.push(`недолив: ${errText(err)}`);
  }

  let anomalyEvents = 0;
  try {
    const groups = await core.coffeeReconcileAll(from, to);
    for (const g of groups) {
      for (const row of g.rows) {
        if (row.reconcile.status !== "anomaly") continue;
        await core.recordEvent({
          source: "coffee-monitor",
          type: "coffee.anomaly",
          payload: {
            location: g.locationName,
            ingredient: row.ingredientName,
            actualGrams: row.actualGrams,
            expectedGrams: row.expectedGrams,
            deltaRatio: row.reconcile.deltaRatio,
          },
        });
        anomalyEvents += 1;
      }
    }
  } catch (err) {
    errors.push(`сверка расхода: ${errText(err)}`);
  }

  return { underfillEvents, anomalyEvents, errors };
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
