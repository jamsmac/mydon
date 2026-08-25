import { Module } from "@nestjs/common";
import { ApprovalsModule } from "../approvals/approvals.module";
import { OurvendHealthService } from "../ourvend/ourvend-health.service";
import { OurvendParityService } from "../ourvend/ourvend-parity.service";
import { AnalyticsService } from "./analytics.service";
import { RefillEventsService } from "./refill-events.service";
import { RefillService } from "./refill.service";
import { ShrinkageService } from "./shrinkage.service";
import { VendingController } from "./vending.controller";
import { VendingService } from "./vending.service";
import { WeeklyDigestService } from "./weekly-digest.service";

/**
 * ПОЧЕМУ ПАРИТЕТ И ЗДОРОВЬЕ СБОРА OURVEND ЖИВУТ ЗДЕСЬ, А НЕ В `OurvendModule`.
 *
 * Зависимости идут в одну сторону: `OurvendModule` (приём снапшотов кабинета)
 * спрашивает у вендинга реестр автоматов, а недельная сводка вендинга
 * спрашивает у здоровья сбора его состояние. Оставь оба сервиса в
 * `OurvendModule` — и модули начали бы импортировать друг друга, что в Nest
 * лечится только `forwardRef`; в этом репозитории его нет ни разу, и заводить
 * циклическую пару ради двух провайдеров — плохой размен. Оба сервиса про
 * автоматы, поэтому их дом — вендинг, а `OurvendModule` берёт их отсюда.
 */
@Module({
  imports: [ApprovalsModule],
  controllers: [VendingController],
  providers: [
    VendingService,
    RefillService,
    RefillEventsService,
    ShrinkageService,
    AnalyticsService,
    OurvendParityService,
    OurvendHealthService,
    WeeklyDigestService,
  ],
  exports: [
    VendingService,
    RefillService,
    RefillEventsService,
    ShrinkageService,
    AnalyticsService,
    OurvendParityService,
    OurvendHealthService,
  ],
})
export class VendingModule {}
