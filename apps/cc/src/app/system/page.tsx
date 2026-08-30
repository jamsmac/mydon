import {
  core,
  CoreUnavailable,
  type LlmLedgerMonitoring,
  type SystemConfigItem,
} from "../../lib/core";
import { CoreDown } from "../../components/core-down";
import { LlmMonitoring } from "../../components/llm-monitoring";
import { LlmSettings } from "../../components/llm-settings";
import { SystemEditor } from "../../components/system-editor";
import { genericSystemConfigItems, llmProfileFromSystemConfig } from "../../lib/llm-profile";

export const dynamic = "force-dynamic";

/**
 * Система / Активация — пульт не-секретных глобальных тумблеров: мозг агентов,
 * семантическая память, независимые паузы cron/назначенных задач, бюджет. Правки ложатся в базу Core и
 * перекрывают окружение контейнера, поэтому включать мозг/память можно отсюда,
 * не трогая .env. Секретов (API-ключей) тут нет — они остаются в .env.
 */
export default async function SystemPage() {
  let items: SystemConfigItem[];
  let monitoring: LlmLedgerMonitoring | null;
  try {
    [items, monitoring] = await Promise.all([
      core.systemConfig(),
      core.llmLedgerMonitoring().catch((): null => null),
    ]);
  } catch (err) {
    return <CoreDown detail={err instanceof CoreUnavailable ? err.detail : String(err)} />;
  }
  const llmProfile = llmProfileFromSystemConfig(items);
  const genericItems = genericSystemConfigItems(items);

  return (
    <>
      <div className="page-head">
        <h1>Система · Активация</h1>
        <p>
          Не-секретные настройки активации. Правки перекрывают окружение и переживают пересборку.
          API-ключи остаются только в окружении сервера.
        </p>
      </div>

      <LlmMonitoring monitoring={monitoring} />

      <LlmSettings initial={llmProfile} />

      {genericItems.length > 0 && (
        <>
          <div className="section-title">Остальные настройки</div>
          <SystemEditor items={genericItems} />
        </>
      )}
    </>
  );
}
