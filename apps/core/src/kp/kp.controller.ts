import { BadRequestException, Body, Controller, Header, Post, Res, StreamableFile } from "@nestjs/common";
import type { Response } from "express";
import { renderKpGloberent, type KpGloberentInput } from "./kp-globerent";

/**
 * Генерация КП по фирменному бланку GLOBERENT (по реальным образцам владельца).
 * POST: вход большой (характеристики), рендер без побочных эффектов;
 * мутационный guard с токеном — уместная дверь для генерации документов.
 */
@Controller("kp")
export class KpController {
  /** DOCX КП. Тело — KpGloberentInput. */
  @Post("globerent")
  @Header("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document")
  async render(@Body() body: Partial<KpGloberentInput>, @Res({ passthrough: true }) res: Response) {
    if (typeof body.kpNo !== "string" || typeof body.date !== "string") {
      throw new BadRequestException("Нужны номер (kpNo) и дата (date) КП");
    }
    if (typeof body.tableTitle !== "string" || !Array.isArray(body.rows)) {
      throw new BadRequestException("Нужны заголовок таблицы и строки характеристик");
    }
    if (typeof body.priceWithVat !== "number") {
      throw new BadRequestException("Цена с НДС — число");
    }
    let buffer: Buffer;
    try {
      buffer = await renderKpGloberent(body as KpGloberentInput);
    } catch (err) {
      throw new BadRequestException(err instanceof Error ? err.message : "КП не собралось");
    }
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${encodeURIComponent(`${body.kpNo}.docx`)}"`,
    );
    return new StreamableFile(buffer);
  }
}
