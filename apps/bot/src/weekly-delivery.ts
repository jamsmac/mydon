import { pendingNotes } from "./briefing";
import type { PendingNotifications, PersonRow, WeeklyDigest } from "./core-client";
import {
  WEEKLY_NOTES_WINDOW_MS,
  formatWeeklyDigest,
  weeklyDigestKey,
  weeklyRecipients,
} from "./weekly-digest";

/**
 * Доставка недельной сводки: занять ключ → отправить → отметить сигналы.
 *
 * Живёт отдельным модулем, а не строчками внутри `index.ts`, ровно по одной
 * причине: каждый шаг здесь НЕОБРАТИМ. Занятый ключ второй раз не занять,
 * отмеченный сигнал Core больше не отдаст, а ошибка в порядке шагов не падает
 * и не логируется — она просто оставляет владельца без сводки или без
 * предупреждения, о котором он никогда не узнает. Такое проверяется тестами,
 * а протестировать можно только то, что вызывается из теста.
 *
 * ПОРЯДОК ШАГОВ, КОТОРЫЙ НЕЛЬЗЯ МЕНЯТЬ.
 *
 * 1. Ключ занимается ДО отправки. Автодеплой поднимает второй процесс, и в
 *    окне пересменки в понедельник 08:05:30 оба дошли бы до рассылки. Цена
 *    выбора — потерянная сводка при падении ровно между заявкой и отправкой;
 *    это лучше, чем две одинаковых (то же решение, что у дайджеста).
 * 2. Отправка — по ЧАТАМ, а не по карточкам: две карточки с одним
 *    `tg_chat_id` (владелец и он же менеджер) прислали бы две одинаковые
 *    сводки в один чат.
 * 3. `ack` — ПОСЛЕ отправки и только если сводка дошла хотя бы в один чат.
 */

/** Что доставке нужно от Core — ровно эти пять вызовов, не весь клиент. */
export interface WeeklyCore {
  vendingWeeklyDigest(week?: string): Promise<WeeklyDigest>;
  people(): Promise<PersonRow[]>;
  briefingNotifications(since: Date): Promise<PendingNotifications>;
  claimNotification(key: string): Promise<boolean>;
  ackNotifications(keys: string[]): Promise<{ acked: number }>;
}

/** Куда писать о сбоях. Инъекция — чтобы тест видел молчаливые отказы. */
export interface WeeklyLog {
  warn(message: string): void;
  error(message: string, err: unknown): void;
}

export interface WeeklyDeliveryDeps {
  core: WeeklyCore;
  /** Отправка одного сообщения в чат Telegram. */
  send(chatId: number, text: string): Promise<void>;
  log?: WeeklyLog;
}

export interface WeeklyDeliveryResult {
  week: string;
  /** Чатов-получателей после схлопывания дублей карточек. */
  chats: number;
  /** Чатов, куда сводка реально ушла. */
  delivered: number;
  /** Чатов, пропущенных по занятому ключу: на этой неделе им уже слали. */
  skipped: number;
  /** Сигналов правил, отмеченных доставленными. */
  acked: number;
}

const консоль: WeeklyLog = {
  warn: (m) => console.warn(m),
  error: (m, err) => console.error(m, err),
};

/**
 * Получатели, схлопнутые по чату: один чат — одна сводка.
 *
 * Значение — ВСЕ карточки этого чата: ключ доставки именной
 * (`weekly-digest:<неделя>:<personId>`, как у дайджеста сотрудников), и если
 * занять только ключ первой карточки, вторая на следующем прогоне сочтёт себя
 * неотправленной и пришлёт в тот же чат дубль.
 */
export function byChat(recipients: readonly PersonRow[]): Map<string, PersonRow[]> {
  const чаты = new Map<string, PersonRow[]>();
  for (const p of recipients) {
    const chat = (p.tgChatId ?? "").trim();
    if (chat === "") continue;
    чаты.set(chat, [...(чаты.get(chat) ?? []), p]);
  }
  return чаты;
}

/** Понедельничная рассылка сводки (R-P5b-7). Бросает, если Core не ответил. */
export async function deliverWeeklyDigest(deps: WeeklyDeliveryDeps): Promise<WeeklyDeliveryResult> {
  const log = deps.log ?? консоль;
  const [digest, people, pending] = await Promise.all([
    deps.core.vendingWeeklyDigest(),
    deps.core.people(),
    // Сигналы — деградируемый блок: их сбой не должен стоить всей сводки. Но
    // молчать о нём нельзя: недельный канал — ЕДИНСТВЕННАЯ доставка
    // `urgency:"weekly"`, и вечно падающий `/rules/pending` неотличим от
    // «сигналов нет».
    deps.core.briefingNotifications(new Date(Date.now() - WEEKLY_NOTES_WINDOW_MS)).catch((err: unknown) => {
      log.error("Недельные сигналы правил не получены из Core:", err);
      return null;
    }),
  ]);

  const { parts, shownKeys } = formatWeeklyDigest(digest, pendingNotes(pending, "weekly"));
  const чаты = byChat(weeklyRecipients(people));
  const итог: WeeklyDeliveryResult = { week: digest.week, chats: чаты.size, delivered: 0, skipped: 0, acked: 0 };

  if (чаты.size === 0) {
    // Молчать нельзя: пустой список получателей выглядит как исправная
    // рассылка, а на деле означает, что роли в карточках не проставлены и
    // сводку не получает НИКТО.
    log.warn(`Недельная сводка ${digest.week}: получателей нет — ни у кого нет роли owner/manager с чатом.`);
    return итог;
  }

  for (const [chat, люди] of чаты) {
    // Ключи ВСЕХ карточек чата занимаются до отправки (см. шаг 1 и `byChat`).
    // Заняли хоть один — сводка этому чату на этой неделе ещё не уходила.
    let свежий = false;
    for (const p of люди) {
      if (await deps.core.claimNotification(weeklyDigestKey(digest.week, p.id))) свежий = true;
    }
    if (!свежий) {
      итог.skipped += 1;
      continue;
    }
    try {
      for (const часть of parts) await deps.send(Number(chat), часть);
      итог.delivered += 1;
    } catch (err) {
      log.error(`Недельная сводка не доставлена (${люди.map((p) => p.name).join(", ")}):`, err);
    }
  }

  // Отметка — ПОСЛЕ отправки и только за показанные строки: отмеченное Core
  // не отдаст никогда (см. formatWeeklyDigest, правило 2).
  if (итог.delivered > 0 && shownKeys.length > 0) {
    try {
      await deps.core.ackNotifications(shownKeys);
      итог.acked = shownKeys.length;
    } catch (err) {
      log.error("Отметку недельных сигналов не сохранить:", err);
    }
  }
  return итог;
}
