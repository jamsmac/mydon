import {
  core,
  CoreUnavailable,
  type Approval,
  type Attachment,
  type EntityDraft,
} from "../../lib/core";
import { CoreDown } from "../../components/core-down";
import { ApprovalCard } from "../../components/approval-card";
import { ApproveAllCards, PendingCardTile, PendingFieldGroup } from "../../components/queue-view";
import { plural } from "../../lib/format";

export const dynamic = "force-dynamic";

/**
 * Входящие — единый вход владельца: всё, что ждёт его слова, в одном месте.
 *
 * Раньше это было раскидано на два пункта меню: «Решения» (предложения агентов)
 * и «На утверждение» (черновики реестра). Оба отвечают на один вопрос —
 * «что ждёт меня» — поэтому сведены в один экран с секциями. Механика прежняя:
 * решения агентов и утверждение карточек работают как работали, объединён вход.
 */
export default async function Inbox() {
  let approvals: Approval[];
  let cards: Awaited<ReturnType<typeof core.pendingEntities>>["cards"];
  let fields: (EntityDraft & { entityName: string; entityType: string })[];
  try {
    const [appr, pending] = await Promise.all([
      core.pendingApprovals(),
      core.pendingEntities(),
    ]);
    approvals = appr;
    cards = pending.cards;
    fields = pending.fields;
  } catch (err) {
    return <CoreDown detail={err instanceof CoreUnavailable ? err.detail : String(err)} />;
  }

  // Фото всех черновиков — одним запросом, не по одному на карточку. Ошибка тут
  // не должна ронять экран: снимки — дополнение, решение принимается и без них.
  let photosByCard: Record<string, Attachment[]> = {};
  try {
    photosByCard = await core.attachmentsBatch(
      "entity",
      cards.map((c) => c.id),
    );
  } catch {
    photosByCard = {};
  }

  // Предложенные значения — по карточкам: владелец решает поле за полем, но
  // видит их сгруппированными по записи, а не сплошным списком.
  const groups = new Map<string, { name: string; type: string; fields: EntityDraft[] }>();
  for (const f of fields) {
    const g = groups.get(f.entityId) ?? { name: f.entityName, type: f.entityType, fields: [] };
    g.fields.push(f);
    groups.set(f.entityId, g);
  }

  const total = approvals.length + cards.length + groups.size;

  return (
    <>
      <div className="page-head">
        <h1 className="h1">Входящие</h1>
        <p className="lead">Всё, что ждёт твоего слова — решения агентов и карточки реестра — в одном месте.</p>
      </div>

      {total === 0 ? (
        <div className="empty">
          <b>Ничего не ждёт решения</b>
          Агенты только предлагают (порог T0), а заведённое сотрудниками и источниками уже утверждено.
        </div>
      ) : (
        <>
          {approvals.length > 0 && (
            <div className="sect">
              <div className="sect-h">
                <h3 className="h2">Решения агентов</h3>
                <span className="chip h">
                  {approvals.length} {plural(approvals.length, "решение", "решения", "решений")}
                </span>
              </div>
              {approvals.map((a) => (
                <ApprovalCard key={a.id} item={a} />
              ))}
            </div>
          )}

          {cards.length > 0 && (
            <div className="sect">
              <div className="sect-h">
                <h3 className="h2">Новые карточки</h3>
                <span className="chip h">
                  {cards.length} {plural(cards.length, "карточка", "карточки", "карточек")}
                </span>
                <span className="sp" />
                <ApproveAllCards ids={cards.map((c) => c.id)} />
              </div>
              <div className="qgrid">
                {cards.map((c) => (
                  <PendingCardTile key={c.id} card={c} photos={photosByCard[c.id] ?? []} />
                ))}
              </div>
            </div>
          )}

          {groups.size > 0 && (
            <div className="sect">
              <div className="sect-h">
                <h3 className="h2">Предложенные значения</h3>
                <span className="chip h">
                  {groups.size} {plural(groups.size, "карточка", "карточки", "карточек")}
                </span>
              </div>
              <div className="qgrid">
                {[...groups.entries()].map(([id, g]) => (
                  <PendingFieldGroup
                    key={id}
                    entityId={id}
                    entityName={g.name}
                    entityType={g.type}
                    fields={g.fields}
                  />
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </>
  );
}
