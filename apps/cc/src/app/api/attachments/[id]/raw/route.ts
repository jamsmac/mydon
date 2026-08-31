import { CoreUnavailable, coreBytes } from "../../../../../lib/core";

/**
 * Типы, которые идут inline в `<img>` — зеркало INLINE_IMAGE_MIMES (ключей
 * IMAGE_EXT) в Core (apps/core/src/attachments). Замкнутый список, а не
 * префикс `image/`: SVG — тоже `image/*`, но при прямом переходе исполняет
 * вложенный скрипт на origin панели, и `nosniff` этому не мешает — тип
 * заявлен верно.
 */
const INLINE_IMAGE_MIMES: ReadonlySet<string> = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "image/heic",
]);

/**
 * Прокси картинки вложения из Core в браузер.
 *
 * Core наружу не открыт, а `<img>` грузится в браузере владельца — поэтому
 * байты идут через панель. Нужно только локальному хранилищу: у S3 ссылка
 * presigned и браузер ходит в него напрямую, минуя этот маршрут.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    return new Response("Плохой идентификатор", { status: 400 });
  }

  try {
    const { body, contentType } = await coreBytes(`/attachments/${id}/raw`);
    const type = contentType ?? "application/octet-stream";
    const headers: Record<string, string> = {
      "Content-Type": type,
      // Браузеру нельзя угадывать тип по содержимому: файл, попавший в
      // хранилище не картинкой, иначе исполнился бы как HTML на origin панели.
      "X-Content-Type-Options": "nosniff",
      // Приватно: фото номенклатуры видит только владелец за Tailscale.
      "Cache-Control": "private, max-age=3600",
    };
    // В `<img>` идут только картинки из замкнутого списка; всё прочее —
    // вложением, а не документом в том же origin. Параметры типа
    // (`;charset=...`) отбрасываем.
    if (!INLINE_IMAGE_MIMES.has(type.toLowerCase().split(";")[0].trim())) {
      headers["Content-Disposition"] = "attachment";
    }
    // Страховка второй линии: даже если строка с исполняемым типом (легаси до
    // белого списка в Core) уйдёт inline, `sandbox` запретит скрипты при
    // прямом переходе; показу в `<img>` заголовок не мешает.
    headers["Content-Security-Policy"] = "default-src 'none'; sandbox";
    return new Response(body, { headers });
  } catch (err) {
    const detail = err instanceof CoreUnavailable ? err.detail : String(err);
    return new Response(`Файл не отдать: ${detail}`, { status: 502 });
  }
}
