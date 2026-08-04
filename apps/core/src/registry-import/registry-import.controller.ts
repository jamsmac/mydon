import { Body, Controller, Post } from "@nestjs/common";
import { RegistryImportService, type ImportPayload } from "./registry-import.service";

/**
 * Импорт реестра GLOBERENT из книги владельца. Мутация — закрыта общим
 * ServiceTokenGuard; гоняется импортёром tools/import-globerent-registry.mjs
 * партиями (лимит тела запроса 1 МБ).
 */
@Controller("registry-import")
export class RegistryImportController {
  constructor(private readonly service: RegistryImportService) {}

  @Post("globerent")
  importGloberent(@Body() body: ImportPayload & { actorRef?: string }) {
    const { actorRef, ...payload } = body;
    return this.service.importGloberent(payload, actorRef ?? "owner");
  }
}
