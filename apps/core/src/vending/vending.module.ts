import { Module } from "@nestjs/common";
import { ApprovalsModule } from "../approvals/approvals.module";
import { OurvendHealthService } from "../ourvend/ourvend-health.service";
import { OurvendParityService } from "../ourvend/ourvend-parity.service";
import { SyncStaleService } from "../ourvend/sync-stale.service";
import { AnalyticsService } from "./analytics.service";
import { ProductFiscalService } from "./product-fiscal.service";
import { RefillEventsService } from "./refill-events.service";
import { RefillService } from "./refill.service";
import { RetentionService } from "./retention.service";
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
 *
 * По той же причине здесь живёт и сторож застоя сбора (`SyncStaleService`,
 * П8a): он читает журнал прогонов вендинга и пишет событие — регистрируй его в
 * `OurvendModule`, и пара модулей снова стала бы циклической.
 *
 * Той же причиной здесь живёт и еженедельная ретенция (`RetentionService`,
 * П8b, R-P8b-7): она чистит `slot_snapshot`/`product_sale`/`machine_sale`
 * вендинга и журнал прогонов сбора OurVend — те же таблицы, что и сторож
 * застоя, из того же модуля.
 */
@Module({
  imports: [ApprovalsModule],
  controllers: [VendingController],
  providers: [
    VendingService,
    ProductFiscalService,
    RefillService,
    RefillEventsService,
    ShrinkageService,
    AnalyticsService,
    OurvendParityService,
    OurvendHealthService,
    SyncStaleService,
    RetentionService,
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
    SyncStaleService,
    RetentionService,
  ],
})
export class VendingModule {}
