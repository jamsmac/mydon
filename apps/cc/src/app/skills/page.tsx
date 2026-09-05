import { CoreDown } from "../../components/core-down";
import { ConsoleTheme } from "../../components/console-theme";
import { SkillTree } from "../../components/skill-tree";
import { SkillsDeck } from "../../components/skills-deck";
import { core, CoreUnavailable, type SkillDeck } from "../../lib/core";
import { plural, when } from "../../lib/format";

export const dynamic = "force-dynamic";

/**
 * Экран «Навыки» — витрина того, что агенты умеют, и кнопка «запустить».
 *
 * Каталог пишут сами агенты при старте, поэтому пустой экран здесь значит не
 * «навыков нет», а «никто ещё не отчитался» — и говорит, что с этим делать.
 */
export default async function Skills() {
  let deck: SkillDeck;
  try {
    deck = await core.skillDeck();
  } catch (err) {
    return <CoreDown detail={err instanceof CoreUnavailable ? err.detail : String(err)} />;
  }

  const agents = new Set(deck.items.map((i) => i.agent)).size;
  const fallbacks = deck.models.fallbacks.length;

  return (
    <>
      <ConsoleTheme />
      <div className="page-head">
        <h1>Навыки</h1>
        <p className="lead">
          {deck.items.length} {plural(deck.items.length, "навык", "навыка", "навыков")} у {agents}{" "}
          {plural(agents, "агента", "агентов", "агентов")} · каталог обновлён{" "}
          {deck.syncedAt ? when(deck.syncedAt) : "ещё нет"} · модель{" "}
          {deck.models.primary ?? "не задана"}
          {fallbacks > 0 ? ` (+${fallbacks} ${plural(fallbacks, "запасная", "запасные", "запасных")})` : ""}
        </p>
      </div>

      {deck.items.length === 0 ? (
        <div className="empty">
          <b>Каталог ещё не синхронизирован</b>
          Перезапусти контейнер агентов — он перепишет каталог при старте.
        </div>
      ) : (
        <>
          <SkillsDeck deck={deck} />
          <div className="section-title">Карта навыков</div>
          <SkillTree items={deck.items} />
        </>
      )}
    </>
  );
}
