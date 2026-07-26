export interface CheckResult {
  ok: boolean;
  status?: number;
  ms: number;
  reason?: string;
}

/** Одна проверка доступности. Таймаут обязателен: зависший запрос — тоже отказ. */
export async function checkOnce(url: string, timeoutMs = 10_000): Promise<CheckResult> {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    const ms = Date.now() - started;
    if (!res.ok) return { ok: false, status: res.status, ms, reason: `HTTP ${res.status}` };
    return { ok: true, status: res.status, ms };
  } catch (err) {
    return {
      ok: false,
      ms: Date.now() - started,
      reason: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

export type WatchdogAction = "none" | "alert_down" | "alert_recovered";

/**
 * Состояние сторожа.
 *
 * Тревога поднимается только после нескольких неудач подряд — одиночный
 * сетевой сбой не должен будить владельца ночью. Повторная тревога о том же
 * простое не шлётся: сообщаем один раз о падении и один раз о восстановлении.
 */
export class WatchdogState {
  private consecutiveFailures = 0;
  private alerted = false;

  constructor(private readonly failuresToAlert = 3) {}

  apply(ok: boolean): WatchdogAction {
    if (ok) {
      const wasAlerted = this.alerted;
      this.consecutiveFailures = 0;
      this.alerted = false;
      return wasAlerted ? "alert_recovered" : "none";
    }

    this.consecutiveFailures += 1;
    if (!this.alerted && this.consecutiveFailures >= this.failuresToAlert) {
      this.alerted = true;
      return "alert_down";
    }
    return "none";
  }

  get failures(): number {
    return this.consecutiveFailures;
  }

  get isAlerted(): boolean {
    return this.alerted;
  }
}
