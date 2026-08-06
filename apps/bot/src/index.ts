import path from "node:path";
import { config as loadEnv } from "dotenv";
import {
  createContextSearch,
  createLlmResolver,
  createSubscriptionResolver,
  withLlmFallback,
  type LlmResolver,
} from "@mydon/assistant";
import { createDocumentBuilder } from "@mydon/documents";
import { dueLabel, TZ } from "@mydon/shared";
import { collectGloberentSignals, formatBriefing, msUntilBriefing } from "./briefing";
import { CoreClient, type PersonRow } from "./core-client";
import { handleMessage, parseApprovalCallback, type HandlerDeps } from "./handler";
import { Notifier } from "./notifier";
import { parseAllowlist, RateLimiter, isAllowed } from "./security/access";
import { Conversations } from "./conversation";
import { AwaitingReport, handleStaffCallback, handleStaffMessage, taskKeyboard } from "./staff";
import { handleRegisterPhoto } from "./staff-register";
import { InvalidTokenError, TelegramApi, type TgUpdate } from "./telegram";

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

/** YYYY-MM-DD по Ташкенту — окно сверки коффе-бункеров для брифинга. */
function isoDate(d: Date): string {
  return d.toLocaleDateString("sv-SE", { timeZone: TZ });
}

/**
 * MYDON Bot — основной канал (ТЗ FR-1a).
 * Уведомления, согласования, вопросы. Long polling: наружу портов не открываем.
 */
