import { CoreUnavailable, coreText } from "../../../../lib/core";

/**
 * Выгрузка объединённого журнала файлом.
 *
 * Core наружу не смотрит — скачивание идёт через панель, как и у сырых строк.
 * Отдаём весь союз двух источников одной плоской таблицей: на заказ строка, на
 * поле две колонки (по источнику). Спорные значения видны рядом — разбирать их
 * удобнее в Excel, чем на экране.
 */
export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  // Та же пара, что и на экране: ra/rar — источник A, rb/rbr — источник B.
  const a = { source: url.searchParams.get("ra") ?? "gjvending", report: url.searchParams.get("rar") ?? "order_query" };
  const b = { source: url.searchParams.get("rb") ?? "vendinghub", report: url.searchParams.get("rbr") ?? "operating" };

  const path =
    `/raw/unify/${encodeURIComponent(a.source)}/${encodeURIComponent(a.report)}` +
    `/vs/${encodeURIComponent(b.source)}/${encodeURIComponent(b.report)}/export.csv`;

  let csv: string;
  try {
    csv = await coreText(path);
  } catch (err) {
    const detail = err instanceof CoreUnavailable ? err.detail : String(err);
    return new Response(`Выгрузка не получилась: ${detail}`, { status: 502 });
  }

  const day = new Date().toISOString().slice(0, 10);
  const name = `union_${a.source}_${b.source}_${day}.csv`;
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${name}"`,
      "Cache-Control": "no-store",
    },
  });
}
