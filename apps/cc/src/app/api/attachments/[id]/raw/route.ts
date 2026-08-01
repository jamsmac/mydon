import { CoreUnavailable, coreBytes } from "../../../../../lib/core";

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
    return new Response(body, {
      headers: {
        "Content-Type": contentType ?? "application/octet-stream",
        // Приватно: фото номенклатуры видит только владелец за Tailscale.
        "Cache-Control": "private, max-age=3600",
      },
    });
  } catch (err) {
    const detail = err instanceof CoreUnavailable ? err.detail : String(err);
    return new Response(`Файл не отдать: ${detail}`, { status: 502 });
  }
}
