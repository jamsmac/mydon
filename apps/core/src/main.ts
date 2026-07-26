import "reflect-metadata";
import { ValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
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

  await app.listen(appConfig.port);
  console.log(`MYDON Core слушает :${appConfig.port} (TZ=${appConfig.tz})`);
}

void bootstrap();
