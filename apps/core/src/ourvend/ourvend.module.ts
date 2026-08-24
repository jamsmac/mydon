import { Module } from "@nestjs/common";
import { OurvendController } from "./ourvend.controller";
import { OurvendParityService } from "./ourvend-parity.service";
import { OurvendSnapshotService } from "./ourvend-snapshot.service";

@Module({
  controllers: [OurvendController],
  providers: [OurvendSnapshotService, OurvendParityService],
  exports: [OurvendSnapshotService],
})
export class OurvendModule {}
