import { core, CoreUnavailable, type SystemConfigItem } from "../../lib/core";
import { CoreDown } from "../../components/core-down";
import { SystemEditor } from "../../components/system-editor";

export const dynamic = "force-dynamic";

/**
 * Система / Активация — пульт не-секретных глобальных тумблеров: мозг агентов,
 * семантическая память, пауза расписаний, бюджет. Правки ложатся в базу Core и
 * перекрывают окружение контейнера, поэтому включать мозг/память можно отсюда,
 * не трогая .env. Секретов (API-ключей) тут нет — они остаются в .env.
 */
export default async function SystemPage() {
  let items: SystemConfigItem[];
  try {
    items = await core.systemConfig();
  } catch (err) {
    return <CoreDown detail={err instanceof CoreUnavailable ? err.detail : String(err)} />;
  }

  return (
    <>
      <div className="page-head">
        <h1>Система · Активация</h1>
        <p>
          Глобальные тумблеры агентов. Правки перекрывают окружение и действуют без пересборки —
          агенты подхватывают их при перечитке. Секреты (API-ключи) сюда не входят: они остаются
          в <code>.env</code>.
        </p>
      </div>

      <SystemEditor items={items} />

      <div className="section-title">Что остаётся на сервере</div>
      <div className="row" style={{ display: "block" }}>
        <p className="hint" style={{ margin: 0 }}>
          Для пути подписки нужно один раз установить и авторизовать CLI (<code>claude</code>/
          <code>codex</code>/<code>gemini</code>) в контейнере агентов; для памяти — поднять
          embed-endpoint в Tailscale. Подробности — в <code>docs/AGENTS_ACTIVATION.md</code>.
        </p>
      </div>
    </>
  );
}
