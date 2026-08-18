import Link from "next/link";
import { core, CoreUnavailable, type ActionRow, type Person } from "../../../lib/core";
import { CoreDown } from "../../../components/core-down";

export const dynamic = "force-dynamic";

/**
 * «Действия» — лента «кто из сотрудников что сделал».
 *
 * Прямой ответ на вопрос владельца, на который раньше панель отвечала
 * фрагментами (журнал кофе без имён, обслуживание за 30 дней, инкассации) —
 * а единой картины по людям не было нигде.
 */

function isoDay(shift: number): string {
  return new Date(Date.now() - shift * 86_400_000).toLocaleDateString("en-CA", { timeZone: "Asia/Tashkent" });
}

const timeOf = (iso: string): string =>
  new Date(iso).toLocaleTimeString("ru-RU", { timeZone: "Asia/Tashkent", hour: "2-digit", minute: "2-digit" });

const dayOf = (iso: string): string =>
  new Date(iso).toLocaleDateString("ru-RU", { timeZone: "Asia/Tashkent", day: "2-digit", month: "2-digit" });

const PERIODS = [
  { key: "today", label: "Сегодня", from: () => isoDay(0), to: () => isoDay(0) },
  { key: "yesterday", label: "Вчера", from: () => isoDay(1), to: () => isoDay(1) },
  { key: "week", label: "7 дней", from: () => isoDay(6), to: () => isoDay(0) },
] as const;

export default async function TeamActions({
  searchParams,
}: {
  searchParams: Promise<{ period?: string; person?: string }>;
}) {
  const params = await searchParams;
  const period = PERIODS.find((p) => p.key === params.period) ?? PERIODS[0];
  const person = params.person && /^[0-9a-f-]{36}$/.test(params.person) ? params.person : undefined;

  let rows: ActionRow[];
  let people: Person[];
  try {
    [rows, people] = await Promise.all([
      core.actions(period.from(), period.to(), person),
      core.people(true).catch(() => [] as Person[]),
    ]);
  } catch (err) {
    return <CoreDown detail={err instanceof CoreUnavailable ? err.detail : String(err)} />;
  }

  // Кто вообще действовал в периоде — для фильтра-переключателя. При активном
  // фильтре по человеку список людей берём из справочника, а не из выборки.
  const activeIds = new Set(rows.map((r) => r.personId));
  const filterPeople = people.filter((p) => activeIds.has(p.id) || p.id === person);
  const href = (over: { period?: string; person?: string | undefined }): string => {
    const q = new URLSearchParams();
    const pKey = over.period ?? period.key;
    if (pKey !== "today") q.set("period", pKey);
    const pid = "person" in over ? over.person : person;
    if (pid) q.set("person", pid);
    const s = q.toString();
    return s ? `/team/actions?${s}` : "/team/actions";
  };

  const multiDay = period.key === "week";

  return (
    <>
      <div className="page-head">
        <h1>Действия</h1>
        <p>Кто из сотрудников что сделал: заливки, возвраты, мойки, обслуживание, инкассации, склад, задачи, карточки.</p>
      </div>

      <div className="filters" style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 14 }}>
        {PERIODS.map((p) => (
          <Link key={p.key} className={`chip${p.key === period.key ? " b" : ""}`} href={href({ period: p.key })}>
            {p.label}
          </Link>
        ))}
        <span style={{ opacity: 0.4 }}>·</span>
        <Link className={`chip${person === undefined ? " b" : ""}`} href={href({ person: undefined })}>
          Все люди
        </Link>
        {filterPeople.map((p) => (
          <Link key={p.id} className={`chip${p.id === person ? " b" : ""}`} href={href({ person: p.id })}>
            {p.name}
          </Link>
        ))}
      </div>

      {rows.length === 0 ? (
        <div className="empty">
          <b>Действий не записано</b>
          За выбранный период сотрудники ничего не вносили — или записи шли без привязки к человеку.
        </div>
      ) : (
        <div className="rows">
          {rows.map((r, i) => (
            <div className="row" key={`${r.ts}-${r.personId}-${i}`}>
              <span className="pill human">{r.personName}</span>
              <div className="t">
                <b>{r.label}</b>
              </div>
              <span className="when">
                {multiDay ? `${dayOf(r.ts)} ` : ""}
                {timeOf(r.ts)}
              </span>
            </div>
          ))}
          {rows.length >= 500 && <p className="hint">Показаны последние 500 действий периода.</p>}
        </div>
      )}
    </>
  );
}
