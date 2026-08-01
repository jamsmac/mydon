import type { Response } from "express";
import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
  UploadedFile,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { IsIn, IsOptional, IsString, IsUUID, MaxLength } from "class-validator";
import { Public } from "../common/public.decorator";
import { AttachmentsService, type UploadedFile as UF } from "./attachments.service";

/** Куда привязать файл и что это. */
export class UploadDto {
  @IsString() @MaxLength(32)
  ownerType!: string;

  @IsUUID()
  ownerId!: string;

  @IsOptional() @IsIn(["photo", "receipt", "doc"])
  kind?: "photo" | "receipt" | "doc";

  @IsOptional() @IsString() @MaxLength(128)
  createdBy?: string;
}

/** Вложения: фото номенклатуры, чеки. Файл — в хранилище, метаданные — в БД. */
@Controller("attachments")
export class AttachmentsController {
  constructor(private readonly attachments: AttachmentsService) {}

  @Post()
  @UseInterceptors(FileInterceptor("file", { limits: { fileSize: 12 * 1024 * 1024 } }))
  upload(@UploadedFile() file: UF | undefined, @Body() dto: UploadDto) {
    return this.attachments.upload(dto, file);
  }

  /** Вложения записи (owner_type + owner_id) — для галереи карточки. */
  @Get()
  list(@Query("ownerType") ownerType: string, @Query("ownerId", ParseUUIDPipe) ownerId: string) {
    return this.attachments.ofOwner(ownerType, ownerId);
  }

  @Get(":id")
  meta(@Param("id", ParseUUIDPipe) id: string) {
    return this.attachments.meta(id);
  }

  /**
   * Отдать сам файл — для локального хранилища (у S3 ссылка presigned, и панель
   * ходит прямо в него). Открыт на чтение: панель кладёт это в `<img>`.
   */
  @Public()
  @Get(":id/raw")
  async raw(@Param("id", ParseUUIDPipe) id: string, @Res() res: Response) {
    const { bytes, mime } = await this.attachments.raw(id);
    if (mime) res.setHeader("Content-Type", mime);
    res.setHeader("Cache-Control", "private, max-age=3600");
    res.send(bytes);
  }

  @Delete(":id")
  async remove(@Param("id", ParseUUIDPipe) id: string) {
    await this.attachments.remove(id);
    return { ok: true };
  }
}
