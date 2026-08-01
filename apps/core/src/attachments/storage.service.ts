import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Injectable, Logger } from "@nestjs/common";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

/**
 * Хранилище файлов: объектное (S3/MinIO), а без настройки — локальный диск.
 *
 * S3/MinIO включается, когда заданы endpoint+bucket+ключи (как советует донор:
 * один клиент под оба, `forcePathStyle` для MinIO). Не настроено — пишем на
 * диск (том Hetzner) и отдаём через сам Core: так разработка и первый запуск не
 * требуют инфраструктуры, а прод переключается переменными окружения.
 */
@Injectable()
export class StorageService {
  private readonly log = new Logger(StorageService.name);
  private readonly s3: S3Client | null;
  private readonly bucket: string;
  private readonly localDir: string;

  constructor() {
    const endpoint = process.env.STORAGE_ENDPOINT;
    const bucket = process.env.STORAGE_BUCKET;
    const accessKeyId = process.env.STORAGE_ACCESS_KEY;
    const secretAccessKey = process.env.STORAGE_SECRET_KEY;
    this.bucket = bucket ?? "";
    this.localDir = process.env.STORAGE_LOCAL_DIR ?? "/data/attachments";
    if (endpoint && bucket && accessKeyId && secretAccessKey) {
      this.s3 = new S3Client({
        endpoint,
        region: process.env.STORAGE_REGION ?? "us-east-1",
        credentials: { accessKeyId, secretAccessKey },
        // MinIO и большинство совместимых требуют path-style. Отключить: STORAGE_FORCE_PATH_STYLE=false.
        forcePathStyle: process.env.STORAGE_FORCE_PATH_STYLE !== "false",
      });
      this.log.log(`Хранилище файлов: S3/MinIO (${endpoint}/${bucket}).`);
    } else {
      this.s3 = null;
      this.log.log(`Хранилище файлов: локальный диск ${this.localDir} (S3 не настроен).`);
    }
  }

  /** Ключ файла: owner/<тип>/<id>/<uuid><ext>. Разложено по владельцам. */
  keyFor(ownerType: string, ownerId: string, ext: string): string {
    return `${ownerType}/${ownerId}/${randomUUID()}${ext}`;
  }

  /** Положить байты. */
  async put(key: string, bytes: Buffer, mime: string | null): Promise<void> {
    if (this.s3) {
      await this.s3.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: bytes,
          ...(mime ? { ContentType: mime } : {}),
        }),
      );
      return;
    }
    const full = path.join(this.localDir, key);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, bytes);
  }

  /**
   * Ссылка на файл. У S3 — presigned URL (час), у диска — маршрут самого Core
   * (`/attachments/:id/raw`), который отдаёт байты. Панель кладёт это в `<img>`.
   */
  async url(id: string, key: string): Promise<string> {
    if (this.s3) {
      return getSignedUrl(this.s3, new GetObjectCommand({ Bucket: this.bucket, Key: key }), {
        expiresIn: 3600,
      });
    }
    return `/attachments/${id}/raw`;
  }

  /** Прочитать байты (для локальной отдачи через Core). */
  async read(key: string): Promise<Buffer> {
    if (this.s3) {
      const res = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      const arr = await res.Body!.transformToByteArray();
      return Buffer.from(arr);
    }
    return fs.readFile(path.join(this.localDir, key));
  }

  /** Настроено ли внешнее хранилище (S3/MinIO). Локальная отдача — только у диска. */
  get isRemote(): boolean {
    return this.s3 !== null;
  }
}
