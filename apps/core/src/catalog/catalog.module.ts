import { Module } from "@nestjs/common";
import { DbModule } from "../db/db.module";
import { CatalogController } from "./catalog.controller";
import { CatalogService } from "./catalog.service";

/** Расчётные справочники GLOBERENT: ставки ТН ВЭД и БРВ (перенос PROMACH). */
@Module({
  imports: [DbModule],
  controllers: [CatalogController],
  providers: [CatalogService],
  exports: [CatalogService],
})
export class CatalogModule {}
