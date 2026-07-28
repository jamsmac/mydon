/**
 * web — чтение страниц сайтов, откуда MYDON берёт данные.
 *
 * Зачем: владелец решил НЕ грузить старую базу — данные будут только новые,
 * и брать их система должна сама с сайтов, куда владелец даст доступ.
 *
 * Здесь только доставка и очистка текста. Понимание (что на странице —
 * контрагенты, техника, цены) делает LLM-слой на стороне вызывающего:
 * коннектор не должен зависеть от модели.
 *
 * Доступ к закрытым страницам — заголовками (cookie, авторизация), которые
 * передаёт владелец. Сами значения нигде не сохраняются и не печатаются.
 */

export interface FetchPageOptions {
  /** Дополнительные заголовки: Cookie, Authorization — для закрытых страниц. */
  headers?: Record<string, string>;
  timeoutMs?: number;
  /** Предохранитель: страница больше лимита обрезается, а не съедает память. */
  maxBytes?: number;
}

export interface FetchedPage {
  url: string;
  status: number;
  /** Очищенный текст страницы — без скриптов, стилей и разметки. */
  text: string;
  /** Страница была больше лимита и обрезана. */
  truncated: boolean;
}

/**
 * HTML → читаемый текст.
 *
 * Без внешних библиотек: скрипты и стили выбрасываются целиком, теги — в
 * пробелы, сущности — в символы. Для извлечения данных моделью этого
 * достаточно, а зависимость на целый парсер не нужна.
 */
export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    // Закрытие блочных тегов — перенос строки: структура таблиц и списков
    // важна для извлечения (строка = запись).
    .replace(/<\/(tr|p|div|li|h[1-6]|table|section)>/gi, "\n")
    .replace(/<(td|th)[^>]*>/gi, " | ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
}

/** Загрузка страницы с таймаутом и потолком размера. */
export async function fetchPage(url: string, opts: FetchPageOptions = {}): Promise<FetchedPage> {
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const maxBytes = opts.maxBytes ?? 2_000_000;

  const res = await fetch(url, {
    headers: {
      // Только латиница: HTTP-заголовки не принимают других символов.
      "User-Agent": "MYDON/1.0 (owner-authorized data collection)",
      ...(opts.headers ?? {}),
    },
    redirect: "follow",
    signal: AbortSignal.timeout(timeoutMs),
  });

  const raw = await res.text();
  const truncated = raw.length > maxBytes;
  const html = truncated ? raw.slice(0, maxBytes) : raw;

  return {
    url,
    status: res.status,
    text: htmlToText(html),
    truncated,
  };
}

export const web = {
  name: "web",
  status: "live" as const,
  note: "Чтение страниц сайтов: доставка и очистка текста. Понимание — за LLM-слоем.",
  fetchPage,
  htmlToText,
};
