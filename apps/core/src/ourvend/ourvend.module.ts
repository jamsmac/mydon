import { Module } from "@nestjs/common";
import { VendingModule } from "../vending/vending.module";
import { OurvendController } from "./ourvend.controller";
import { OurvendParityService } from "./ourvend-parity.service";
import { OurvendSnapshotService } from "./ourvend-snapshot.service";

@Module({
  // Паритет остатков спрашивает у реестра, какие автоматы не в строю: второй
  // реализацией «склад или ремонт» гейт разошёлся бы с планом закупа.
  imports: [VendingModule],
  controllers: [OurvendController],
  providers: [OurvendSnapshotService, OurvendParityService],
  exports: [OurvendSnapshotService],
})
export class OurvendModule {}
