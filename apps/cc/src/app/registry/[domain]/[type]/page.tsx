import Link from "next/link";
import { core, CoreUnavailable, type Entity } from "../../../../lib/core";
import { CoreDown } from "../../../../components/core-down";
import { DOMAIN_TITLES, MONO_KEYS, typeLabel } from "../../../../lib/labels";

export const dynamic = "force-dynamic";

const mono = { fontFamily: "'IBM Plex Mono', ui-monospace, monospace" } as const;

/** Краткая строка под названием: цена для товара, серийник для автомата. */
function subtitle(e: Entity): string {
  const a = e.attrs ?? {};
  const parts: string[] = [];
  if (typeof a["цена"] === "number") parts.push(`${Number(a["цена"]).toLocaleString("ru-RU")} сум`);
  if (e.externalRef) parts.push(e.externalRef);
  return parts.join(" · ") || "—";
}

/** Записи одного типа внутри направления: клик — карточка. */
export default async function TypeList({
  params,
}: {
  params: Promise<{ domain: string; type: string }>;
}) {
  const { domain, type } = await params;
  const decodedType = decodeURIComponent(type);

  let items: Entity[];
  try {
    items = await core.entitiesOfType(domain, decodedType);
  } catch (err) {
    return <CoreDown detail={err instanceof CoreUnavailable ? err.detail : String(err)} />;
  }

  items.sort((x, y) => x.name.localeCompare(y.name, "ru"));

  return (
    <>
      <div className="page-head">
        <Link href="/registry" className="back">← Реестр</Link>
        <h1>{DOMAIN_TITLES[domain] ?? domain}: {typeLabel(decodedType)}</h1>
        <p>Записей: {items.length}. Нажми на строку — откроется карточка.</p>
      </div>

      {items.length === 0 ? (
        <div className="empty">
          <b>Пока пусто</b>
          Записи этого типа появятся после сбора и одобрения.
        </div>
      ) : (
        <div className="rows">
          {items.map((e) => (
            <Link href={`/card/${e.id}`} className="row rowlink" key={e.id}>
              <div className="t">
                <b>{e.name}</b>
                <small style={MONO_KEYS.has("серийник") && e.externalRef ? mono : undefined}>
                  {subtitle(e)}
                </small>
              </div>
              <span className="pill">открыть</span>
            </Link>
          ))}
        </div>
      )}
    </>
  );
}
