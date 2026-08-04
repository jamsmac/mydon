import { coreBytes, CoreUnavailable } from "../../../../lib/core";

/**
 * Скачивание DOCX договора: браузер ходит на панель, панель — в Core
 * (Core наружу не смотрит — тот же паттерн, что у вложений).
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  try {
    const { body, contentType } = await coreBytes(`/contracts/${encodeURIComponent(id)}/docx`);
    return new Response(body, {
      headers: {
        "Content-Type":
          contentType ?? "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "Content-Disposition": `attachment; filename="Dogovor_${encodeURIComponent(id)}.docx"`,
      },
    });
  } catch (err) {
    const detail = err instanceof CoreUnavailable ? err.detail : String(err);
    return new Response(`Документ не собрался: ${detail}`, { status: 502 });
  }
}
