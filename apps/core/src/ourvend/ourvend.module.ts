import { Module } from "@nestjs/common";
import { VendingModule } from "../vending/vending.module";
import { OurvendController } from "./ourvend.controller";
import { OurvendSnapshotService } from "./ourvend-snapshot.service";

@Module({
  // Паритет остатков спрашивает у реестра, какие автоматы не в строю: второй
  // реализацией «склад или ремонт» гейт разошёлся бы с планом закупа. Сами
  // `OurvendParityService` и `OurvendHealthService` живут в `VendingModule` —
  // почему именно так, сказано в его шапке; сюда они приезжают импортом.
  imports: [VendingModule],
  controllers: [OurvendController],
  providers: [OurvendSnapshotService],
  exports: [OurvendSnapshotService],
})
export class OurvendModule {}
