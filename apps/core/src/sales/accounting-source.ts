import { Logger } from "@nestjs/common";
import type { Db } from "../db/db.module";
import { settingValue } from "../system/settings";

/**
 * Источник учётного потока OurVend (П2 плана поглощения, R-P8b-3).
 *
 * "stock" — читаем БД mydon-stock (зеркало), "own" — собственный снапшот
 * (таблица `ourvend_sale_snapshot`, наполняет агент ourvend:accounting).
 *
 * ТРИ решения, которые тут стоит объяснить.
 *
 * (а) ПОЧЕМУ НАСТРОЙКА, А НЕ ПЕРЕМЕННАЯ ОКРУЖЕНИЯ. Переключение источника —
 * центральный шаг катовера, и делает его владелец из панели «Система». Через
 * env это означало бы правку `.env` и рестарт `mydon-core` ровно в тот момент,
 * когда за учётом смотрят пристальнее всего: рестарт — это ещё и обрыв синка на
 * минуты и потерянные прогоны кронов. Ключ в `config-spec` даёт флип без
 * рестарта; env остаётся фолбэком (`settingValue`: база > env > дефолт), так
 * что уже выставленное в compose значение продолжает работать.
 *
 * (б) ПОЧЕМУ ФОЛБЭК `own` СТОИТ ПЕРВЫМ, ДО ВСЕХ ПРИОРИТЕТОВ. Без
 * `STOCK_DATABASE_URL` читать зеркало нечем, а «stock без зеркала» — это не
 * ошибка, а ТИШИНА: `fetchSourceRows()` возвращает `null`, синк отдаёт
 * `{ upserted: 0 }` и не пишет ни события, ни предупреждения
 * (`sales.service.ts`). Учёт встал бы, а панель выглядела бы как обычно. После
 * шага 3 рунбука (гашение переменной) режим `own` — единственный возможный,
 * поэтому правило и стоит выше настройки: настройка не может выбрать источник,
 * которого физически нет.
 *
 * (в) ПОЧЕМУ КЕШ. `settingValue` делает `select … from system_config` на КАЖДЫЙ
 * вызов, а зовут функцию синк продаж (крон каждые 10 минут), синк снабжения
 * (свой такой же) и два отчёта — по несколько раз за прогон. Минута — верхняя граница из R-P8b-3:
 * флип из панели обязан доехать до ближайшего прогона синка, а не до рестарта.
 * Ждать эту минуту всё равно не приходится: `SystemService.set` сбрасывает кеш
 * сразу после записи.
 */
export type AccountingSource = "stock" | "own";

/** Ключ тумблера в `config-spec`/`system_config` и в окружении. */
export const ACCOUNTING_SOURCE_KEY = "OURVEND_ACCOUNTING_SOURCE";

/** Событие смены действующего источника учёта (правило — immediate). */
export const ACCOUNTING_SOURCE_CHANGED_EVENT = "ourvend.accounting_source_changed";

/** Кеш чтения: флип из панели применяется к ближайшему прогону синка (R-P8b-3). */
export const ACCOUNTING_SOURCE_CACHE_MS = 60_000;

/**
 * Чистое правило: действующее значение настройки + окружение → источник.
 *
 * Про базу, кеш и логи не знает НИЧЕГО — этим и проверяется: приоритет «база >
 * env > дефолт» целиком лежит на `settingValue`/`resolveEffective`, второй
 * лесенки здесь нет. Мусор в настройке (опечатка владельца) читается как
 * `stock`, а не как отказ: учёт не должен вставать из-за неверно набранного
 * слова — но и молчать о нём нельзя, поэтому рядом живёт `непонятноеЗначение`,
 * а предупреждение пишет `accountingSource`.
 */
export function resolveAccountingSource(setting: string, env: NodeJS.ProcessEnv = process.env): AccountingSource {
  if ((env.STOCK_DATABASE_URL ?? "").trim() === "") return "own";
  return setting.trim().toLowerCase() === "own" ? "own" : "stock";
}

/**
 * Значение, которого панель показать не может: ни `stock`, ни `own`, ни пусто.
 *
 * `PUT /system/config` такое режет валидатором `oneOf`, а env — не режет никто:
 * `OURVEND_ACCOUNTING_SOURCE=snapsot` в `.env` или в `docker-compose` даст
 * молчаливый `stock`, и при этом панель покажет в `select` вариант `snapsot`,
 * которого в списке нет. Прецедент репо — `readIntSetting`: «непрочитанное
 * значение — НЕ тихий фолбэк».
 */
function непонятноеЗначение(setting: string): boolean {
  const v = setting.trim().toLowerCase();
  return v !== "" && v !== "stock" && v !== "own";
}

const log = new Logger("accounting-source");

let кеш: { at: number; value: AccountingSource } | null = null;

/**
 * Действующий источник учёта: настройка панели (база > env > дефолт) поверх
 * фолбэка «нет зеркала — own», с кешем не дольше `ACCOUNTING_SOURCE_CACHE_MS`.
 *
 * `now` — параметр, а не `new Date()` внутри: иначе истечение кеша нечем
 * проверить тестом, кроме как реальным ожиданием минуты.
 */
export async function accountingSource(db: Db, now: Date = new Date()): Promise<AccountingSource> {
  const t = now.getTime();
  if (кеш && t - кеш.at < ACCOUNTING_SOURCE_CACHE_MS && t >= кеш.at) return кеш.value;
  const setting = await settingValue(db, ACCOUNTING_SOURCE_KEY);
  const value = resolveAccountingSource(setting);
  // Предупреждение здесь, а не в чистом правиле: кеш держит его на одну строку
  // в минуту, а не на строку в каждый вызов синка.
  if (непонятноеЗначение(setting)) {
    log.warn(
      `Настройка ${ACCOUNTING_SOURCE_KEY}=«${setting.trim()}» не понята (допустимо: stock, own) — ` +
        `источник ${value}. Панель покажет это значение в select, которого в списке нет.`,
    );
  }
  кеш = { at: t, value };
  return value;
}

/** Сброс кеша: зовёт `SystemService.set`, чтобы флип не ждал минуту. */
export function resetAccountingSourceCache(): void {
  кеш = null;
}
