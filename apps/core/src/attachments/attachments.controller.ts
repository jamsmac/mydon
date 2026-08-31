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
import { IsIn, IsOptional, IsString, IsUUID, Matches, MaxLength } from "class-validator";
import { Public } from "../common/public.decorator";
import {
  ATTACHMENT_STAGES,
  AttachmentsService,
  INLINE_IMAGE_MIMES,
  type AttachmentStage,
  type UploadedFile as UF,
} from "./attachments.service";

/**
 * Картинку показываем в `<img>`, всё прочее отдаём вложением.
 *
 * Сверяем с замкнутым списком, а не с префиксом `image/`: SVG — тоже
 * `image/*`, но при прямом переходе исполняет вложенный скрипт, и `nosniff`
 * не спасает — тип заявлен верно. Параметры (`;charset=...`) отбрасываем.
 */
export function isImageMime(mime: string | null): boolean {
  if (mime === null) return false;
  return INLINE_IMAGE_MIMES.has(mime.toLowerCase().split(";")[0].trim());
}

/** Куда привязать файл и что это. */
export class UploadDto {
  // Тип владельца попадает в ключ файла в хранилище, а ключ — в путь на диске.
  // Поэтому закрытый шаблон, а не свободная строка: «../» в типе писало бы файл
  // мимо тома.
  @IsString()
  @Matches(/^[a-z][a-z0-9_]{0,31}$/, {
    message:
      "ownerType: латиница в нижнем регистре, цифры и подчёркивание, до 32 символов (например vending_purchase_order)",
  })
  ownerType!: string;

  @IsUUID()
  ownerId!: string;

  @IsOptional() @IsIn(["photo", "receipt", "doc"])
  kind?: "photo" | "receipt" | "doc";

  @IsOptional() @IsString() @MaxLength(128)
  createdBy?: string;

  /** В какой момент снято. Незнакомое значение отвергаем здесь, а не в БД. */
  @IsOptional() @IsIn([...ATTACHMENT_STAGES])
  stage?: AttachmentStage;
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

  /**
   * Вложения многих записей одним запросом (очередь утверждения).
   *
   * Стоит ВЫШЕ маршрута `:id` — иначе «batch» ушло бы в него как в
   * идентификатор и упало бы на разборе UUID.
   */
  @Get("batch")
  batch(@Query("ownerType") ownerType: string, @Query("ids") ids?: string) {
    const list = (ids ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    return this.attachments.ofOwners(ownerType, list);
  }

  @Get(":id")
  meta(@Param("id", ParseUUIDPipe) id: string) {
    return this.attachments.meta(id);
  }

  /**
   * Отдать сам файл — для локального хранилища (у S3 ссылка presigned, и панель
   * ходит прямо в него). Открыт на чтение: панель кладёт это в `<img>`.
   *
   * `nosniff` — всегда: браузеру нельзя угадывать тип по содержимому, иначе
   * файл, принятый как картинка, исполнился бы как HTML на origin панели. Всё,
   * что не картинка из замкнутого списка, отдаём вложением, а не документом в
   * том же origin. CSP `sandbox` — страховка второй линии: даже если строка с
   * исполняемым типом (легаси до белого списка) уйдёт inline, скрипты в ней
   * при прямом переходе не выполнятся; показу в `<img>` заголовок не мешает.
   */
  @Public()
  @Get(":id/raw")
  async raw(@Param("id", ParseUUIDPipe) id: string, @Res() res: Response) {
    const { bytes, mime } = await this.attachments.raw(id);
    if (mime) res.setHeader("Content-Type", mime);
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (!isImageMime(mime)) res.setHeader("Content-Disposition", "attachment");
    res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
    res.setHeader("Cache-Control", "private, max-age=3600");
    res.send(bytes);
  }

  @Delete(":id")
  async remove(@Param("id", ParseUUIDPipe) id: string) {
    await this.attachments.remove(id);
    return { ok: true };
  }
}
