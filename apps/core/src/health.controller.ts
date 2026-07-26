import { Controller, Get } from "@nestjs/common";
import { TZ } from "@mydon/shared";

@Controller("health")
export class HealthController {
  @Get()
  check(): { status: string; service: string; tz: string } {
    return { status: "ok", service: "mydon-core", tz: TZ };
  }
}
