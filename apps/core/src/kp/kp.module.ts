import { Module } from "@nestjs/common";
import { KpController } from "./kp.controller";

/** КП GLOBERENT: рендер DOCX по фирменному бланку (образцы владельца). */
@Module({
  controllers: [KpController],
})
export class KpModule {}
