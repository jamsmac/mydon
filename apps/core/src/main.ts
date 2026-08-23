import "reflect-metadata";
import { ValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { NextFunction, Request, Response } from "express";
import { json } from "express";
import { AppModule } from "./app.module";
import { PgExceptionFilter } from "./common/pg-exception.filter";
import { appConfig } from "./config";

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true, // отбрасываем поля, которых нет в DTO
      forbidNonWhitelisted: true, // и явно ругаемся на них
      transform: true,
    }),
  );

  // Ошибки данных от СУБД превращаем в 400, а не в загадочный 500.
  app.useGlobalFilters(new PgExceptionFilter());

  /**
   * Тело запроса ограничиваем: без лимита большой JSON съест память процесса.
   *
   * Лимит поднят с 1mb до 4mb ИЗ-ЗА ИМПОРТА БАНКОВСКОЙ ВЫПИСКИ (срез К, задача
   * 4, `POST /finance/bank-statement`) — это самый крупный законный payload
   * сервиса. Живая выписка `AccReferenceReport20260821223037.xlsx`
   * (2440 строк, 01.2025–08.2026) даёт JSON-тело **915 703 байта — 87% старого
   * лимита в 1 МБ**, уже сегодня. Выписка растёт ~120 строк/~45 КБ в месяц —
   * через пару месяцев после проверки (22.08.2026) старый лимит был бы
   * превышен, и импорт, который владелец делает РАЗ В МЕСЯЦ, начал бы падать
   * 413 на проде, без репетиции. Сервис внутренний (Tailscale + SERVICE_TOKEN,
   * наружу не открыт) — 4 МБ дают запас на годы вперёд, а не только до конца
   * 2026-го.
   *
   * Разбиение импорта на порции сознательно НЕ делаем: с ключом идемпотентности
   * `extId` это было бы безопасно, но добавляет цикл, прогресс в интерфейсе и
   * частичный отказ посреди пачки — сложность, которой не стоит ручное
   * действие раз в месяц.
   */
  app.use(json({ limit: "4mb" }));

  /**
   * body-parser (express.json) при превышении лимита кидает ошибку ДО того,
   * как запрос доходит до контроллера — значит и до `PgExceptionFilter`, и до
   * лимита в 3000 строк на DTO (он проверяется уже ПОСЛЕ успешного разбора
   * тела). Без этого перехватчика клиент получил бы голый текст/HTML
   * `PayloadTooLargeError` из недр Express, а не понятный JSON-отказ в стиле
   * остального API. Явная проверка вместо теста: `main.ts` — код запуска
   * процесса, не тестируемый модуль (в проекте нет ни одного теста на
   * bootstrap), а поднять реальный HTTP-сервер ради одного edge-case дороже,
   * чем эта заметная, читаемая проверка на месте.
   */
  app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    const withStatus = err as { status?: number; statusCode?: number; type?: string } | null;
    const isPayloadTooLarge =
      withStatus !== null &&
      typeof withStatus === "object" &&
      (withStatus.status === 413 ||
        withStatus.statusCode === 413 ||
        withStatus.type === "entity.too.large");
    if (!isPayloadTooLarge) {
      next(err);
      return;
    }
    res.status(413).json({
      statusCode: 413,
      message:
        "Тело запроса слишком велико (лимит 4 МБ). Похоже на банковскую выписку или другой крупный импорт — " +
        "разбейте файл на части или обратитесь к администратору, если это не так.",
      error: "Payload Too Large",
    });
  });

  app.enableShutdownHooks();

  await app.listen(appConfig.port);
  console.log(`MYDON Core слушает :${appConfig.port} (TZ=${appConfig.tz})`);
  if (!appConfig.serviceToken) {
    console.warn(
      "ВНИМАНИЕ: SERVICE_TOKEN не задан — ВСЕ мутации Core (POST/PATCH/PUT/DELETE) " +
        "будут отклонены 401 (fail-closed). Задайте его в .env ОДНОВРЕМЕННО в Core, " +
        "CC, боте и агентах.",
    );
  }
}

void bootstrap();
