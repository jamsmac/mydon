import path from "node:path";
import { config as loadEnv } from "dotenv";
import { TZ } from "@mydon/shared";
import { formatBriefing, msUntilBriefing } from "./briefing";
import { CoreClient } from "./core-client";
import { handleMessage, parseApprovalCallback, type HandlerDeps } from "./handler";
import { Notifier } from "./notifier";
import { parseAllowlist, RateLimiter, isAllowed } from "./security/access";
import { InvalidTokenError, TelegramApi } from "./telegram";

loadEnv({ path: path.resolve(__dirname, "../../../.env"), quiet: true });

/**
 * Держит процесс живым, когда работать не с чем. Завершается по SIGTERM от Docker.
 *
 * Одного «зависшего» промиса НЕДОСТАТОЧНО: незавершённый промис не является
 * дескриптором цикла событий, и Node всё равно выходит. Нужен настоящий таймер
 * (намеренно без unref — именно он и удерживает процесс).
 */
function idle(): Promise<never> {
  return new Promise<never>(() => {
    setInterval(() => {}, 1 << 30);
  });
}

/**
 * MYDON Bot — основной канал (ТЗ FR-1a).
 * Уведомления, согласования, вопросы. Long polling: наружу портов не открываем.
 */
async function main(): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN ?? "";
  const allowlist = parseAllowlist(process.env.TELEGRAM_ALLOWED_CHAT_IDS);
  const coreUrl = process.env.CORE_API_URL ?? "http://127.0.0.1:3001";

  const deps: HandlerDeps = {
    core: new CoreClient(coreUrl),
    allowlist,
    limiter: new RateLimiter(),
  };

  if (!token) {
    console.warn("TELEGRAM_BOT_TOKEN не задан — бот запущен в режиме скелета, опрос не начат.");
    console.log(`MYDON Bot готов (TZ=${TZ}, Core=${coreUrl}). Ожидаю токен.`);
    // Не выходим: служба под restart-политикой Docker уходила бы в бесконечный
    // цикл перезапусков. Ждём — токен появится, контейнер перезапустят штатно.
    await idle();
  }
  if (allowlist.size === 0) {
    console.warn(
      "TELEGRAM_ALLOWED_CHAT_IDS пуст — доступ закрыт для всех. Укажите свой chat_id в .env.",
    );
  }

  const tg = new TelegramApi(token);
  console.log(`MYDON Bot запущен (TZ=${TZ}, Core=${coreUrl}, разрешено чатов: ${allowlist.size}).`);

  // Утренний брифинг 07:30 Asia/Tashkent (FR-6)
  const scheduleBriefing = (): void => {
    setTimeout(() => {
      void (async () => {
        try {
          const [b, approvals] = await Promise.all([
            deps.core.briefing(),
            deps.core.pendingApprovals(),
          ]);
          const text = formatBriefing(b, approvals);
          for (const chatId of allowlist) {
            await tg.sendMessage(chatId, text);
          }
        } catch (err) {
          console.error("Брифинг не отправлен:", err);
        } finally {
          scheduleBriefing();
        }
      })();
    }, msUntilBriefing());
  };
  scheduleBriefing();

  setInterval(() => deps.limiter.sweep(), 5 * 60_000).unref();

  // Срочные уведомления (FR-2): опрос правил и доставка владельцу
  const notifier = new Notifier(deps.core);
  const notifyEveryMs = Number(process.env.NOTIFY_INTERVAL_MS ?? 60_000);
  setInterval(() => {
    void (async () => {
      try {
        const texts = await notifier.collect();
        for (const text of texts) {
          for (const chatId of allowlist) {
            await tg.sendMessage(chatId, text);
          }
        }
      } catch (err) {
        console.error("Уведомления не доставлены:", err);
      }
    })();
  }, notifyEveryMs).unref();

  // Опрос обновлений
  for (;;) {
    try {
      const updates = await tg.getUpdates();
      for (const u of updates) {
        if (u.message?.text) {
          const reply = await handleMessage(u.message.chat.id, u.message.text, deps);
          if (reply) await tg.sendMessage(u.message.chat.id, reply.text, reply.keyboard);
        } else if (u.callback_query?.data) {
          const chatId = u.callback_query.message?.chat.id;
          if (chatId === undefined || !isAllowed(chatId, allowlist)) continue;
          const parsed = parseApprovalCallback(u.callback_query.data);
          if (!parsed) continue;
          try {
            await deps.core.decide(parsed.id, parsed.decision, `telegram:${chatId}`);
            await tg.answerCallback(u.callback_query.id, "Решение записано");
          } catch (err) {
            console.error("Решение не записано:", err);
            await tg.answerCallback(u.callback_query.id, "Не удалось записать решение");
          }
        }
      }
    } catch (err) {
      if (err instanceof InvalidTokenError) {
        // Неверный токен не «пройдёт сам»: вместо бесконечного потока одинаковых
        // ошибок говорим один раз понятно и ждём, пока значение исправят.
        console.error(`\nБОТ НЕ ЗАПУСТИЛСЯ: ${err.message}\n`);
        await idle();
      }
      console.error("Ошибка опроса Telegram:", err);
      await new Promise((r) => setTimeout(r, 5_000));
    }
  }
}

main().catch((err: unknown) => {
  console.error("Бот остановлен:", err instanceof Error ? err.message : err);
  process.exit(1);
});
