import { core, CoreUnavailable, type Attachment, type EntityDraft } from "../../lib/core";
import { CoreDown } from "../../components/core-down";
import { PendingCardTile, PendingFieldGroup } from "../../components/queue-view";
import { plural } from "../../lib/format";

export const dynamic = "force-dynamic";

/**
 * Очередь утверждения — единый вход владельца: всё, что заведено НЕ им и ждёт
 * его слова, собрано в одном месте.
 *
 * До этого экрана черновик сотрудника можно было утвердить только зная id
 * карточки и открыв её вручную — петля «завёл → утвердил» была разомкнута.
 * Здесь новые карточки идут сразу с фото (что именно завели — отвечает снимок),
 * а предложенные значения — рядом с картинкой «сейчас → предложено».
 */
export default async function Queue() {
  let cards: Awaited<ReturnType<typeof core.pendingEntities>>["cards"];
  let fields: (EntityDraft & { entityName: string; entityType: string })[];
  try {
    ({ cards, fields } = await core.pendingEntities());
  } catch (err) {
    return <CoreDown detail={err instanceof CoreUnavailable ? err.detail : String(err)} />;
  }

  // Фото всех черновиков — одним запросом, не по одному на карточку. Ошибка тут
  // не должна ронять очередь: снимки — дополнение, а решение принимается и без них.
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
  const groups = new Map<
    string,
    { name: string; type: string; fields: EntityDraft[] }
  >();
  for (const f of fields) {
    const g = groups.get(f.entityId) ?? {
      name: f.entityName,
      type: f.entityType,
      fields: [],
    };
    g.fields.push(f);
    groups.set(f.entityId, g);
  }

  const total = cards.length + groups.size;

  return (
    <>
      <div className="page-head">
        <h1 className="h1">На утверждение</h1>
        <p className="lead">
          Заведённое не тобой фактом реестра ещё не считается. Подтверди — станет.
        </p>
      </div>

      {total === 0 ? (
        <div className="empty">
          <b>Очередь пуста</b>
          Всё, что заводили сотрудники и источники, уже утверждено тобой.
        </div>
      ) : (
        <>
          {cards.length > 0 && (
            <div className="sect">
              <div className="sect-h">
                <h3 className="h2">Новые карточки</h3>
                <span className="chip h">
                  {cards.length} {plural(cards.length, "карточка", "карточки", "карточек")}
                </span>
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
