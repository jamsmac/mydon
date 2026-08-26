import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import { event, systemConfig } from "@mydon/db";
import { sql } from "drizzle-orm";
import { DB, type Db } from "../db/db.module";
import {
  ACCOUNTING_SOURCE_CHANGED_EVENT,
  ACCOUNTING_SOURCE_KEY,
  resetAccountingSourceCache,
} from "../sales/accounting-source";
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
    // BadRequestException — не голый Error: иначе ошибка валидации пользователя
    // уходила клиенту как 500, а не 400 (найдено внешним аудитом, P2).
    const err = validateConfig(key, value);
    if (err) throw new BadRequestException(err);

    // Действующее значение ДО записи — только для наблюдаемого тумблера.
    // Сравниваем действующее, а не сырой ввод: сброс тумблера (пустая строка)
    // — это тоже смена, если под ним лежало другое значение из env.
    const было = key === ACCOUNTING_SOURCE_KEY ? await this.valueOf(key) : null;

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

    // Одно-единственное имя ключа зашито здесь, а не заведён общий механизм
    // «наблюдаемых тумблеров»: событий такого рода в системе ровно одно, и
    // обобщение на одном случае даёт лишний слой без второго потребителя.
    const действующие = await this.effective();
    if (было !== null) {
      const стало = действующие.find((i) => i.key === ACCOUNTING_SOURCE_KEY)?.value ?? "";
      if (стало !== было) {
        // Сброс кеша ДО события: следующий прогон синка не должен ещё минуту
        // читать прежний источник — ради этого кеш и умеет инвалидироваться.
        resetAccountingSourceCache();
        await this.db.insert(event).values({
          source: "system",
          type: ACCOUNTING_SOURCE_CHANGED_EVENT,
          payload: { from: было, to: стало, actor: updatedBy ?? null },
        });
      }
    }
    return действующие;
  }

  /** Действующее значение одного тумблера (для сравнения «до/после»). */
  private async valueOf(key: string): Promise<string> {
    return (await this.effective()).find((i) => i.key === key)?.value ?? "";
  }
}
