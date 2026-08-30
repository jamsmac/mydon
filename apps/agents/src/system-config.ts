import type { AgentsCoreClient } from "./core-client";

/**
 * Оверлей глобальных тумблеров системы поверх окружения процесса.
 *
 * Владелец правит не-секретные настройки активации (мозг/RAG/пауза/бюджет) в
 * панели → они лежат в базе Core с приоритетом над `.env`. Агенты тянут
 * ДЕЙСТВУЮЩИЕ значения (база важнее env) и накладывают их на `process.env`, чтобы
 * существующие читатели (modelGatewayFromEnv, embeddingGatewayFromEnv, budget,
 * порог автономии, паузы cron/назначенных задач) видели правку без рестарта контейнера.
 *
 * ВАЖНО про «env» и «default» в ответе Core. Штатный Compose теперь передаёт
 * обе паузы и Core, и Agents, чтобы панель показывала тот же env-default.
 * Но старый Core или частичная/custom-установка может не получить один из
 * ключей и честно ответить `source: "default"` из `CONFIG_SPECS.fallback`.
 * Это НЕ «владелец так решил», а «Core не знает env другого процесса».
 * Накладывать такой default поверх собственного env нельзя: раньше fallback
 * `"1"` затирал заданный владельцем `AGENTS_SCHEDULES_PAUSED=0`, расписания
 * молча не заводились, а `.env` становился декоративным.
 *
 * Отсюда правило: значение из базы (`source: "db"`) — единственный явный выбор
 * владельца, оно перекрывает окружение. Всё остальное возвращает ключ к
 * ИСХОДНОМУ значению нашего процесса, снятому при первом наложении. Это
 * сохраняет и сброс тумблера: убрал владелец запись из базы → возвращаемся к
 * своему `.env`, а не застреваем на старом значении базы. Ключ, которого у нас
 * не было, берёт значение Core — там дефолт и есть единственный ответ.
 */

export interface EffectiveConfigItem {
  key: string;
  value: string;
  source: "db" | "env" | "default";
}

/**
 * Исходное окружение процесса до первого наложения — по одному снимку на объект
 * env. Снимаем лениво и только те ключи, которые реально приходят от Core:
 * снимок всего окружения хранил бы секреты дольше, чем нужно.
 */
const baselines = new WeakMap<object, Map<string, string | undefined>>();

/**
 * Наложить действующие значения на объект окружения (мутирует env). Пустое
 * значение пишем как "" — читатели трактуют его как «не задано» (путь спит).
 * Возвращает, сколько тумблеров реально задано владельцем (source=db).
 */
export function overlayEnv(
  env: Record<string, string | undefined>,
  items: EffectiveConfigItem[],
): number {
  let baseline = baselines.get(env);
  if (baseline === undefined) {
    baseline = new Map();
    baselines.set(env, baseline);
  }

  let fromDb = 0;
  for (const it of items) {
    if (!baseline.has(it.key)) baseline.set(it.key, env[it.key]);

    if (it.source === "db") {
      env[it.key] = it.value;
      fromDb += 1;
      continue;
    }

    // Не выбор владельца — возвращаем ключ к своему исходному значению. Своего
    // не было → значение Core (его дефолт) единственное осмысленное.
    const own = baseline.get(it.key);
    env[it.key] = own ?? it.value;
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
