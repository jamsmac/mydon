import { Controller, Get } from "@nestjs/common";
import { TZ } from "@mydon/shared";
import { appConfig } from "./config";

@Controller("health")
export class HealthController {
  @Get()
  check(): {
    status: string;
    service: string;
    commit: string;
    tz: string;
    tzExpected: string;
    tzOk: boolean;
  } {
    // Отдаём ФАКТИЧЕСКИЙ пояс процесса: раньше здесь стояла константа,
    // и проверка здоровья рапортовала «Asia/Tashkent» даже когда процесс жил в UTC.
    const tz = appConfig.tz;
    return {
      status: "ok",
      service: "mydon-core",
      // Коммит РАБОТАЮЩЕГО образа, зашитый при сборке. Тот же урок, что и с
      // поясом ниже: отвечать фактом, а не намерением. Каталог на сервере
      // обновляется `git pull` за секунды, а пересборка идёт минуты — и всё
      // это время «выкачено» и «работает» расходятся.
      commit: process.env.GIT_SHA ?? "unknown",
      tz,
      tzExpected: TZ,
      tzOk: tz === TZ,
    };
  }
}
