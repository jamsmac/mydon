import { writeFile } from "node:fs/promises";
import { NextResponse } from "next/server";

/**
 * Приёмник разовых выгрузок ИЗ БРАУЗЕРА в файл — только для локальной работы.
 *
 * Зачем: вытащить объём данных со страницы стороннего ПО (рецепты, справочники)
 * через инструмент, который обрезает длинные ответы, невозможно; буфер обмена
 * из фонового скрипта запрещён. Поэтому страница шлёт JSON сюда, а он ложится
 * файлом рядом с проектом.
 *
 * Живёт ТОЛЬКО в разработке: в прод-сборке маршрут отвечает 404. Это не часть
 * продукта, а инструмент переноса.
 */
export async function POST(req: Request): Promise<NextResponse> {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const name = new URL(req.url).searchParams.get("name") ?? "dump";
  if (!/^[a-z0-9_-]{1,64}$/i.test(name)) {
    return NextResponse.json({ error: "bad name" }, { status: 400 });
  }
  const body = await req.text();
  const path = `/tmp/mydon-catch-${name}.json`;
  await writeFile(path, body, "utf8");
  return NextResponse.json({ ok: true, bytes: body.length, path });
}

export async function OPTIONS(): Promise<NextResponse> {
  return NextResponse.json(
    {},
    {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    },
  );
}
