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
  /** В какой момент снято: before | after | plate | counter. */
  stage: string | null;
  mime: string | null;
  bytes: number | null;
  url: string;
  createdAt: string;
}

/**
 * Стадии съёмки. Закрытый список, а не свободный текст: по стадии строится
 * галерея «до/после» в панели, и опечатка в ней означает потерянное фото.
 *   before  — до работы, after — после (доказательство выполнения);
 *   plate   — шильдик узла, когда серийный номер не переписать руками;
 *   counter — показания счётчика автомата.
 */
export const ATTACHMENT_STAGES = ["before", "after", "plate", "counter"] as const;
export type AttachmentStage = (typeof ATTACHMENT_STAGES)[number];

/** Разрешённые типы фото — чтобы не превращать хранилище в свалку. */
const IMAGE_EXT: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/heic": ".heic",
};

/**
 * Типы, которые панель показывает inline в `<img>`, — ключи IMAGE_EXT.
 *
 * Замкнутый список, а не префикс `image/`: SVG — тоже `image/*`, но при
 * прямом переходе исполняет вложенный `<script>` на нашем origin, и `nosniff`
 * этому не мешает — тип заявлен верно, браузеру нечего угадывать. Список
 * закрыт и при отдаче, а не только при загрузке: строки, записанные до
 * белого списка (или мимо `upload()`), при отдаче иначе не перепроверялись бы.
 * Зеркало этого списка живёт в панели: apps/cc/src/app/api/attachments/[id]/raw.
 */
export const INLINE_IMAGE_MIMES: ReadonlySet<string> = new Set(Object.keys(IMAGE_EXT));

/**
 * Что ещё принимаем к чеку и документу: только PDF. Бот и панель кладут в
 * вложения фотографии (`kind=photo`), чек с телефона — тоже фото; PDF нужен
 * счёту и акту, которые приходят файлом.
 */
const DOC_EXT: Record<string, string> = {
  "application/pdf": ".pdf",
};

/**
 * Расширение для разрешённого типа или `undefined` — отказ.
 *
 * Список закрыт для ВСЕХ видов вложения, а не только для фото: `mime` уезжает
 * в БД и возвращается заголовком `Content-Type` при отдаче байтов, поэтому
 * принятый `text/html` был бы сохранённым XSS на origin панели.
 */
function allowedExt(kind: string, mimetype: string): string | undefined {
  const mime = mimetype.toLowerCase();
  return kind === "photo" ? IMAGE_EXT[mime] : (IMAGE_EXT[mime] ?? DOC_EXT[mime]);
}

@Injectable()
export class AttachmentsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly storage: StorageService,
  ) {}

  /** Загрузить файл, привязать к записи. Тип файла проверяем по белому списку. */
  async upload(
    input: {
      ownerType: string;
      ownerId: string;
      kind?: string;
      createdBy?: string;
      stage?: AttachmentStage;
    },
    file: UploadedFile | undefined,
  ): Promise<AttachmentMeta> {
    if (!file || file.size === 0) throw new BadRequestException("Файл не получен");
    const kind = input.kind ?? "photo";
    const ext = allowedExt(kind, file.mimetype);
    if (ext === undefined) {
      throw new BadRequestException(
        kind === "photo"
          ? `Не изображение: ${file.mimetype}`
          : `Недопустимый тип файла для «${kind}»: ${file.mimetype}. Принимаем изображение или PDF`,
      );
    }
    const key = this.storage.keyFor(input.ownerType, input.ownerId, ext);
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
        stage: input.stage ?? null,
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
      stage: row.stage,
      mime: row.mime,
      bytes: row.bytes,
      url: await this.storage.url(row.id, row.storageKey),
      createdAt: row.createdAt.toISOString(),
    };
  }
}
