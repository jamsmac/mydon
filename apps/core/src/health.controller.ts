import { Controller, Get } from "@nestjs/common";
import { TZ } from "@mydon/shared";
import { appConfig } from "./config";

@Controller("health")
export class HealthController {
  @Get()
  check(): { status: string; service: string; tz: string; tzExpected: string; tzOk: boolean } {
    // Отдаём ФАКТИЧЕСКИЙ пояс процесса: раньше здесь стояла константа,
    // и проверка здоровья рапортовала «Asia/Tashkent» даже когда процесс жил в UTC.
    const tz = appConfig.tz;
    return {
      status: "ok",
      service: "mydon-core",
      tz,
      tzExpected: TZ,
      tzOk: tz === TZ,
    };
  }
}
