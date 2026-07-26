/**
 * MYDON Bot — Telegram, основной канал (скелет).
 * По ТЗ: брифинг 07:30 Asia/Tashkent, очередь approvals с кнопками, вопросы на естественном языке.
 * Безопасность (Ф9): белый список chat_id, валидация initData (auth_date ≤ 24ч), rate limiting.
 */
import { TZ } from "@mydon/shared";

export function start(): void {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.warn("TELEGRAM_BOT_TOKEN не задан — бот в режиме скелета.");
  }
  console.log(`MYDON Bot: скелет готов (TZ=${TZ}).`);
}

if (require.main === module) start();
