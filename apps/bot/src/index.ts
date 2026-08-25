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
import { dueLabel, parseStartPayload, rolesLabel, TZ } from "@mydon/shared";
import { collectGloberentSignals, formatBriefing, formatBriefingNotes, msUntilBriefing } from "./briefing";
import { buildDigest, digestKey } from "./staff-digest";
import { CoreClient, type PersonRow } from "./core-client";
import { handleMessage, parseApprovalCallback, type HandlerDeps } from "./handler";
import { Notifier } from "./notifier";
import { parseAllowlist, RateLimiter, isAllowed } from "./security/access";
import { Conversations } from "./conversation";
import { handleStaffCallback, handleStaffMessage, taskKeyboard } from "./staff";
import { helpText, menuKeyboard } from "./menu";
import { handleRegisterPhoto } from "./staff-register";
import { pickReceiptOrder } from "./purchase-brief";
import { attachBeforePhoto, handleTaskDonePhoto } from "./task-done";
import {
  handleStaffAddCallback,
  isStaffAddTrigger,
  parseStaffAddCallback,
  startStaffAdd,
} from "./staff-add";
import { handleAfterPhoto } from "./field-work";
import { summarizeActions } from "./owner-actions";
import { asStaffMode } from "./as-staff";
import { InvalidTokenError, TelegramApi, TelegramError, type TgUpdate } from "./telegram";

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
  // Имя бота нужно для ссылок-приглашений. Спрашиваем один раз у самого
  // Telegram, а не держим в .env: рассинхрон конфига и реального бота дал бы
  // ссылку, ведущую в никуда, и заметили бы это только на сотруднике.
  let botUsername = process.env.TELEGRAM_BOT_USERNAME ?? "";
  try {
    botUsername = (await tg.getMe()).username || botUsername;
  } catch (err) {
    console.warn("Имя бота не получено — ссылки-приглашения будут по TELEGRAM_BOT_USERNAME:", err);
  }
  console.log(`MYDON Bot запущен (TZ=${TZ}, Core=${coreUrl}, разрешено чатов: ${allowlist.size}).`);

  // ── Сотрудники: свой узкий режим (только свои задачи) ──────────────────────
  const conversations = new Conversations();
  const staffDeps = { core: deps.core, conversations };
  /** Чаты владельцев, временно смотрящих на бота глазами сотрудника. */
  const asStaff = new Set<number>();
  setInterval(() => conversations.sweep(), 10 * 60_000).unref();

  /**
   * Кто написал: сотрудник, посторонний или «Core недоступен».
   *
   * Три исхода, а не два: раньше сбой Core схлопывался в «посторонний», и
   * свой сотрудник посреди визарда получал вечный спиннер на кнопке — молча,
   * как чужак. Отличать «не найден» от «не смог спросить» обязан вызывающий.
   */
  async function personOf(chatId: number): Promise<PersonRow | null | "core-down"> {
    try {
      const res = await deps.core.personByChat(String(chatId));
      return "found" in res ? null : res;
    } catch {
      return "core-down";
    }
  }

  /**
   * Ограничитель попыток погасить приглашение.
   *
   * Код — 10 символов из 27, перебор не окупается по времени, но без
   * ограничителя ничто не мешает пробовать со скоростью сети. Пять попыток
   * в час на чат делают перебор бессмысленным окончательно.
   */
  const inviteTries = new Map<number, { n: number; at: number }>();
  const INVITE_WINDOW_MS = 60 * 60_000;
  const INVITE_MAX = 5;

  function inviteAllowed(chatId: number): boolean {
    const now = Date.now();
    const cur = inviteTries.get(chatId);
    if (!cur || now - cur.at > INVITE_WINDOW_MS) {
      inviteTries.set(chatId, { n: 1, at: now });
      return true;
    }
    cur.n += 1;
    return cur.n <= INVITE_MAX;
  }
  setInterval(() => {
    const cutoff = Date.now() - INVITE_WINDOW_MS;
    for (const [k, v] of inviteTries) if (v.at < cutoff) inviteTries.delete(k);
  }, 10 * 60_000).unref();

  /**
   * Сообщение не от владельца.
   *
   * Сначала пробуем приглашение: `/start inv_XXXX` — штатный путь подключения.
   * Привязка по @username осталась аварийной и выключается тумблером
   * STAFF_LINK_BY_USERNAME=0: освободившийся ник давал доступ к чужой карточке.
   */
  async function routeStaffMessage(
    chatId: number,
    text: string,
    username: string | undefined,
  ): Promise<void> {
    try {
      const code = parseStartPayload(text);
      if (code !== null) {
        if (!inviteAllowed(chatId)) {
          await tg.sendMessage(chatId, "Слишком много попыток. Попробуй через час.");
          return;
        }
        const res = await deps.core.redeemInvite(code, String(chatId));
        if ("error" in res) {
          await tg.sendMessage(chatId, "Ссылка не сработала: она одноразовая и живёт сутки. Попроси новую.");
          return;
        }
        await tg.sendMessage(
          chatId,
          `Привет, ${res.name}! Ты подключён.\n${rolesLabel(res.roles)}.\n\n${helpText(res.roles)}`,
          menuKeyboard(res.roles),
        );
        for (const ownerChat of allowlist) {
          await tg
            .sendMessage(ownerChat, `✅ ${res.name} подключился к боту (${rolesLabel(res.roles)}).`)
            .catch(() => undefined);
        }
        return;
      }

      let person = await personOf(chatId);
      // Core недоступен: привязку всё равно пробуем — она тоже упадёт, и
      // общий catch ниже честно ответит «сервер не ответил».
      if (person === "core-down") person = null;

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
      // Молчать нельзя: полевые строки шлют не глядя, и тишину читают как
      // «записано» — так теряются возвраты и комментарии. Ответ шлём с
      // собственной страховкой: упадёт и он — хуже уже не станет.
      await tg
        .sendMessage(chatId, "⚠️ Сервер не ответил — сообщение не обработано. Отправь его ещё раз через минуту.")
        .catch(() => undefined);
    }
  }

  /**
   * Фото от сотрудника. Берём последний размер (максимальное разрешение),
   * качаем байты и грузим в Core. Постороннему молчим — как и на текст.
   *
   * Куда приложить, решаем по контексту: активный мастер закрытия → «после»,
   * мастер заведения карточки → к карточке, иначе единственная задача в
   * работе → «до». Если контекста нет, отвечаем текстом, а не молчанием:
   * снимок с точки во второй раз уже не сделать, и «бот проглотил фото» —
   * худший из возможных ответов.
   */
  async function routeStaffPhoto(
    chatId: number,
    photo: NonNullable<NonNullable<TgUpdate["message"]>["photo"]>,
  ): Promise<void> {
    try {
      const person = await personOf(chatId);
      if (person === "core-down") {
        // Свой это или чужой — не узнать; молчать нельзя: снимок «до» второй
        // раз не сделать. Постороннему этот редкий ответ ничего не выдаёт.
        await tg
          .sendMessage(chatId, "⚠️ Фото не сохранилось — сервер не ответил. Отправь его ещё раз через минуту.")
          .catch(() => undefined);
        return;
      }
      if (person === null) return;
      const largest = photo[photo.length - 1];
      const file = await tg.downloadFile(largest.file_id);

      // Порядок разбора: активный мастер важнее догадок.
      const attached = await handleAfterPhoto(chatId, file, person, staffDeps);
      if (attached) {
        await tg.sendMessage(chatId, attached.text, attached.keyboard);
        return;
      }
      const done = await handleTaskDonePhoto(chatId, file, person, staffDeps);
      if (done) {
        await tg.sendMessage(chatId, done.text, done.keyboard);
        return;
      }
      const registered = await handleRegisterPhoto(chatId, file, person, staffDeps);
      if (registered) {
        await tg.sendMessage(chatId, registered.text, registered.keyboard);
        return;
      }

      // Фото вне мастера при ровно одной задаче в работе — это снимок «до».
      // Молчать нельзя: второй раз состояние «до» уже не сфотографировать.
      // Именно «ровно одной»: при двух задачах в работе угадывать, к какой
      // относится снимок, значит half the time приложить его не туда.
      const inProgress = (await deps.core.myTasks("human", person.id)).filter(
        (t) => t.status === "in_progress",
      );
      if (inProgress.length === 1) {
        const reply = await attachBeforePhoto(inProgress[0], file, person, staffDeps);
        await tg.sendMessage(chatId, reply.text, reply.keyboard);
        return;
      }
      await tg.sendMessage(
        chatId,
        inProgress.length === 0
          ? "Фото пришло, но не к чему приложить. Открой задачу, нажми «Взял в работу» — тогда пойму."
          : "У тебя несколько задач в работе — не пойму, к какой фото. Открой нужную и нажми «Выполнил».",
      );
    } catch (err) {
      console.error("Фото сотрудника не обработано:", err);
      // Комментарий выше называет «бот проглотил фото» худшим ответом — так
      // и не отвечаем им: снимок «до» второй раз не сделать, человек должен
      // узнать сразу, что фото не приложилось.
      await tg
        .sendMessage(chatId, "⚠️ Фото не сохранилось — отправь его ещё раз через минуту.")
        .catch(() => undefined);
    }
  }

  /**
   * Фото чека от владельца (П3): подпись «чек» → вложение к последней принятой
   * накладной (не старше суток — pickReceiptOrder). Доказательная база трат
   * §5.8 перестаёт держаться на честном слове, стейта нет: правило «сначала
   * „принять закуп", потом фото» заменяет мастер.
   */
  async function routeOwnerReceiptPhoto(
    chatId: number,
    photo: NonNullable<NonNullable<TgUpdate["message"]>["photo"]>,
  ): Promise<void> {
    try {
      // limit 50: свежепринятая накладная обязана попасть в окно выбора,
      // даже если панель нагенерила десяток заявок позже неё.
      const orders = await deps.core.vendingOrders(50);
      const target = pickReceiptOrder(orders, new Date());
      if (target === null) {
        await tg.sendMessage(
          chatId,
          "Не нашёл накладной, принятой за последние сутки, — чек не прикреплён. Сначала «принять закуп», потом фото с подписью «чек».",
        );
        return;
      }
      const largest = photo[photo.length - 1];
      const file = await tg.downloadFile(largest.file_id);
      await deps.core.uploadPhoto({
        ownerType: "vending_purchase_order",
        ownerId: target.id,
        bytes: file.bytes,
        mime: file.mime,
        filename: "receipt.jpg",
        createdBy: "owner",
      });
      const when = new Date(target.receivedAt ?? target.createdAt).toLocaleDateString("ru-RU", {
        day: "2-digit",
        month: "2-digit",
      });
      await tg.sendMessage(chatId, `🧾 Чек прикреплён к накладной от ${when} (${target.positions} поз.).`);
    } catch (err) {
      console.error("Чек владельца не обработан:", err);
      await tg
        .sendMessage(chatId, "⚠️ Чек не сохранился — отправь фото ещё раз через минуту.")
        .catch(() => undefined);
    }
  }

  // Утренний брифинг 07:30 Asia/Tashkent (FR-6)
  const sendOwnerBriefing = async (): Promise<void> => {
    const to = isoDate(new Date());
    const from = isoDate(new Date(Date.now() - 3 * 86_400_000));
    const yesterday = isoDate(new Date(Date.now() - 86_400_000));
    const [b, approvals, purchase, fillStatus, reconcile, washSchedule, globerent, staffActions, ruleNotes] = await Promise.all([
      deps.core.briefing(),
      // Согласования — деградируемый блок: их сбой не должен стоить владельцу
      // всего брифинга. Раньше он был обязательным, и одна ошибка в 07:30
      // оставляла владельца без сводки на сутки.
      deps.core.pendingApprovals().catch(() => []),
      deps.core.vendingPurchase().catch(() => null),
      deps.core.coffeeFillStatus().catch(() => null),
      deps.core.coffeeReconcileAll(from, to).catch(() => null),
      deps.core.coffeeWashScheduleStatus().catch(() => null),
      collectGloberentSignals(deps.core),
      // Сделанное сотрудниками за вчера — деградируемый блок: брифинг был
      // доской тревог и не показывал работу людей вовсе.
      deps.core.actions(yesterday, yesterday).catch(() => null),
      // Несрочные сигналы правил (усушка за порогом, заливка без записи,
      // «заканчивается товар»). Поллер берёт только immediate=1, поэтому до
      // П4 они не доходили до владельца НИ РАЗУ — копились в Core. Окно 26 ч,
      // с нахлёстом: доставленное Core отсечёт само, а провал между двумя
      // брифингами потерял бы сигнал навсегда.
      deps.core.briefingNotifications(new Date(Date.now() - 26 * 3_600_000)).catch(() => null),
    ]);
    const coffee =
      fillStatus || reconcile || washSchedule
        ? {
            underfill: fillStatus?.filter((r) => r.status === "underfill").length ?? 0,
            anomaly: reconcile?.reduce((n, g) => n + g.rows.filter((r) => r.reconcile.status === "anomaly").length, 0) ?? 0,
            overdueWash: washSchedule?.filter((r) => r.status === "overdue").length ?? 0,
          }
        : undefined;
    const briefingText = formatBriefing(
      b,
      approvals,
      purchase
        ? {
            positions: purchase.items.length,
            costRounded: purchase.costRounded,
            fromStock: purchase.totalFromStock,
          }
        : undefined,
      coffee,
      globerent,
    );
    const staffLine = staffActions ? summarizeActions(staffActions) : null;
    const notes = (ruleNotes?.notifications ?? [])
      .filter((n) => n.urgency === "briefing")
      .map((n) => ({ key: `${n.eventId}:${n.ruleId}`, text: n.text }));
    const text = [briefingText, formatBriefingNotes(notes), staffLine]
      .filter((part): part is string => typeof part === "string" && part !== "")
      .join("\n\n");
    // Ключ одноразовости ПЕРЕД отправкой — как у дайджеста сотрудников:
    // окно автодеплоя (два живых процесса) не должно слать два брифинга.
    if (!(await deps.core.claimNotification(`briefing:${to}`))) return;
    let доставлен = false;
    for (const chatId of allowlist) {
      // По-чатно: сбой одного чата не оставляет остальных без брифинга.
      try {
        await tg.sendMessage(chatId, text);
        доставлен = true;
      } catch (err) {
        console.error("Брифинг не доставлен в чат:", err);
      }
    }
    // Отметка о доставке — ПОСЛЕ отправки и только если дошло хотя бы одному:
    // иначе сигнал считался бы доставленным и утром больше не появился бы.
    if (доставлен && notes.length > 0) {
      await deps.core
        .ackNotifications(notes.map((n) => n.key))
        .catch((err: unknown) => console.error("Отметку о доставке сигналов не сохранить:", err));
    }
  };

  /**
   * Попытки с шагом в 5 минут: бот и Core на одном хосте передеплоиваются
   * автоматически, и совпадение рестарта Core с 07:30 реально. Одна попытка
   * означала «любой сбой = сутки без брифинга/дайджеста».
   */
  const withRetries = async (what: string, fn: () => Promise<void>, tries = 3): Promise<void> => {
    for (let attempt = 1; attempt <= tries; attempt++) {
      try {
        await fn();
        return;
      } catch (err) {
        console.error(`${what} (попытка ${attempt}/${tries}):`, err);
        if (attempt < tries) await new Promise((r) => setTimeout(r, 5 * 60_000));
      }
    }
  };

  const scheduleBriefing = (): void => {
    setTimeout(() => {
      void (async () => {
        await withRetries("Брифинг не отправлен", sendOwnerBriefing);
        scheduleBriefing();
      })();
    }, msUntilBriefing());
  };
  scheduleBriefing();

  /**
   * Утренний дайджест сотрудникам, 07:00 — раньше владельческого брифинга
   * (07:30): владелец должен видеть картину, зная, что люди её уже получили.
   *
   * Это единственный канал доставки СВОБОДНЫХ задач: sendReminders ходит по
   * ownerRef, а у свободной задачи его нет.
   */
  const sendStaffDigest = async (): Promise<void> => {
    const [people, free] = await Promise.all([
      deps.core.people(),
      deps.core.unassignedTasks().catch(() => []),
    ]);
    const linked = people.filter((p) => p.tgChatId && p.active === "yes");
    if (linked.length === 0) return;

    // Имена объектов — одним запросом на всю рассылку, а не на человека.
    const names = new Map((await deps.core.machines().catch(() => [])).map((m) => [m.id, m.name]));
    const dayKey = isoDate(new Date());

    for (const p of linked) {
      try {
        const mine = await deps.core.myTasks("human", p.id);
        const digest = buildDigest({ person: p, mine, free, objectNames: names });
        // Пустое «у тебя ноль задач» каждое утро приучает не читать дайджест.
        if (!digest) continue;
        // Ключ занимается ПЕРЕД отправкой: перезапуск бота в 07:00:30 не
        // должен слать второй раз. Цена — потерянный дайджест при падении
        // ровно между заявкой и отправкой; это лучше, чем два одинаковых.
        if (!(await deps.core.claimNotification(digestKey(dayKey, p.id)))) continue;
        await tg.sendMessage(Number(p.tgChatId), digest.text, digest.keyboard);
      } catch (err) {
        console.error(`Дайджест не доставлен (${p.name}):`, err);
      }
    }
  };

  const scheduleDigest = (): void => {
    setTimeout(() => {
      void (async () => {
        await withRetries("Дайджест сотрудникам не отправлен", sendStaffDigest);
        scheduleDigest();
      })();
    }, msUntilBriefing(new Date(), 7, 0));
  };
  scheduleDigest();

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

      // Доставка ИСПОЛНИТЕЛЮ и доставка ВЛАДЕЛЬЦУ считаются отдельно.
      //
      // Раньше был один флаг на двоих, и это теряло напоминания: если
      // сотрудник заблокировал бота, а владельцу просрочка дошла, задача
      // помечалась «напомнили» — и сотрудник не узнавал о ней НИКОГДА,
      // потому что markReminded ставится один раз навсегда.
      const needsAssignee = t.ownerKind === "human" && t.ownerRef !== null;
      let deliveredToAssignee = false;
      let deliveredToOwner = false;

      if (needsAssignee) {
        const chat = chatById.get(t.ownerRef!);
        if (chat !== undefined) {
          try {
            await tg.sendMessage(Number(chat), line, taskKeyboard(t));
            deliveredToAssignee = true;
          } catch (err) {
            // Заблокировал бота — сообщаем владельцу один раз и перестаём
            // пытаться. Задача при этом «напомненной» не считается.
            if (err instanceof TelegramError && err.isUnreachable) {
              await reportUnreachable(t.ownerRef!, err.description);
            } else {
              console.error("Напоминание исполнителю не доставлено:", err);
            }
          }
        }
      }

      // Владельцу — только о просроченном: он должен знать, что стоит.
      if (overdue) {
        for (const chatId of allowlist) {
          try {
            await tg.sendMessage(chatId, line);
            deliveredToOwner = true;
          } catch (err) {
            console.error("Напоминание владельцу не доставлено:", err);
          }
        }
      }

      // Помечаем напомненной, только если дошло до того, кто должен делать.
      // У задачи без исполнителя (свободной) единственный адресат — владелец.
      if (deliveredToAssignee || (!needsAssignee && deliveredToOwner)) {
        try {
          await deps.core.markReminded(t.id);
        } catch (err) {
          console.error("Отметка «напомнили» не записана:", err);
        }
      }
    }
  }

  /**
   * Сотрудник недоступен: заблокировал бота или удалил чат.
   *
   * Владельцу сообщаем один раз за день — иначе каждое напоминание в цикле
   * превращалось бы в отдельную жалобу. Ключ занимается в Core, поэтому
   * ограничение переживает перезапуск бота.
   */
  async function reportUnreachable(personId: string, reason: string): Promise<void> {
    try {
      const key = `staff-unreachable:${isoDate(new Date())}:${personId}`;
      if (!(await deps.core.claimNotification(key))) return;
      const people = await deps.core.people();
      const name = people.find((p) => p.id === personId)?.name ?? personId;
      for (const chatId of allowlist) {
        await tg.sendMessage(
          chatId,
          `🚫 ${name} не получает сообщения от бота (${reason}).\n` +
            "Задачи ему не доходят — нужно, чтобы он разблокировал бота и нажал «Старт».",
        );
      }
    } catch (err) {
      console.error("Владелец не уведомлён о недоступном сотруднике:", err);
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
        if (err instanceof TelegramError && err.isUnreachable) {
          // Иначе цикл долбит Telegram на каждом тике: задача остаётся
          // неотмеченной, а сотрудник недоступен всё это время.
          await reportUnreachable(t.ownerRef!, err.description);
          await deps.core.markRedoNotified(t.id).catch(() => undefined);
        } else {
          console.error("Сообщение о переделке не доставлено:", err);
        }
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
          // По-чатно: раньше сбой ПЕРВОГО чата не давал ack, и работающие
          // чаты получали то же срочное уведомление заново каждую минуту —
          // бесконечные дубли, а чаты после упавшего не получали ничего.
          // Ack — если дошло хотя бы одному владельцу.
          let deliveredAny = false;
          for (const chatId of allowlist) {
            try {
              await tg.sendMessage(chatId, text);
              deliveredAny = true;
            } catch (err) {
              console.error("Уведомление в чат не доставлено:", err);
            }
          }
          if (deliveredAny) delivered.push(key);
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

  /**
   * Один update из пачки.
   *
   * Ошибку не выпускаем в цикл опроса: offset сдвигается уже при ПОЛУЧЕНИИ
   * пачки (telegram.ts), и упавший update — например, answerCallback на
   * устаревшую кнопку («query is too old») или слишком длинный sendMessage —
   * иначе уносил бы с собой все необработанные соседние сообщения той же
   * пачки, включая полевые записи сотрудников. Навсегда: Telegram повторно
   * их не отдаст.
   */
  const processUpdate = async (u: TgUpdate): Promise<void> => {
    if (u.message?.photo && u.message.photo.length > 0) {
      // Фото — только полевая ветка, и только для тех, кто в ней сейчас.
      //
      // Барьер тут был обещан комментарием, но не написан: ветка стояла
      // первой в цепочке и не проверяла ни allowlist, ни режим. Владелец,
      // переслав боту накладную или скрин OurVend, попадал в полевой
      // разбор — а у его карточки бывает задача в работе, и снимок молча
      // уходил к ней «фото ДО». Текст и кнопки такой барьер имеют, фото
      // осталось без него.
      const photoChat = u.message.chat.id;
      if (!isAllowed(photoChat, allowlist) || asStaff.has(photoChat)) {
        await routeStaffPhoto(photoChat, u.message.photo);
      } else if (/(^|[\s,.!:;»")])чек(?=$|[\s,.!:;«("])/i.test(u.message.caption ?? "")) {
        // Граница слова руками (\b после кириллицы не работает): «чекушка» и
        // «чек-лист» — не команды прикрепления (найдено адверсариал-ревью).
        // Единственное фото, которое владелец шлёт в своём режиме, — чек с
        // базара (П3). Явная подпись вместо угадывания: без неё скрин OurVend
        // прилип бы к накладной так же молча, как раньше уходил в «фото ДО».
        await routeOwnerReceiptPhoto(photoChat, u.message.photo);
      } else {
        // Владельцу — не молчание: барьер #149 закрыл утечку фото в полевой
        // разбор, но вернул прежний симптом «бот проглотил фото».
        await tg
          .sendMessage(
            photoChat,
            "Фото в режиме владельца не обрабатываю. Чек закупа — пришли с подписью «чек»; полевые записи — включи «я сотрудник».",
          )
          .catch(() => undefined);
      }
    } else if (u.message?.text) {
      const chatId = u.message.chat.id;

      // «Побыть сотрудником»: владелец видит бота глазами полевого.
      //
      // Иначе проверить полевой поток нельзя вовсе — владелец идёт своей
      // веткой (сводки, согласования), и меню сотрудника ему не
      // показывается. Заводить второй аккаунт в Telegram ради проверки
      // того, что сам же и раздаёшь, — плохой обмен.
      //
      // Кнопки визарда и так проваливаются в ветку сотрудника, не хватало
      // только текста: нажатие кнопки меню — это обычное сообщение.
      //
      // Режим живёт в памяти процесса: после выката бот перезапускается и
      // владелец снова владелец. Для проверки это правильное поведение —
      // забыть выйти нельзя.
      if (isAllowed(chatId, allowlist) && asStaffMode(chatId, u.message.text, asStaff)) {
        await tg.sendMessage(
          chatId,
          asStaff.has(chatId)
            ? "Ты в режиме сотрудника — бот отвечает так, как увидят полевые. Обратно: «я владелец»."
            : "Вернул режим владельца.",
          asStaff.has(chatId) ? undefined : { remove_keyboard: true },
        );
        if (asStaff.has(chatId)) await routeStaffMessage(chatId, "/start", u.message.from?.username);
        return;
      }

      if (isAllowed(chatId, allowlist) && !asStaff.has(chatId)) {
        // Подключение сотрудника — мутация с состоянием, ловим до общего
        // обработчика: иначе «подключить» ушло бы в разбор намерений.
        if (isStaffAddTrigger(u.message.text)) {
          try {
            const r = await startStaffAdd(chatId, staffDeps);
            await tg.sendMessage(chatId, r.text, r.keyboard);
          } catch (err) {
            console.error("Подключение сотрудника не начато:", err);
            await tg.sendMessage(chatId, "Не удалось прочитать список сотрудников из Core.");
          }
          return;
        }
        const reply = await handleMessage(chatId, u.message.text, deps);
        if (reply) {
          await tg.sendMessage(chatId, reply.text, reply.keyboard);
          // Длинный ответ (план закупа) приходит частями: у Telegram предел на
          // одно сообщение, а резать список многоточием нельзя — обрезанный
          // маршрут читается как полный. Единственное место доставки Reply.
          //
          // Обрыв на середине молчать не имеет права: недоехавшие части
          // владелец прочитает как «маршрут кончился» и не довезёт товар.
          try {
            for (const part of reply.more ?? []) await tg.sendMessage(chatId, part);
          } catch (err) {
            console.error("Части ответа не отправлены:", err);
            await tg
              .sendMessage(chatId, "⚠️ Остальные части не дошли — повтори «план закупа».")
              .catch(() => undefined);
          }
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
      if (chatId === undefined) return;
      const data = u.callback_query.data;

      // Режим «побыть сотрудником» отключает владельческую ветку и здесь,
      // а не только у текста. Иначе фолбэк «эта кнопка устарела» ниже
      // съедает ЛЮБОЕ незнакомое нажатие вместе с `continue`, и кнопки
      // визарда (точка, бункер, цифры) до обработчика сотрудника не
      // доходят вовсе: меню открывается, а нажать в нём нельзя ничего.
      if (isAllowed(chatId, allowlist) && !asStaff.has(chatId)) {
        // Кнопки визарда подключения (sa:) — до согласований: у них
        // разные пространства, но проверить надо раньше фолбэка
        // «эта кнопка устарела».
        const sa = parseStaffAddCallback(data);
        if (sa) {
          try {
            const res = await handleStaffAddCallback(chatId, sa, staffDeps, botUsername);
            await tg.answerCallback(u.callback_query.id, res.answer);
            if (res.message) await tg.sendMessage(chatId, res.message.text, res.message.keyboard);
          } catch (err) {
            console.error("Кнопка подключения не сработала:", err);
            await tg.answerCallback(u.callback_query.id, "Не получилось, попробуй ещё раз");
          }
          return;
        }

        const parsed = parseApprovalCallback(data);
        if (!parsed) {
          // Неизвестная кнопка: молчание оставляет вечный спиннер —
          // выглядит как «кнопки не работают».
          await tg.answerCallback(u.callback_query.id, "Эта кнопка устарела");
          return;
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
        return;
      }

      // Кнопка от сотрудника: «Взял» / «Сделал» по своей задаче.
      const person = await personOf(chatId);
      if (person === "core-down") {
        // Сотрудник посреди визарда не должен быть неотличим от постороннего
        // из-за сетевого сбоя: без ответа кнопка «крутится» до таймаута и
        // выглядит сломанной.
        await tg.answerCallback(u.callback_query.id, "Сервер не отвечает — повтори через минуту");
        return;
      }
      if (person === null) return; // постороннему не отвечаем вовсе
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
  };

  // Опрос обновлений
  for (;;) {
    try {
      const updates = await tg.getUpdates();
      for (const u of updates) {
        try {
          await processUpdate(u);
        } catch (err) {
          console.error("Сообщение из пачки не обработано (пачка продолжена):", err);
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
