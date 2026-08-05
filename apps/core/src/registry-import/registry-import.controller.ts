import { BadRequestException, Body, Controller, Get, Post } from "@nestjs/common";
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

  /** Отчёт: приходы, стоящие на договорах другой компании. Чтение открыто. */
  @Get("globerent/foreign-links")
  foreignLinks() {
    return this.service.foreignContractLinks();
  }

  /**
   * Снять названные чужие связки. Список приходит списком id, а не «снять всё»:
   * решение по каждой связке принимает владелец, инструмент только исполняет.
   */
  @Post("globerent/foreign-links/unlink")
  unlinkForeign(@Body() body: { flowIds?: unknown; actorRef?: string }) {
    if (!Array.isArray(body.flowIds)) {
      throw new BadRequestException("Нужен flowIds: список идентификаторов приходов");
    }
    return this.service.unlinkForeignContractLinks(
      body.flowIds.map((v) => String(v)),
      body.actorRef ?? "owner",
    );
  }
}
