import "reflect-metadata";
import { ValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
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

  // Тело запроса ограничиваем: без лимита большой JSON съест память процесса.
  app.use(json({ limit: "1mb" }));

  await app.listen(appConfig.port);
  console.log(`MYDON Core слушает :${appConfig.port} (TZ=${appConfig.tz})`);
  if (!appConfig.serviceToken) {
    console.warn(
      "ВНИМАНИЕ: SERVICE_TOKEN не задан — мутации Core открыты, защита держится " +
        "только на сети (Docker/Tailscale). Задайте его в .env и клиентам.",
    );
  }
}

void bootstrap();
