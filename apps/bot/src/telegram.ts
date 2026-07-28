/**
 * Транспорт Telegram Bot API на long polling.
 * Long polling выбран намеренно: не требует открытых портов наружу (ТЗ §6 —
 * доступ только через Tailscale, «ноль открытых портов»).
 * Без внешних зависимостей — только fetch.
 */

export interface TgUpdate {
  update_id: number;
  message?: {
    message_id: number;
    chat: { id: number };
    /** Кто написал: @username нужен, чтобы привязать сотрудника по «Старту». */
    from?: { id: number; username?: string };
    text?: string;
    voice?: { file_id: string };
  };
  callback_query?: {
    id: string;
    data?: string;
    message?: { chat: { id: number }; message_id: number; text?: string };
  };
}

export interface InlineKeyboard {
  inline_keyboard: { text: string; callback_data: string }[][];
}

/** Токен неверен или отозван. Повторять запросы бессмысленно. */
export class InvalidTokenError extends Error {
  readonly fatal = true;
}

export class TelegramApi {
  private offset = 0;

  constructor(
    private readonly token: string,
    private readonly timeoutSec = 30,
  ) {}

  private url(method: string): string {
    return `https://api.telegram.org/bot${this.token}/${method}`;
  }

  private async call<T>(method: string, body: unknown): Promise<T> {
    const res = await fetch(this.url(method), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    // 401/404 от Bot API означают одно: токен неверный или отозван.
    // Это не временный сбой — повторять бессмысленно, нужно сказать об этом прямо.
    if (res.status === 401 || res.status === 404) {
      throw new InvalidTokenError(
        `Telegram отклонил токен (HTTP ${res.status}). Проверьте TELEGRAM_BOT_TOKEN в .env: ` +
          `значение должно выглядеть как 1234567890:AA... — возможно, туда попал текст-заглушка.`,
      );
    }

    const json = (await res.json()) as { ok: boolean; result?: T; description?: string };
    if (!json.ok) throw new Error(`Telegram ${method}: ${json.description ?? "неизвестная ошибка"}`);
    return json.result as T;
  }

  async sendMessage(chatId: number, text: string, keyboard?: InlineKeyboard): Promise<void> {
    await this.call("sendMessage", {
      chat_id: chatId,
      text,
      ...(keyboard ? { reply_markup: keyboard } : {}),
    });
  }

  /**
   * Отправка файла (Excel, Word, отчёт).
   *
   * Идёт не через JSON, а multipart — файл нельзя вложить в обычный запрос.
   * Владелец получает документ прямо в чат: открыть, переслать бухгалтеру,
   * подшить — без выгрузок и панелей.
   */
  async sendDocument(
    chatId: number,
    filename: string,
    content: Buffer,
    caption?: string,
  ): Promise<void> {
    const form = new FormData();
    form.append("chat_id", String(chatId));
    if (caption) form.append("caption", caption.slice(0, 1024)); // предел Telegram
    form.append("document", new Blob([new Uint8Array(content)]), filename);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60_000); // файл дольше текста
    try {
      const res = await fetch(this.url("sendDocument"), {
        method: "POST",
        body: form,
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new Error(`Telegram ответил ${res.status} на sendDocument`);
      }
    } finally {
      clearTimeout(timer);
    }
  }

  /** Переписать отправленное сообщение (и убрать кнопки): карточка согласования
   *  после решения должна показывать итог, а не предлагать решать снова. */
  async editMessage(chatId: number, messageId: number, text: string): Promise<void> {
    await this.call("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text,
    });
  }

  async answerCallback(callbackId: string, text: string): Promise<void> {
    await this.call("answerCallbackQuery", { callback_query_id: callbackId, text });
  }

  /** Забирает пачку обновлений. Смещение двигаем сами, чтобы не обрабатывать дважды. */
  async getUpdates(): Promise<TgUpdate[]> {
    const updates = await this.call<TgUpdate[]>("getUpdates", {
      offset: this.offset,
      timeout: this.timeoutSec,
      allowed_updates: ["message", "callback_query"],
    });
    for (const u of updates) {
      if (u.update_id >= this.offset) this.offset = u.update_id + 1;
    }
    return updates;
  }
}
