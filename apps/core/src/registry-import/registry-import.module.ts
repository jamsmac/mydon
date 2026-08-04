import { Module } from "@nestjs/common";
import { DbModule } from "../db/db.module";
import { RegistryImportController } from "./registry-import.controller";
import { RegistryImportService } from "./registry-import.service";

/** Импорт реестра GLOBERENT из рабочей книги владельца (см. service). */
@Module({
  imports: [DbModule],
  controllers: [RegistryImportController],
  providers: [RegistryImportService],
})
export class RegistryImportModule {}
