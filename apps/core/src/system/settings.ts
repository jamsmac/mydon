import { Logger } from "@nestjs/common";
import { systemConfig } from "@mydon/db";
import type { Db } from "../db/db.module";
import { resolveEffective, specFor } from "./config-spec";

/**
 * Чтение глобальных тумблеров из базы: база важнее env, env важнее дефолта —
 * тот же резолвер, что у панели настроек, чтобы правка владельца работала
 * сразу, без рестарта.
 *
 * Отдельный модуль, а не метод сервиса: одну и ту же лесенку «select
 * system_config → map → resolveEffective» уже писали в двух местах
 * (`VendingService.routeSetting` и детектор заливок), и третья копия
 * разошлась бы с первыми двумя в приоритетах.
 */
export async function settingValue(db: Db, key: string): Promise<string> {
  const spec = specFor(key);
  if (!spec) return "";
  const rows = await db.select().from(systemConfig);
  const map: Record<string, string> = {};
  for (const r of rows) map[r.key] = r.value;
  return resolveEffective(spec, map, process.env).value;
}

/**
 * Целочисленная настройка с фолбэком.
 *
 * Непрочитанное значение — НЕ тихий фолбэк: владелец, вписавший «десять»
 * вместо «10», иначе никогда не узнает, что порог не применился, и будет
 * читать отчёт, посчитанный по другому числу. Пишем предупреждение в лог и
 * работаем по дефолту — отказать целиком тут хуже, чем считать по дефолту.
 */
export async function readIntSetting(db: Db, key: string, fallback: number, logger?: Logger): Promise<number> {
  const raw = (await settingValue(db, key)).trim();
  if (raw === "") return fallback;
  const n = Number(raw.replace(",", "."));
  // Ноль и отрицательное — тоже мусор для порогов: «ловить всё подряд» никто
  // не имеет в виду, вписывая 0.
  if (Number.isFinite(n) && n > 0) return n;
  (logger ?? new Logger("settings")).warn(`Настройка ${key}=«${raw}» не число — считаю по дефолту ${fallback}`);
  return fallback;
}
