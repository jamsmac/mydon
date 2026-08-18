import { Module } from "@nestjs/common";
import { ActionsService } from "./actions.service";
import { RegistryController } from "./registry.controller";
import { RegistryService } from "./registry.service";

@Module({
  controllers: [RegistryController],
  providers: [RegistryService, ActionsService],
  exports: [RegistryService, ActionsService],
})
export class RegistryModule {}
