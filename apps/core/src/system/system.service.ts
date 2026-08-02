import { Inject, Injectable } from "@nestjs/common";
import { systemConfig } from "@mydon/db";
import { sql } from "drizzle-orm";
import { DB, type Db } from "../db/db.module";
import { type EffectiveItem, resolveAll, validateConfig } from "./config-spec";

/**
 * Глобальные тумблеры системы (активация: мозг/RAG/пауза/бюджет).
 *
 * Хранит ТОЛЬКО не-секретные настройки из белого списка (`config-spec`). Правка
 * из панели ложится в базу и перекрывает env контейнера — так владелец включает
 * мозг/память/расписания из интерфейса, не трогая `.env`. Пустое значение
 * сбрасывает тумблер к env/дефолту (запись удаляется).
 */
@Injectable()
export class SystemService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** Записанные из панели значения как карта key→value. */
  private async overrides(): Promise<Record<string, string>> {
    const rows = await this.db.select().from(systemConfig);
    const map: Record<string, string> = {};
    for (const r of rows) map[r.key] = r.value;
    return map;
  }

  /** Действующие значения всех тумблеров: база важнее env, env важнее дефолта. */
  async effective(): Promise<EffectiveItem[]> {
    return resolveAll(await this.overrides(), process.env);
  }

  /**
   * Задать тумблер. Ключ обязан быть в белом списке, значение — валидным.
   * Пустое значение удаляет запись (сброс к env/дефолту). Возвращает
   * обновлённый список действующих значений.
   */
  async set(key: string, value: string, updatedBy?: string): Promise<EffectiveItem[]> {
    const err = validateConfig(key, value);
    if (err) throw new Error(err);

    const trimmed = value.trim();
    if (trimmed === "") {
      await this.db.delete(systemConfig).where(sql`${systemConfig.key} = ${key}`);
    } else {
      await this.db
        .insert(systemConfig)
        .values({ key, value: trimmed, updatedBy: updatedBy ?? null })
        .onConflictDoUpdate({
          target: systemConfig.key,
          set: { value: trimmed, updatedBy: updatedBy ?? null, updatedAt: new Date() },
        });
    }
    return this.effective();
  }
}
