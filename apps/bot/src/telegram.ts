/**
 * Транспорт Telegram Bot API на long polling.
 * Long polling выбран намеренно: не требует открытых портов наружу (ТЗ §6 —
 * доступ только через Tailscale, «ноль открытых портов»).
 * Без внешних зависимостей — только fetch.
 */

import { OutRate } from "./out-rate";

export interface TgUpdate {
  update_id: number;
  message?: {
    message_id: number;
    chat: { id: number };
    /** Кто написал: @username нужен, чтобы привязать сотрудника по «Старту». */
    from?: { id: number; username?: string };
    text?: string;
    voice?: { file_id: string };
    /** Фото приходит набором размеров; берём последний (максимальное разрешение). */
    photo?: { file_id: string; file_unique_id: string; width: number; height: number; file_size?: number }[];
    /** Подпись к фото — можно сразу написать название. */
    caption?: string;
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

/**
 * Постоянное меню под полем ввода. В отличие от inline-клавиатуры живёт не
 * при сообщении, а при чате: Telegram держит её, пока не заменят или не
 * уберут. Полевому сотруднику это важнее inline-дубля — кнопки под рукой
 * всегда, а не только под последней карточкой.
 */
export interface ReplyKeyboard {
  keyboard: { text: string }[][];
  resize_keyboard: true;
  is_persistent: true;
  input_field_placeholder?: string;
}

export type AnyKeyboard = InlineKeyboard | ReplyKeyboard;

/** Токен неверен или отозван. Повторять запросы бессмысленно. */
export class InvalidTokenError extends Error {
  readonly fatal = true;
}

/**
 * Отказ Bot API с сохранённым кодом.
 *
 * Раньше 403, 429 и 500 схлопывались в безымянный Error, и вызывающий не мог
 * отличить «человек заблокировал бота» (повторять бессмысленно вечно) от
 * «слишком часто» (повторить через retry_after) и от сетевого сбоя (повторить
 * сейчас). Разница между ними — это разница между потерянным напоминанием и
 * доставленным.
 */
export class TelegramError extends Error {
  constructor(
    readonly method: string,
    readonly errorCode: number | null,
    readonly description: string,
    /** Сколько секунд просит подождать Telegram при 429. */
    readonly retryAfter: number | null = null,
  ) {
    super(`Telegram ${method}: ${description}`);
    this.name = "TelegramError";
  }

  /**
   * Человек недоступен навсегда: заблокировал бота, удалил чат, деактивирован.
   * Повторять нельзя — не потому что не выйдет, а потому что каждая попытка
   * это лишний запрос, а результат уже известен.
   */
  get isUnreachable(): boolean {
    if (this.errorCode !== 403) return false;
    return /blocked|deactivated|kicked|chat not found|user is deactivated/i.test(this.description);
  }

  /** Слишком часто. Не ошибка, а просьба подождать. */
  get isRateLimited(): boolean {
    return this.errorCode === 429;
  }
}

export class TelegramApi {
  private offset = 0;
  private readonly rate: OutRate;

  constructor(
    private readonly token: string,
    private readonly timeoutSec = 30,
    rate?: OutRate,
  ) {
    this.rate = rate ?? new OutRate();
    // Карта чатов не должна расти вместе с историей переписки.
    setInterval(() => this.rate.sweep(), 5 * 60_000).unref();
  }

  private url(method: string): string {
    return `https://api.telegram.org/bot${this.token}/${method}`;
  }

  /**
   * Таймаут на метод. Без него зависший запрос к Bot API держит весь цикл
   * обработки: бот разбирает сообщения по одному, и одно повисшее сообщение
   * замораживает кнопки у всех остальных.
   */
  private async call<T>(method: string, body: unknown, timeoutMs = 15_000): Promise<T> {
    const res = await fetch(this.url(method), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });

    // 401/404 от Bot API означают одно: токен неверный или отозван.
    // Это не временный сбой — повторять бессмысленно, нужно сказать об этом прямо.
    if (res.status === 401 || res.status === 404) {
      throw new InvalidTokenError(
        `Telegram отклонил токен (HTTP ${res.status}). Проверьте TELEGRAM_BOT_TOKEN в .env: ` +
          `значение должно выглядеть как 1234567890:AA... — возможно, туда попал текст-заглушка.`,
      );
    }

    const json = (await res.json()) as {
      ok: boolean;
      result?: T;
      description?: string;
      error_code?: number;
      parameters?: { retry_after?: number };
    };
    if (!json.ok) {
      throw new TelegramError(
        method,
        json.error_code ?? res.status,
        json.description ?? "неизвестная ошибка",
        json.parameters?.retry_after ?? null,
      );
    }
    return json.result as T;
  }

  /**
   * Отправка с соблюдением лимитов и одной повторной попыткой на 429.
   *
   * Один повтор, а не цикл: если Telegram просит ждать дважды подряд, значит
   * рассылку надо не проталкивать, а притормозить целиком — этим и занимается
   * пауза в ограничителе.
   */
  async sendMessage(chatId: number, text: string, keyboard?: AnyKeyboard): Promise<void> {
    const body = {
      chat_id: chatId,
      text,
      ...(keyboard ? { reply_markup: keyboard } : {}),
    };
    await this.rate.take(chatId);
    try {
      await this.call("sendMessage", body);
    } catch (err) {
      if (err instanceof TelegramError && err.isRateLimited) {
        this.rate.pause(err.retryAfter ?? 1);
        await this.rate.take(chatId);
        await this.call("sendMessage", body);
        return;
      }
      throw err;
    }
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

  /**
   * Переписать отправленное сообщение. Без `keyboard` кнопки СНИМАЮТСЯ —
   * именно это нужно карточке согласования: после решения она показывает итог,
   * а не предлагает решать снова.
   *
   * С `keyboard` — перерисовка на месте с новым набором кнопок: список задач
   * после «Взял в работу» должен обновиться там же, а не падать вторым
   * сообщением поверх первого.
   */
  async editMessage(
    chatId: number,
    messageId: number,
    text: string,
    keyboard?: InlineKeyboard,
  ): Promise<void> {
    await this.call("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text,
      ...(keyboard ? { reply_markup: keyboard } : {}),
    });
  }

  async answerCallback(callbackId: string, text: string): Promise<void> {
    await this.call("answerCallbackQuery", { callback_query_id: callbackId, text });
  }

  /**
   * Скачать файл (например фото номенклатуры) по file_id.
   *
   * Два шага Bot API: getFile отдаёт временный путь, затем сам файл забирается
   * с /file/bot<token>/<path>. Токен в URL — так устроен Telegram; наружу он не
   * уходит, запрос идёт от бота.
   */
  async downloadFile(fileId: string): Promise<{ bytes: Buffer; mime: string | null }> {
    const file = await this.call<{ file_path?: string }>("getFile", { file_id: fileId });
    if (!file.file_path) throw new Error("Telegram не отдал путь файла");
    const res = await fetch(`https://api.telegram.org/file/bot${this.token}/${file.file_path}`, {
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw new Error(`Не скачать файл Telegram: HTTP ${res.status}`);
    const mime = res.headers.get("content-type");
    return { bytes: Buffer.from(await res.arrayBuffer()), mime };
  }

  /** Забирает пачку обновлений. Смещение двигаем сами, чтобы не обрабатывать дважды. */
  async getUpdates(): Promise<TgUpdate[]> {
    // Свой таймаут: long polling законно молчит timeoutSec секунд, и общие
    // 15 секунд обрывали бы каждый пустой опрос как сбой.
    const updates = await this.call<TgUpdate[]>(
      "getUpdates",
      {
        offset: this.offset,
        timeout: this.timeoutSec,
        // message покрывает и фото (оно приходит как message с полем photo).
        allowed_updates: ["message", "callback_query"],
      },
      (this.timeoutSec + 10) * 1000,
    );
    for (const u of updates) {
      if (u.update_id >= this.offset) this.offset = u.update_id + 1;
    }
    return updates;
  }
}
