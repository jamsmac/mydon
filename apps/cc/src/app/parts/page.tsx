import Link from "next/link";
import { COMMON_PART_KINDS, PART_LOCATIONS, partAttentionLabel, partLabel, partLocationLabel } from "@mydon/shared";
import { core, CoreUnavailable, type PartUnit, type PartsQueue } from "../../lib/core";
import { CoreDown } from "../../components/core-down";
import { ProvisionButton } from "../../components/parts-provision";

export const dynamic = "force-dynamic";

const дата = (d: string | null): string => (d ? d.split("-").reverse().join(".") : "—");

/**
 * Реестр узлов автоматов: где какой узел, у кого нет номера, что на мойке.
 * Плитки — вопросы владельца («сколько без номера?»), клик — ответ списком.
 */
export default async function PartsPage({
  searchParams,
}: {
  searchParams: Promise<{ kind?: string; location?: string; attention?: string; q?: string }>;
}) {
  const sp = await searchParams;
  let parts: PartUnit[];
  let queue: PartsQueue;
  try {
    [parts, queue] = await Promise.all([
      core.parts({
        ...(sp.kind ? { kind: sp.kind } : {}),
        ...(sp.location ? { location: sp.location } : {}),
        ...(sp.attention === "1" ? { attention: true } : {}),
        ...(sp.q ? { q: sp.q } : {}),
      }),
      core.partsQueue(),
    ]);
  } catch (err) {
    return <CoreDown detail={err instanceof CoreUnavailable ? err.detail : String(err)} />;
  }

  const href = (patch: Record<string, string | undefined>) => {
    const p = new URLSearchParams();
    const merged = { ...sp, ...patch };
    for (const [k, v] of Object.entries(merged)) if (v) p.set(k, v);
    const s = p.toString();
    return `/parts${s ? `?${s}` : ""}`;
  };

  const byLocation = new Map<string, number>();
  for (const u of parts) {
    const key = u.where?.location ?? "none";
    byLocation.set(key, (byLocation.get(key) ?? 0) + 1);
  }

  return (
    <>
      <div className="page-head">
        <h1>Узлы автоматов</h1>
        <p>
          {parts.length === 0
            ? "Узлы ещё не заведены."
            : `Узлов ${parts.length}` +
              [...byLocation.entries()]
                .map(([loc, n]) => ` · ${loc === "none" ? "без места" : partLocationLabel(loc).toLowerCase()} ${n}`)
                .join("")}
        </p>
      </div>

      <section className="group-block">
        <div className="section-title">
          Требуют внимания
          <span className="group-count">{queue.items.length}</span>
        </div>
        <div className="rows">
          {(Object.keys(queue.counts) as (keyof typeof queue.counts)[])
            .filter((k) => queue.counts[k] > 0)
            .map((k) => (
              <Link key={k} className="row" href="/parts/queue">
                <span className="t">{partAttentionLabel(k)}</span>
                <span className="pill act">{queue.counts[k]}</span>
              </Link>
            ))}
          {queue.items.length === 0 && (
            <div className="empty">
              <b>Всё учтено</b>
              Номера наклеены, местонахождение известно, тара и фото есть.
            </div>
          )}
        </div>
        <p className="hint" style={{ marginTop: 8, display: "flex", gap: 8, flexWrap: "wrap" }}>
          {queue.items.length > 0 && (
            <Link href="/parts/queue" className="btn primary">
              Пройти по одному →
            </Link>
          )}
          <Link href="/parts/count" className="btn">
            Инвентаризация узлов
          </Link>
          <Link href="/parts/washing" className="btn">
            Мойка и сушка
          </Link>
        </p>
      </section>

      <section className="group-block">
        <div className="section-title">Фильтр</div>
        <p className="hint" style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          <Link className={`pill${!sp.kind ? " ok" : ""}`} href={href({ kind: undefined })}>
            все виды
          </Link>
          {COMMON_PART_KINDS.map((k) => (
            <Link key={k} className={`pill${sp.kind === k ? " ok" : ""}`} href={href({ kind: k })}>
              {partLabel(k)}
            </Link>
          ))}
        </p>
        <p className="hint" style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          <Link className={`pill${!sp.location ? " ok" : ""}`} href={href({ location: undefined })}>
            везде
          </Link>
          {PART_LOCATIONS.map((l) => (
            <Link key={l} className={`pill${sp.location === l ? " ok" : ""}`} href={href({ location: l })}>
              {partLocationLabel(l)}
            </Link>
          ))}
          <Link className={`pill${sp.location === "none" ? " ok" : ""}`} href={href({ location: "none" })}>
            без места
          </Link>
        </p>
      </section>

      <section className="group-block">
        <div className="section-title">
          Список
          <span className="group-count">{parts.length}</span>
        </div>
        {parts.length === 0 ? (
          <div className="empty">
            <b>Узлов нет</b>
            Состав кофейного автомата (4 миксера, гриндер, варка, 8 бункеров, фильтр) заводится на весь парк одной
            кнопкой — сначала предпросмотр, потом заведение. Номера присвоит система, наклейки — за сотрудниками.
            <ProvisionButton />
          </div>
        ) : (
          <table className="tbl">
            <thead>
              <tr>
                <th>Узел</th>
                <th>Номер</th>
                <th>Где</th>
                <th>С</th>
                <th>Серийник</th>
                <th>Внимание</th>
              </tr>
            </thead>
            <tbody>
              {parts.map((u) => (
                <tr key={u.id}>
                  <td>
                    <Link href={`/parts/${u.id}`}>{partLabel(u.partKind)}</Link>
                  </td>
                  <td className="mono">{u.inventoryNo ?? "—"}</td>
                  <td>
                    {u.where
                      ? u.where.machineName
                        ? `${u.where.machineName}${u.where.slot !== null ? ` · слот ${u.where.slot}` : ""}`
                        : partLocationLabel(u.where.location)
                      : "неизвестно"}
                  </td>
                  <td>{дата(u.where?.since ?? null)}</td>
                  <td className="mono">{u.serialNumber ?? "—"}</td>
                  <td>
                    {u.attention.map((a) => (
                      <span key={a} className="pill act" style={{ marginRight: 4 }}>
                        {partAttentionLabel(a)}
                      </span>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {parts.length > 0 && (
          <p className="hint" style={{ marginTop: 10 }}>
            Новый автомат в парке или изменился состав — <ProvisionButton compact />
          </p>
        )}
      </section>
    </>
  );
}
