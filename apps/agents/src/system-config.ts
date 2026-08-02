import type { AgentsCoreClient } from "./core-client";

/**
 * Оверлей глобальных тумблеров системы поверх окружения процесса.
 *
 * Владелец правит не-секретные настройки активации (мозг/RAG/пауза/бюджет) в
 * панели → они лежат в базе Core с приоритетом над `.env`. Агенты тянут
 * ДЕЙСТВУЮЩИЕ значения (база важнее env) и накладывают их на `process.env`, чтобы
 * существующие читатели (modelGatewayFromEnv, embeddingGatewayFromEnv, budget,
 * порог автономии, пауза расписаний) видели правку без рестарта контейнера.
 *
 * Наложение идемпотентно: применяем действующее значение целиком. Сбросил
 * владелец тумблер в панели → действующее значение возвращается к env/дефолту, и
 * оверлей возвращает `process.env` туда же (а не оставляет старое значение базы).
 */

export interface EffectiveConfigItem {
  key: string;
  value: string;
  source: "db" | "env" | "default";
}

/**
 * Наложить действующие значения на объект окружения (мутирует env). Пустое
 * значение пишем как "" — читатели трактуют его как «не задано» (путь спит).
 * Возвращает, сколько тумблеров реально задано владельцем (source=db).
 */
export function overlayEnv(env: Record<string, string | undefined>, items: EffectiveConfigItem[]): number {
  let fromDb = 0;
  for (const it of items) {
    env[it.key] = it.value;
    if (it.source === "db") fromDb += 1;
  }
  return fromDb;
}

/**
 * Прочитать действующий конфиг из Core и наложить на process.env. Core не
 * ответил → оставляем окружение как есть (возвращаем null): агенты продолжают
 * на прежних значениях, а не обнуляют мозг из-за сетевого сбоя.
 */
export async function applySystemOverrides(core: AgentsCoreClient): Promise<number | null> {
  try {
    const items = await core.systemConfig();
    return overlayEnv(process.env, items);
  } catch {
    return null;
  }
}
