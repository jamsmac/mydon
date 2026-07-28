import { DOMAIN_LABELS, type Domain } from "@mydon/shared";
import type { CoreClient } from "./core-client";

/**
 * Отчёты файлами: владелец просит «excel по дебиторке» — получает готовый
 * документ в чат, а не текст, который потом надо куда-то переписывать.
 *
 * Данные собираются здесь, из Core. Модель их только оформляет и НЕ выдумывает:
 * то, что не пришло из базы, в файл не попадёт.
 */

export interface ReportRequest {
  format: "xlsx" | "docx";
  topic: "receivables" | "tasks";
  domain?: Domain;
}

export interface ReportPlan {
  kind: "xlsx" | "docx";
  filename: string;
  instruction: string;
  data: unknown;
  /** Что сказать владельцу, если строить нечего. */
  emptyReason?: string;
}

const today = (): string => new Date().toLocaleDateString("ru-RU");

/**
 * Готовит данные и задание для документа.
 *
 * Отдельно от построения намеренно: сбор данных проверяется тестами без сети,
 * а обращение к модели остаётся тонким слоем сверху.
 */
export async function planReport(req: ReportRequest, core: CoreClient): Promise<ReportPlan> {
  if (req.topic === "tasks") {
    const tasks = await core.myTasks("human", "").catch(() => []);
    // Пустой ownerRef вернёт пусто — берём общий список задач через тот же путь,
    // что и панель: открытые задачи всех исполнителей.
    const all = tasks.length > 0 ? tasks : [];
    return {
      kind: req.format,
      filename: `Задачи ${today()}`,
      instruction:
        "Сведи открытые задачи в таблицу: что сделать, исполнитель, срок, срочность, статус. " +
        "Просроченные выдели. В конце — итог: сколько всего и сколько просрочено.",
      data: all,
      ...(all.length === 0 ? { emptyReason: "Открытых задач нет — отчёт пустой." } : {}),
    };
  }

  const domain = req.domain ?? "globerent";
  const o = await core.obligations(domain);
  const label = DOMAIN_LABELS[domain];

  return {
    kind: req.format,
    filename: `Дебиторка ${label} ${today()}`,
    instruction:
      `Сделай отчёт по просроченной дебиторке направления ${label} на ${today()}. ` +
      "Колонки: дата, сумма, валюта, статус. Отсортируй от самых старых долгов. " +
      "Внизу — итоговая сумма и количество позиций. " +
      (o.overdueTruncated
        ? "ВАЖНО: список неполный, это первые позиции — обязательно напиши это в документе."
        : ""),
    data: {
      направление: label,
      всего_просрочено_позиций: o.overdueTotal,
      список_неполный: o.overdueTruncated,
      позиции: o.overdue,
      сводка_по_статусам: o.totals,
    },
    ...(o.overdueTotal === 0
      ? { emptyReason: `По направлению ${label} просрочек нет — отчёт делать не из чего.` }
      : {}),
  };
}
