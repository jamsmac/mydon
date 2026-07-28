import path from "node:path";
import { config as loadEnv } from "dotenv";
import { createLlmResolver, type LlmResolver } from "@mydon/assistant";
import { createDocumentBuilder } from "@mydon/documents";
import { dueLabel, TZ } from "@mydon/shared";
import { formatBriefing, msUntilBriefing } from "./briefing";
import { CoreClient, type PersonRow } from "./core-client";
import { handleMessage, parseApprovalCallback, type HandlerDeps } from "./handler";
import { Notifier } from "./notifier";
import { parseAllowlist, RateLimiter, isAllowed } from "./security/access";
import { AwaitingReport, handleStaffCallback, handleStaffMessage, taskKeyboard } from "./staff";
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

  // LLM-слой: включается при наличии ключа. Нет ключа — бот работает по правилам.
  const llm: LlmResolver | undefined = process.env.ANTHROPIC_API_KEY
    ? createLlmResolver({
        apiKey: process.env.ANTHROPIC_API_KEY,
        ...(process.env.MYDON_ASSISTANT_MODEL ? { model: process.env.MYDON_ASSISTANT_MODEL } : {}),
      })
    : undefined;

  // Документы (Excel, Word) через готовые навыки Anthropic. Ключ тот же, что
  // и у помощника: нет ключа — файлов не делаем, но бот работает дальше.
  const buildDocument = process.env.ANTHROPIC_API_KEY
    ? createDocumentBuilder({
        apiKey: process.env.ANTHROPIC_API_KEY,
        ...(process.env.MYDON_ASSISTANT_MODEL ? { model: process.env.MYDON_ASSISTANT_MODEL } : {}),
      })
    : undefined;

  const deps: HandlerDeps = {
    core: new CoreClient(coreUrl),
    allowlist,
    limiter: new RateLimiter(),
    ...(llm ? { llm } : {}),
    ...(buildDocument ? { buildDocument } : {}),
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

  // ── Сотрудники: свой узкий режим (только свои задачи) ──────────────────────
  const awaiting = new AwaitingReport();
  const staffDeps = { core: deps.core, awaiting };
  setInterval(() => awaiting.sweep(), 10 * 60_000).unref();

  /** Кто написал: сотрудник или посторонний. Ошибка Core = «неизвестен». */
  async function personOf(chatId: number): Promise<PersonRow | null> {
    try {
      const res = await deps.core.personByChat(String(chatId));
      return "found" in res ? null : res;
    } catch {
      return null;
    }
  }

  /**
   * Сообщение не от владельца. Незнакомого пробуем привязать: он мог нажать
   * «Старт», а владелец заранее вписал его @username в карточку сотрудника.
   * Так связь устанавливается сама, без ручного ввода chat_id.
   */
  async function routeStaffMessage(
    chatId: number,
    text: string,
    username: string | undefined,
  ): Promise<void> {
    try {
      let person = await personOf(chatId);

      if (person === null) {
        const linked = await deps.core.linkTelegram(String(chatId), username ?? null);
        if ("linked" in linked) {
          // Не нашли — молчим: ответ подтвердил бы постороннему, что бот живой.
          return;
        }
        person = linked;
        await tg.sendMessage(
          chatId,
          `Привет, ${person.name}. Теперь я буду присылать сюда твои задачи от MYDON.`,
        );
      }

      const { reply, tasks } = await handleStaffMessage(chatId, text, person, staffDeps);
      await tg.sendMessage(chatId, reply.text, reply.keyboard);

      // Кнопки — по одному сообщению на задачу: у сообщения может быть только
      // одна клавиатура, а действовать нужно по конкретной задаче.
      for (const t of (tasks ?? []).slice(0, 10)) {
        await tg.sendMessage(chatId, `📌 ${t.title}`, taskKeyboard(t));
      }
    } catch (err) {
      console.error("Сообщение сотрудника не обработано:", err);
    }
  }

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

  /**
   * Напоминания о сроках.
   *
   * Исполнителю — что срок близко; владельцу — что срок прошёл, а задача
   * открыта. Отметка «напомнили» ставится ПОСЛЕ отправки: иначе при сбое сети
   * задача считалась бы напомненной, и человек не узнал бы о ней вовсе.
   */
  async function sendReminders(): Promise<void> {
    const due = await deps.core.tasksDueSoon(24);
    if (due.length === 0) return;

    const people = await deps.core.people();
    const chatById = new Map(people.filter((p) => p.tgChatId).map((p) => [p.id, p.tgChatId!]));

    for (const t of due) {
      const overdue = t.due !== null && new Date(t.due).getTime() < Date.now();
      const line = `${overdue ? "⏰ Просрочено" : "🔔 Скоро срок"}: ${t.title}\n${dueLabel(t.due)}`;
      let delivered = false;

      // Исполнителю-человеку — лично, с кнопками: напоминание без возможности
      // ответить бесполезно.
      if (t.ownerKind === "human" && t.ownerRef !== null) {
        const chat = chatById.get(t.ownerRef);
        if (chat !== undefined) {
          try {
            await tg.sendMessage(Number(chat), line, taskKeyboard(t));
            delivered = true;
          } catch (err) {
            console.error("Напоминание исполнителю не доставлено:", err);
          }
        }
      }

      // Владельцу — только о просроченном: он должен знать, что стоит.
      if (overdue) {
        for (const chatId of allowlist) {
          try {
            await tg.sendMessage(chatId, line);
            delivered = true;
          } catch (err) {
            console.error("Напоминание владельцу не доставлено:", err);
          }
        }
      }

      if (delivered) {
        try {
          await deps.core.markReminded(t.id);
        } catch (err) {
          console.error("Отметка «напомнили» не записана:", err);
        }
      }
    }
  }

  const remindEveryMs = Number(process.env.REMIND_INTERVAL_MS ?? 30 * 60_000);
  setInterval(() => {
    void sendReminders().catch((err: unknown) => console.error("Напоминания:", err));
  }, remindEveryMs).unref();

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
          const chatId = u.message.chat.id;
          if (isAllowed(chatId, allowlist)) {
            const reply = await handleMessage(chatId, u.message.text, deps);
            if (reply) {
              await tg.sendMessage(chatId, reply.text, reply.keyboard);
              // Файл идёт отдельным сообщением: у документа своя доставка,
              // и она не должна мешать тексту, если сорвётся.
              if (reply.document) {
                try {
                  await tg.sendDocument(chatId, reply.document.filename, reply.document.content);
                } catch (err) {
                  console.error("Файл не отправлен:", err);
                  await tg.sendMessage(chatId, "Файл получился, но отправить не вышло. Повтори запрос.");
                }
              }
            }
          } else {
            // Не владелец — возможно, сотрудник. Ему доступны только свои задачи.
            await routeStaffMessage(chatId, u.message.text, u.message.from?.username);
          }
        } else if (u.callback_query?.data) {
          const chatId = u.callback_query.message?.chat.id;
          if (chatId === undefined) continue;
          const data = u.callback_query.data;

          if (isAllowed(chatId, allowlist)) {
            const parsed = parseApprovalCallback(data);
            if (!parsed) continue;
            try {
              await deps.core.decide(parsed.id, parsed.decision, `telegram:${chatId}`);
              await tg.answerCallback(u.callback_query.id, "Решение записано");
            } catch (err) {
              console.error("Решение не записано:", err);
              await tg.answerCallback(u.callback_query.id, "Не удалось записать решение");
            }
            continue;
          }

          // Кнопка от сотрудника: «Взял» / «Сделал» по своей задаче.
          const person = await personOf(chatId);
          if (person === null) continue; // постороннему не отвечаем вовсе
          try {
            const res = await handleStaffCallback(chatId, data, person, staffDeps);
            await tg.answerCallback(u.callback_query.id, res.answer);
            if (res.message) await tg.sendMessage(chatId, res.message);
          } catch (err) {
            console.error("Кнопка задачи не сработала:", err);
            await tg.answerCallback(u.callback_query.id, "Не получилось, попробуй ещё раз");
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
