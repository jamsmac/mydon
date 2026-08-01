/**
 * Состояние многошагового диалога сотрудника (визард).
 *
 * Обобщение `AwaitingReport`: тот помнил только «жду один отчёт», а визард
 * ведёт сотрудника шагами (тип → имя → фото → единица) и копит введённое.
 * В памяти процесса с TTL: бот одноэкземплярный, а брошенный на полпути визард
 * должен сам протухнуть, а не висеть вечно. Переживать перезапуск не обязан —
 * сотрудник начнёт заново (тот же размен, что и у AwaitingReport).
 */

/** Один активный визард сотрудника. */
export interface Conversation {
  /** Какой поток: "register" (заведение) | "inventory" (инвентаризация). */
  flow: string;
  /** Текущий шаг потока. */
  step: string;
  /** Накопленные значения. */
  data: Record<string, unknown>;
  /** Когда обновлён — для протухания. */
  at: number;
}

export class Conversations {
  private readonly map = new Map<number, Conversation>();

  constructor(private readonly ttlMs = 15 * 60_000) {}

  /** Начать визард (перетирает прежний — новый разговор важнее брошенного). */
  start(chatId: number, flow: string, step: string, data: Record<string, unknown> = {}, now = Date.now()): void {
    this.map.set(chatId, { flow, step, data, at: now });
  }

  /** Текущий визард, если жив. Протухший — убираем и возвращаем null. */
  get(chatId: number, now = Date.now()): Conversation | null {
    const c = this.map.get(chatId);
    if (c === undefined) return null;
    if (now - c.at > this.ttlMs) {
      this.map.delete(chatId);
      return null;
    }
    return c;
  }

  /** Перейти на шаг, дописав данные. Обновляет отметку времени. */
  advance(chatId: number, step: string, patch: Record<string, unknown> = {}, now = Date.now()): Conversation | null {
    const c = this.get(chatId, now);
    if (c === null) return null;
    c.step = step;
    c.data = { ...c.data, ...patch };
    c.at = now;
    return c;
  }

  /** Завершить визард. */
  clear(chatId: number): void {
    this.map.delete(chatId);
  }

  /** Убрать протухшие — зовём по таймеру, как sweep у AwaitingReport. */
  sweep(now = Date.now()): void {
    for (const [chatId, c] of this.map) {
      if (now - c.at > this.ttlMs) this.map.delete(chatId);
    }
  }
}
