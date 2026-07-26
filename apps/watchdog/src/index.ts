import path from "node:path";
import { config as loadEnv } from "dotenv";
import { checkOnce, WatchdogState } from "./watchdog";

loadEnv({ path: path.resolve(__dirname, "../../../.env"), quiet: true });

/**
 * Внешний сторож MYDON.
 *
 * ТЗ §6 называет его ОБЯЗАТЕЛЬНЫМ, фронт Ф8 подтвердил, что его нет:
 * весь MYDON живёт на одном сервере, и если Hetzner ляжет — сообщить некому,
 * потому что сам сторож лежал бы вместе с ним.
 *
 * Поэтому этот процесс запускается НЕ на том сервере, за которым следит,
 * и пользуется ОТДЕЛЬНЫМ Telegram-ботом: общий бот тоже был бы недоступен.
 */
async function main(): Promise<void> {
  const target = process.env.WATCHDOG_TARGET_URL;
  const token = process.env.WATCHDOG_BOT_TOKEN;
  const chatIds = (process.env.WATCHDOG_CHAT_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const intervalMs = Number(process.env.WATCHDOG_INTERVAL_MS ?? 60_000);
  const failuresToAlert = Number(process.env.WATCHDOG_FAILURES ?? 3);

  if (!target) {
    console.error("WATCHDOG_TARGET_URL не задан — сторожу нечего проверять.");
    process.exit(1);
  }
  if (!token || chatIds.length === 0) {
    console.warn(
      "WATCHDOG_BOT_TOKEN или WATCHDOG_CHAT_IDS не заданы — тревоги будут только в лог.",
    );
  }

  const notify = async (text: string): Promise<void> => {
    console.log(text);
    if (!token || chatIds.length === 0) return;
    for (const chatId of chatIds) {
      try {
        await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: chatId, text }),
        });
      } catch (err) {
        console.error("Тревога не отправлена:", err);
      }
    }
  };

  const state = new WatchdogState(failuresToAlert);
  console.log(
    `Сторож запущен: цель ${target}, проверка каждые ${Math.round(intervalMs / 1000)} с, ` +
      `тревога после ${failuresToAlert} неудач подряд.`,
  );

  const tick = async (): Promise<void> => {
    const result = await checkOnce(target);
    const action = state.apply(result.ok);
    if (action === "alert_down") {
      await notify(`🚨 MYDON недоступен: ${target}\nПричина: ${result.reason ?? "нет ответа"}`);
    } else if (action === "alert_recovered") {
      await notify(`✅ MYDON снова доступен: ${target}`);
    }
  };

  await tick();
  setInterval(() => void tick(), intervalMs);
}

main().catch((err: unknown) => {
  console.error("Сторож остановлен:", err instanceof Error ? err.message : err);
  process.exit(1);
});
