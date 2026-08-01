import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { attachment } from "@mydon/db";
import { and, desc, eq, inArray } from "drizzle-orm";
import { DB, type Db } from "../db/db.module";
import { StorageService } from "./storage.service";

type AttachmentRow = typeof attachment.$inferSelect;

/** Файл к загрузке: то, что отдаёт FileInterceptor (нужные поля). */
export interface UploadedFile {
  buffer: Buffer;
  mimetype: string;
  size: number;
  originalname: string;
}

/** Метаданные вложения со ссылкой на файл. */
export interface AttachmentMeta {
  id: string;
  ownerType: string;
  ownerId: string;
  kind: string;
  mime: string | null;
  bytes: number | null;
  url: string;
  createdAt: string;
}

/** Разрешённые типы фото — чтобы не превращать хранилище в свалку. */
const IMAGE_EXT: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/heic": ".heic",
};

@Injectable()
export class AttachmentsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly storage: StorageService,
  ) {}

  /** Загрузить файл, привязать к записи. Фото проверяем на тип изображения. */
  async upload(
    input: { ownerType: string; ownerId: string; kind?: string; createdBy?: string },
    file: UploadedFile | undefined,
  ): Promise<AttachmentMeta> {
    if (!file || file.size === 0) throw new BadRequestException("Файл не получен");
    const kind = input.kind ?? "photo";
    const ext = IMAGE_EXT[file.mimetype.toLowerCase()];
    if (kind === "photo" && ext === undefined) {
      throw new BadRequestException(`Не изображение: ${file.mimetype}`);
    }
    const key = this.storage.keyFor(input.ownerType, input.ownerId, ext ?? "");
    await this.storage.put(key, file.buffer, file.mimetype);

    const [row] = await this.db
      .insert(attachment)
      .values({
        ownerType: input.ownerType,
        ownerId: input.ownerId,
        kind,
        storageKey: key,
        mime: file.mimetype,
        bytes: file.size,
        createdBy: input.createdBy ?? "owner",
      })
      .returning();
    return this.toMeta(row);
  }

  /** Вложения записи — для галереи в карточке. */
  async ofOwner(ownerType: string, ownerId: string): Promise<AttachmentMeta[]> {
    const rows = await this.db
      .select()
      .from(attachment)
      .where(and(eq(attachment.ownerType, ownerType), eq(attachment.ownerId, ownerId)))
      .orderBy(desc(attachment.createdAt));
    return Promise.all(rows.map((r) => this.toMeta(r)));
  }

  /**
   * Вложения многих записей одним запросом — для очереди утверждения.
   *
   * Очередь показывает пачку черновиков сразу с их фото. Ходить в хранилище по
   * одной карточке — тот же лишний труд, от которого уводит весь проект: берём
   * все вложения набора одним запросом и раскладываем по владельцам.
   */
  async ofOwners(ownerType: string, ownerIds: string[]): Promise<Record<string, AttachmentMeta[]>> {
    const ids = [...new Set(ownerIds)].filter((s) => s.length > 0);
    if (ids.length === 0) return {};
    const rows = await this.db
      .select()
      .from(attachment)
      .where(and(eq(attachment.ownerType, ownerType), inArray(attachment.ownerId, ids)))
      .orderBy(desc(attachment.createdAt));
    const metas = await Promise.all(rows.map((r) => this.toMeta(r)));
    const byOwner: Record<string, AttachmentMeta[]> = {};
    for (const m of metas) (byOwner[m.ownerId] ??= []).push(m);
    return byOwner;
  }

  async meta(id: string): Promise<AttachmentMeta> {
    const row = await this.row(id);
    return this.toMeta(row);
  }

  /** Байты файла — для локальной отдачи через Core (`/attachments/:id/raw`). */
  async raw(id: string): Promise<{ bytes: Buffer; mime: string | null }> {
    const row = await this.row(id);
    return { bytes: await this.storage.read(row.storageKey), mime: row.mime };
  }

  async remove(id: string): Promise<void> {
    const [row] = await this.db.delete(attachment).where(eq(attachment.id, id)).returning();
    if (!row) throw new NotFoundException("Вложения нет");
  }

  private async row(id: string): Promise<AttachmentRow> {
    const [row] = await this.db.select().from(attachment).where(eq(attachment.id, id));
    if (!row) throw new NotFoundException("Вложения нет");
    return row;
  }

  private async toMeta(row: AttachmentRow): Promise<AttachmentMeta> {
    return {
      id: row.id,
      ownerType: row.ownerType,
      ownerId: row.ownerId,
      kind: row.kind,
      mime: row.mime,
      bytes: row.bytes,
      url: await this.storage.url(row.id, row.storageKey),
      createdAt: row.createdAt.toISOString(),
    };
  }
}
