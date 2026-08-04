import { coreWriteHeaders } from "../../../lib/core";

const BASE = process.env.CORE_API_URL ?? "http://127.0.0.1:3001";

/**
 * Скачивание КП: форма панели → Core (с внутренним токеном) → DOCX в браузер.
 * Строки характеристик приходят текстом «Ярлык | Значение» построчно.
 */
export async function POST(req: Request): Promise<Response> {
  const form = await req.formData();
  const str = (name: string): string => String(form.get(name) ?? "").trim();

  const rows = str("rows")
    .split("\n")
    .map((line) => line.split("|"))
    .filter((parts) => parts.length >= 2 && parts[0]!.trim() !== "")
    .map((parts) => ({ label: parts[0]!.trim(), value: parts.slice(1).join("|").trim() }));

  const price = Number(str("priceWithVat").replace(/\s/g, "").replace(",", "."));
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Tashkent" });
  const date = /^\d{4}-\d{2}-\d{2}$/.test(str("date")) ? str("date") : today;
  const kpNo =
    str("kpNo") !== ""
      ? str("kpNo")
      : `КП-${date.slice(0, 4)}/${date.slice(5, 7)}${date.slice(8, 10)}-1`;

  const payload = {
    kpNo,
    date,
    tableTitle: str("tableTitle"),
    tagline: str("tagline") || undefined,
    aboutModel: str("aboutModel") || undefined,
    rows,
    priceWithVat: price,
  };

  let res: Response;
  try {
    res = await fetch(`${BASE}/kp/globerent`, {
      method: "POST",
      headers: coreWriteHeaders(),
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30000),
    });
  } catch (err) {
    return new Response(`Core недоступен: ${err instanceof Error ? err.message : String(err)}`, { status: 502 });
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return new Response(`КП не собралось: ${text || `HTTP ${res.status}`}`, { status: 502 });
  }
  return new Response(await res.arrayBuffer(), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "Content-Disposition": `attachment; filename="${encodeURIComponent(kpNo)}.docx"`,
    },
  });
}
