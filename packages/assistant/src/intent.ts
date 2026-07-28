import { DOMAINS, type Domain } from "@mydon/shared";

/**
 * Разбор вопросов на естественном языке (ТЗ FR-4) — единый «мозг» для бота
 * и веб-панели. Бот и панель должны понимать вопрос одинаково; если логика
 * живёт в двух местах, они рано или поздно разойдутся.
 *
 * Это правила, а не модель: предсказуемо и работает без обращения к LLM.
 * Что не распознано — уходит в LLM-обработку на следующем шаге (kind: "unknown").
 */

export type Intent =
  | { kind: "briefing" }
  | { kind: "approvals" }
  | { kind: "overdue" }
  | { kind: "machines" }
  | { kind: "obligations"; domain: Domain }
  | { kind: "search"; query: string; domain?: Domain }
  | { kind: "recent" } // память: «что было», «что я решал»
  /** Готовый файл: Excel с дебиторкой, отчёт в Word и т.п. */
  | { kind: "report"; format: "xlsx" | "docx"; topic: "receivables" | "tasks"; domain?: Domain }
  | { kind: "help" }
  | { kind: "unknown"; text: string };

const DOMAIN_WORDS: Record<string, Domain> = {
  глоберент: "globerent",
  globerent: "globerent",
  хели: "globerent",
  heli: "globerent",
  погрузчик: "globerent",
  вендхаб: "vendhub",
  вендхаб24: "vendhub",
  vendhub: "vendhub",
  вендинг: "vendhub",
  автомат: "vendhub",
  кофе: "vendhub",
  личное: "personal",
  личный: "personal",
  personal: "personal",
};

function detectDomain(text: string): Domain | undefined {
  for (const [word, domain] of Object.entries(DOMAIN_WORDS)) {
    if (text.includes(word)) return domain;
  }
  return undefined;
}

export function parseIntent(raw: string): Intent {
  const text = raw.trim().toLowerCase();
  if (!text) return { kind: "unknown", text: raw };

  if (text === "/start" || text === "/help" || text.includes("что ты умеешь")) {
    return { kind: "help" };
  }
  if (text === "/briefing" || /(брифинг|сводк|что за ночь|доброе утро)/.test(text)) {
    return { kind: "briefing" };
  }
  if (text === "/approvals" || /(согласован|одобр|на подпис|требует решени)/.test(text)) {
    return { kind: "approvals" };
  }

  // Память: «что было», «что произошло», «что я решал», «история», «последнее»
  if (/(что было|что произошло|что я решал|истори|последн|недавн|журнал)/.test(text)) {
    return { kind: "recent" };
  }

  // Просьба о ФАЙЛЕ: «excel по дебиторке», «выгрузи в таблицу», «отчёт в ворде».
  // Проверяем раньше денежных правил: «excel по долгам» — это файл, а не сводка.
  if (/(excel|эксель|таблиц|xlsx|выгруз|файл|отчёт в|отчет в|word|ворд|docx)/.test(text)) {
    const format: "xlsx" | "docx" = /(word|ворд|docx)/.test(text) ? "docx" : "xlsx";
    const topic: "receivables" | "tasks" = /(задач|поручен)/.test(text) ? "tasks" : "receivables";
    const domain = detectDomain(text);
    return { kind: "report", format, topic, ...(domain ? { domain } : {}) };
  }

  // "долж" покрывает должен/должна/должны/задолженность; "долг" — долг/долги
  if (/(просроч|долг|задолж|долж)/.test(text)) {
    const domain = detectDomain(text);
    // «сколько должен <контрагент>» — это поиск по имени, а не общая просрочка
    const named = /(должен|должна|должны)\s+([a-zа-яё0-9«"'-]{3,})/i.exec(raw);
    if (named && named[2] && !DOMAIN_WORDS[named[2].toLowerCase()]) {
      return { kind: "search", query: named[2].replace(/[«»"']/g, ""), ...(domain ? { domain } : {}) };
    }
    return domain ? { kind: "obligations", domain } : { kind: "overdue" };
  }
  if (/(простаива|не работа|не продаёт|не продает|встал|офлайн)/.test(text)) {
    return { kind: "machines" };
  }
  if (/(обязательств|договор|счёт|счет)/.test(text)) {
    const domain = detectDomain(text) ?? "globerent";
    return { kind: "obligations", domain };
  }

  const search = /(?:статус|найд[иы]|покажи|что по)\s+(?:претензи[а-яё]*\s+к\s+)?(.{2,})/i.exec(raw);
  if (search && search[1]) {
    const domain = detectDomain(text);
    return { kind: "search", query: search[1].trim(), ...(domain ? { domain } : {}) };
  }

  return { kind: "unknown", text: raw };
}

/** Список доменов для подсказки пользователю. */
export const DOMAIN_HINT = DOMAINS.join(", ");