async function main(): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN ?? "";
  const allowlist = parseAllowlist(process.env.TELEGRAM_ALLOWED_CHAT_IDS);
  const coreUrl = process.env.CORE_API_URL ?? "http://127.0.0.1:3001";

  // LLM-слой. Два пути входа: подписка Claude владельца (CLAUDE_CODE_OAUTH_TOKEN)
  // и API-ключ (ANTHROPIC_API_KEY). Заданы оба — сначала подписка, при её сбое
  // (кончился лимит) отвечает API. Не задано ничего — бот работает по правилам.
  const modelOverride = process.env.MYDON_ASSISTANT_MODEL
    ? { model: process.env.MYDON_ASSISTANT_MODEL }
    : {};
  const apiLlm: LlmResolver | undefined = process.env.ANTHROPIC_API_KEY
    ? createLlmResolver({ apiKey: process.env.ANTHROPIC_API_KEY, ...modelOverride })
    : undefined;
  // Таймаут короче обычного (обычный ответ ~4с): бот разбирает сообщения по
  // одному, и зависший вопрос заморозил бы кнопки и чаты всех остальных.
  const subLlm: LlmResolver | undefined = process.env.CLAUDE_CODE_OAUTH_TOKEN
    ? createSubscriptionResolver({ ...modelOverride, timeoutMs: 20_000 })
    : undefined;
  const llm: LlmResolver | undefined =
    subLlm && apiLlm ? withLlmFallback(subLlm, apiLlm) : (subLlm ?? apiLlm);

  // Документы (Excel, Word) через готовые навыки Anthropic. Ключ тот же, что
  // и у помощника: нет ключа — файлов не делаем, но бот работает дальше.
  const buildDocument = process.env.ANTHROPIC_API_KEY
    ? createDocumentBuilder({
        apiKey: process.env.ANTHROPIC_API_KEY,
        ...(process.env.MYDON_ASSISTANT_MODEL ? { model: process.env.MYDON_ASSISTANT_MODEL } : {}),
      })
    : undefined;

  // Память помощника: заметки и история разговоров через Core. Работает всегда —
  // не настроено на стороне Core, вернётся пусто, и ответ будет как раньше.
  const context = createContextSearch({ baseUrl: coreUrl });

  const deps: HandlerDeps = {
    core: new CoreClient(coreUrl, 10_000, process.env.SERVICE_TOKEN ?? ""),
    context,
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
  const conversations = new Conversations();
  const staffDeps = { core: deps.core, awaiting, conversations };
  setInterval(() => awaiting.sweep(), 10 * 60_000).unref();
  setInterval(() => conversations.sweep(), 10 * 60_000).unref();

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

      const { reply } = await handleStaffMessage(chatId, text, person, staffDeps);

      // Постоянное меню и inline-кнопки не помещаются в одно сообщение:
      // reply_markup один. Меню ставим отдельной короткой строкой — оно нужно
      // редко (первый вход, справка), а список задач приходит со своими
      // номерными кнопками одним сообщением, а не десятью.
      if (reply.replyKeyboard) {
        await tg.sendMessage(chatId, reply.text, reply.replyKeyboard);
        if (reply.keyboard) await tg.sendMessage(chatId, "Выбери задачу:", reply.keyboard);
      } else {
        await tg.sendMessage(chatId, reply.text, reply.keyboard);
      }
    } catch (err) {
      console.error("Сообщение сотрудника не обработано:", err);
    }
  }

  /**
   * Фото от сотрудника: имеет смысл только внутри активного заведения. Берём
   * последний размер (максимальное разрешение), качаем байты и грузим в Core.
   * Чужому/вне визарда молчим — как и на текст.
   */
  async function routeStaffPhoto(
    chatId: number,
    photo: NonNullable<NonNullable<TgUpdate["message"]>["photo"]>,
  ): Promise<void> {
    try {
      const person = await personOf(chatId);
      if (person === null) return;
      const largest = photo[photo.length - 1];
      const file = await tg.downloadFile(largest.file_id);
      const reply = await handleRegisterPhoto(chatId, file, person, staffDeps);
      if (reply) await tg.sendMessage(chatId, reply.text, reply.keyboard);
    } catch (err) {
      console.error("Фото сотрудника не обработано:", err);
    }
  }

  // Утренний брифинг 07:30 Asia/Tashkent (FR-6)
  const scheduleBriefing = (): void => {
    setTimeout(() => {
      void (async () => {
        try {
          const to = isoDate(new Date());
          const from = isoDate(new Date(Date.now() - 3 * 86_400_000));
          const [b, approvals, purchase, fillStatus, reconcile, washSchedule, globerent] = await Promise.all([
            deps.core.briefing(),
            deps.core.pendingApprovals(),
            deps.core.vendingPurchase().catch(() => null),
            deps.core.coffeeFillStatus().catch(() => null),
            deps.core.coffeeReconcileAll(from, to).catch(() => null),
            deps.core.coffeeWashScheduleStatus().catch(() => null),
            collectGloberentSignals(deps.core),
          ]);
          const coffee =
            fillStatus || reconcile || washSchedule
              ? {
                  underfill: fillStatus?.filter((r) => r.status === "underfill").length ?? 0,
                  anomaly: reconcile?.reduce((n, g) => n + g.rows.filter((r) => r.reconcile.status === "anomaly").length, 0) ?? 0,
                  overdueWash: washSchedule?.filter((r) => r.status === "overdue").length ?? 0,
                }
              : undefined;
          const text = formatBriefing(
            b,
            approvals,
            purchase ? { positions: purchase.items.length, costRounded: purchase.costRounded } : undefined,
            coffee,
            globerent,
          );
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

  /**
   * Возвраты на доработку: владелец нажал «Переделать» — исполнитель должен
   * узнать сразу, а не при следующем напоминании о сроке. Порядок тот же,
   * что у напоминаний: сначала доставка, потом отметка.
   */
  async function sendRedoNotices(): Promise<void> {
    const tasks = await deps.core.redoUnnotified();
    if (tasks.length === 0) return;

    const people = await deps.core.people();
    const chatById = new Map(people.filter((p) => p.tgChatId).map((p) => [p.id, p.tgChatId!]));

    for (const t of tasks) {
      const chat = t.ownerRef !== null ? chatById.get(t.ownerRef) : undefined;
      if (chat === undefined) continue; // не подключён к Telegram — увидит в списке
      try {
        await tg.sendMessage(
          Number(chat),
          `↩ Возвращена на доработку: ${t.title}\nПрошлый отчёт не принят — детали в комментариях к задаче.`,
          taskKeyboard(t),
        );
        await deps.core.markRedoNotified(t.id);
      } catch (err) {
        console.error("Сообщение о переделке не доставлено:", err);
      }
    }
  }

  const redoEveryMs = Number(process.env.REDO_NOTIFY_INTERVAL_MS ?? 60_000);
  setInterval(() => {
    void sendRedoNotices().catch((err: unknown) => console.error("Переделки:", err));
  }, redoEveryMs).unref();

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
        const items = await notifier.collect();
        // Отправляем каждое отдельно: сбой одного не роняет остальные и не
        // отмечает недоставленное. Отмечаем ПОСЛЕ успешной отправки — иначе при
        // сбое sendMessage сигнал бы потерялся.
        const delivered: string[] = [];
        for (const { key, text } of items) {
          try {
            for (const chatId of allowlist) {
              await tg.sendMessage(chatId, text);
            }
            delivered.push(key);
          } catch (err) {
            console.error("Уведомление не доставлено (повторю на следующем опросе):", err);
          }
        }
        try {
          await notifier.ack(delivered);
        } catch (err) {
          console.error("Отметку о доставке не сохранить (повторю):", err);
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
        if (u.message?.photo && u.message.photo.length > 0) {
          // Фото — только для сотрудника в активном заведении. Владелец шлёт
          // фото редко и здесь его не обрабатываем (личный режим — текстовый).
          await routeStaffPhoto(u.message.chat.id, u.message.photo);
        } else if (u.message?.text) {
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
            if (!parsed) {
              // Неизвестная кнопка: молчание оставляет вечный спиннер —
              // выглядит как «кнопки не работают».
              await tg.answerCallback(u.callback_query.id, "Эта кнопка устарела");
              continue;
            }
            const DECIDED_LABEL = {
              approved: "✅ Одобрено — исполняю",
              rejected: "❌ Отклонено",
              clarify: "❓ Отправлено на уточнение",
            } as const;
            try {
              await deps.core.decide(parsed.id, parsed.decision, `telegram:${chatId}`);
              await tg.answerCallback(u.callback_query.id, "Решение записано");
              // Карточка должна показать итог и перестать предлагать кнопки:
              // иначе кажется, что нажатие не сработало.
              const msg = u.callback_query.message;
              if (msg?.message_id !== undefined && typeof msg.text === "string") {
                try {
                  await tg.editMessage(chatId, msg.message_id, `${msg.text}

${DECIDED_LABEL[parsed.decision]}`);
                } catch {
                  // Не переписалось (старое сообщение) — решение всё равно записано.
                }
              }
            } catch (err) {
              console.error("Решение не записано:", err);
              // Самая частая причина — уже решено (в панели или тут же раньше).
              const detail = err instanceof Error && err.message.includes("уже закрыт")
                ? "Уже решено раньше — карточка устарела"
                : "Не удалось записать решение";
              await tg.answerCallback(u.callback_query.id, detail);
            }
            continue;
          }

          // Кнопка от сотрудника: «Взял» / «Сделал» по своей задаче.
          const person = await personOf(chatId);
          if (person === null) continue; // постороннему не отвечаем вовсе
          try {
            const res = await handleStaffCallback(chatId, data, person, staffDeps);
            await tg.answerCallback(u.callback_query.id, res.answer);
            // Перерисовка на месте: карточка задачи должна меняться там же, где
            // на неё нажали. Не вышло (сообщение старое, текст тот же) — шлём
            // новым сообщением, иначе нажатие выглядит как «ничего не сделал».
            if (res.edit) {
              const msgId = u.callback_query.message?.message_id;
              let edited = false;
              if (msgId !== undefined) {
                try {
                  await tg.editMessage(chatId, msgId, res.edit.text, res.edit.keyboard);
                  edited = true;
                } catch (err) {
                  console.error("Карточку задачи не переписать:", err);
                }
              }
              if (!edited) await tg.sendMessage(chatId, res.edit.text, res.edit.keyboard);
            }
            if (res.message) await tg.sendMessage(chatId, res.message, res.keyboard);
            // Владелец узнаёт о сборе сразу — деньги в пути, приём ждёт в панели.
            if (res.ownerNote) {
              for (const ownerChat of allowlist) {
                try {
                  await tg.sendMessage(ownerChat, res.ownerNote);
                } catch (err) {
                  console.error("Владелец не уведомлён об инкассации:", err);
                }
              }
            }
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
