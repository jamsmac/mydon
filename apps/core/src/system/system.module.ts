import { Module } from "@nestjs/common";
import { SystemOwnerGuard } from "../common/system-owner.guard";
import { VendingModule } from "../vending/vending.module";
import { RetentionController } from "./retention.controller";
import { SystemController } from "./system.controller";
import { SystemService } from "./system.service";

@Module({
  // Правка порога из панели обязана гасить кеш отчётов — иначе «сохранено» и
  // «посчитано по этому числу» расходятся на пять минут (см. `SystemController.set`).
  // Зависимость односторонняя: вендинг читает настройки функцией `settingValue`,
  // а не сервисом, поэтому цикла модулей здесь нет.
  imports: [VendingModule],
  // `RetentionController` живёт здесь, а не в вендинге: путь `system/*`, а
  // чистит ретенция и снимки, и продажи, и журнал прогонов. Сам сервис —
  // провайдер `VendingModule` и оттуда экспортирован.
  controllers: [SystemController, RetentionController],
  // `SystemOwnerGuard` — второй пояс owner-действий на PUT /system/config[/llm-profile];
  // регистрируем как провайдера, чтобы Nest резолвил его через DI (как OwnerMutationGuard).
  providers: [SystemService, SystemOwnerGuard],
  exports: [SystemService],
})
export class SystemModule {}
