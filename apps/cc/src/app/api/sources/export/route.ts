import { CoreUnavailable, coreText } from "../../../../lib/core";

/**
 * Выгрузка сырых строк файлом.
 *
 * Core наружу не смотрит, поэтому скачивание идёт через панель. Отдаём ровно то,
 * что владелец видит на экране: те же фильтры, тот же порядок. Разбивка на
 * страницы при этом снимается — файл забирает всю отфильтрованную выборку.
 */
export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const source = url.searchParams.get("src") ?? "";
  const report = url.searchParams.get("rep") ?? "";
  if (!source || !report) {
    return new Response("Не указан источник или отчёт", { status: 400 });
  }

  // Фильтры и сортировку передаём как есть; страницы в файле не нужны.
  const params = new URLSearchParams();
  for (const [key, value] of url.searchParams) {
    if (key === "src" || key === "rep" || key === "page" || key === "size") continue;
    if (value.trim().length > 0) params.set(key, value);
  }

  const path =
    `/raw/report/${encodeURIComponent(source)}/${encodeURIComponent(report)}/export.csv` +
    (params.toString() ? `?${params.toString()}` : "");

  let csv: string;
  try {
    csv = await coreText(path);
  } catch (err) {
    const detail = err instanceof CoreUnavailable ? err.detail : String(err);
    return new Response(`Выгрузка не получилась: ${detail}`, { status: 502 });
  }

  const day = new Date().toISOString().slice(0, 10);
  const name = `${source}_${report}_${day}.csv`;
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${name}"`,
      "Cache-Control": "no-store",
    },
  });
}
