import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import { event, systemConfig } from "@mydon/db";
import { sql } from "drizzle-orm";
import { DB, type Db } from "../db/db.module";
import {
  ACCOUNTING_SOURCE_CHANGED_EVENT,
  ACCOUNTING_SOURCE_KEY,
  resetAccountingSourceCache,
  resolveAccountingSource,
} from "../sales/accounting-source";
import { type EffectiveItem, resolveAll, resolveEffective, specFor, validateConfig } from "./config-spec";

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

  /**
   * Действующие значения всех тумблеров: база важнее env, env важнее дефолта.
   *
   * У `OURVEND_ACCOUNTING_SOURCE` рядом едет ДЕЙСТВУЮЩИЙ источник (R-FW-S5):
   * приоритет «база > env > дефолт» отвечает на вопрос «что записано», а
   * учёт решает второй слой — без `STOCK_DATABASE_URL` источник равен `own`
   * независимо от записи. После шага 3 рунбука панель показывала бы `stock`
   * там, где учёт уже свой. Считает то же чистое правило, что и сам учёт
   * (`resolveAccountingSource`), — второй лесенки здесь не заводится.
   */
  async effective(): Promise<EffectiveItem[]> {
    return resolveAll(await this.overrides(), process.env).map((i) =>
      i.key === ACCOUNTING_SOURCE_KEY ? { ...i, effective: resolveAccountingSource(i.value) } : i,
    );
  }

  /**
   * Задать тумблер. Ключ обязан быть в белом списке, значение — валидным.
   * Пустое значение удаляет запись (сброс к env/дефолту). Возвращает
   * обновлённый список действующих значений.
   */
  async set(key: string, value: string, updatedBy?: string, now: Date = new Date()): Promise<EffectiveItem[]> {
    // BadRequestException — не голый Error: иначе ошибка валидации пользователя
    // уходила клиенту как 500, а не 400 (найдено внешним аудитом, P2).
    const err = validateConfig(key, value);
    if (err) throw new BadRequestException(err);

    // Действующее значение ДО записи — только для наблюдаемого тумблера.
    // Сравниваем действующее, а не сырой ввод: сброс тумблера (пустая строка)
    // — это тоже смена, если под ним лежало другое значение из env.
    //
    // Одно-единственное имя ключа зашито здесь, а не заведён общий механизм
    // «наблюдаемых тумблеров»: событий такого рода в системе ровно одно, и
    // обобщение на одном случае даёт лишний слой без второго потребителя.
    const наблюдаемый = key === ACCOUNTING_SOURCE_KEY ? specFor(key) : undefined;
    const было = наблюдаемый ? await this.valueOf(key) : null;

    const trimmed = value.trim();

    // Действующее значение ПОСЛЕ записи считаем ТЕМ ЖЕ резолвером, но по уже
    // известной записи: читать из транзакции свою же незакоммиченную строку —
    // лишний рейс в базу ради того, что мы только что туда положили. Второй
    // лесенки приоритетов здесь не появляется — `resolveEffective` одна.
    const стало = наблюдаемый
      ? resolveEffective(наблюдаемый, trimmed === "" ? {} : { [key]: trimmed }, process.env).value
      : null;
    // СОБЫТИЕ — О СМЕНЕ ДЕЙСТВУЮЩЕГО ИСТОЧНИКА, А НЕ ЗАПИСИ В ТАБЛИЦЕ.
    // Фолбэк «нет зеркала → own» в сравнение настроек не входит, и после шага 3
    // рунбука ЛЮБОЕ сохранение (`stock` или `own`) писало бы «учёт переключен»
    // и будило владельца немедленным сообщением, хотя `accountingSource()` как
    // отвечал `own`, так и отвечает. Тревога, которая врёт фактом эмиссии, учит
    // не читать тревоги.
    const действовало = было === null ? null : resolveAccountingSource(было);
    const действует = стало === null ? null : resolveAccountingSource(стало);
    const сменилось = действует !== null && действует !== действовало;

    // Запись тумблера и событие — ОДНОЙ транзакцией (прецедент
    // `TasksService.create`). Двумя операторами отказ вставки события оставил
    // бы флип совершённым и неозвученным: учёт уже читает другой источник, а в
    // журнале об этом ни строки.
    await this.db.transaction(async (tx) => {
      if (trimmed === "") {
        await tx.delete(systemConfig).where(sql`${systemConfig.key} = ${key}`);
      } else {
        await tx
          .insert(systemConfig)
          .values({ key, value: trimmed, updatedBy: updatedBy ?? null })
          .onConflictDoUpdate({
            target: systemConfig.key,
            set: { value: trimmed, updatedBy: updatedBy ?? null, updatedAt: new Date() },
          });
      }
      if (сменилось) {
        await tx.insert(event).values({
          source: "system",
          type: ACCOUNTING_SOURCE_CHANGED_EVENT,
          // Момент ЗАПИСИ, а не `now()` базы — как у всех новых событий этой
          // ветки: расхождение часов процесса с базой иначе датировало бы флип
          // не теми сутками, по которым его потом ищут в журнале.
          occurredAt: now,
          // `from`/`to` — записанные значения (их владелец и видит в панели),
          // `effective` — действующий источник: они расходятся ровно тогда,
          // когда зеркала уже нет, и разницу надо сказать словами.
          payload: { from: было, to: стало, effective: действует, actor: updatedBy ?? null },
        });
      }
    });

    // Сброс кеша ПОСЛЕ коммита, а не внутри транзакции: сбросив до коммита, мы
    // отдали бы соседнему читателю шанс перечитать ещё старое значение и снова
    // закешировать его на минуту — ровно та задержка, которую сброс и убирает.
    // Кеш сбрасывается на ЛЮБУЮ правку наблюдаемого тумблера, а не только на
    // смену действующего источника: запись могла поменять настройку, не меняя
    // источник (нет зеркала), и держать в кеше прежнее СЛОВО незачем.
    if (наблюдаемый && стало !== было) resetAccountingSourceCache();
    return this.effective();
  }

  /** Действующее значение одного тумблера (для сравнения «до/после»). */
  private async valueOf(key: string): Promise<string> {
    return (await this.effective()).find((i) => i.key === key)?.value ?? "";
  }
}
