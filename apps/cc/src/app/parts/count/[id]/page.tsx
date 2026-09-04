import Link from "next/link";
import { partLabel, partLocationLabel } from "@mydon/shared";
import { core, CoreUnavailable, type PartCountLine, type PartCountSummary } from "../../../../lib/core";
import { CoreDown } from "../../../../components/core-down";
import { PartCountActions, RemoveLineButton } from "../../../../components/part-count-actions";

export const dynamic = "force-dynamic";

const когда = (iso: string | null): string =>
  iso ? new Date(iso).toLocaleString("ru-RU", { timeZone: "Asia/Tashkent", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "—";

const RESULT: Record<NonNullable<PartCountLine["result"]>, { text: string; cls: string }> = {
  found: { text: "найден", cls: "ok" },
  new: { text: "заведён", cls: "ok" },
  missing: { text: "не найден", cls: "bad" },
  reversed: { text: "возвращён", cls: "mono" },
};

function lineStatus(l: PartCountLine, applied: boolean): { text: string; cls: string } {
  if (l.result) return RESULT[l.result];
  if (!l.partUnitId) return { text: "новый", cls: "act" };
  if (l.registeredAt && !["warehouse", "washing", "drying", "repair"].includes(l.registeredAt)) {
    return { text: `числился: ${l.registeredAt === "unknown" ? "неизвестно где" : l.registeredAt}`, cls: "act" };
  }
  return { text: applied ? "найден" : "найден", cls: "ok" };
}

/** Сессия инвентаризации: строки живьём, разность и кнопки применения (R-PU-7). */
export default async function PartCountSessionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let s: PartCountSummary;
  try {
    s = await core.partCountSummary(id);
  } catch (err) {
    return <CoreDown detail={err instanceof CoreUnavailable ? err.detail : String(err)} />;
  }
  const applied = !!s.session.appliedAt;
  const noPhoto = s.lines.filter((l) => !l.result || l.result === "found" || l.result === "new").filter((l) => l.photoCount === 0);

  return (
    <>
      <div className="page-head">
        <Link href="/parts/count" className="back">
          ← Сессии
        </Link>
        <h1>
          Инвентаризация: {partLocationLabel(s.session.location).toLowerCase()} · {когда(s.session.startedAt)}
        </h1>
        <p>
          {s.session.reversesId
            ? "Обратная сессия — откат применённой."
            : applied
              ? `Применена ${когда(s.session.appliedAt)}.`
              : s.session.finishedAt
                ? "Сотрудник закончил — ждёт применения."
                : "Идёт: строки появляются по мере ввода в боте."}{" "}
          Найдено {s.found}
          {s.moved ? ` (числились не здесь: ${s.moved})` : ""} · новых {s.fresh} · не найдено {s.missing.length}
          {!applied && s.expected.length > 0 ? ` · ожидалось ${s.expected.length}` : ""}
          {noPhoto.length > 0 ? ` · без фото ${noPhoto.length}` : ""}
        </p>
      </div>

      <section className="group-block">
        <PartCountActions summary={s} />
      </section>

      <section className="group-block">
        <div className="section-title">
          Строки
          <span className="group-count">{s.lines.length}</span>
        </div>
        {s.lines.length === 0 ? (
          <div className="empty">
            <b>Строк пока нет</b>
            Бот добавит их по одному узлу: вид → номер → серийник → фото.
          </div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table className="tbl">
              <thead>
                <tr>
                  <th>Узел</th>
                  <th>Введено</th>
                  <th>Фото</th>
                  <th>Итог</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {s.lines.map((l) => {
                  const st = lineStatus(l, applied);
                  return (
                    <tr key={l.id}>
                      <td>
                        {l.partUnitId ? <Link href={`/parts/${l.partUnitId}`}>{l.label}</Link> : l.label}
                        <div className="hint">{partLabel(l.partKind)}</div>
                      </td>
                      <td className="mono">
                        {l.inventoryNoEntered ?? "—"}
                        {l.serialEntered ? ` · S/N ${l.serialEntered}` : ""}
                      </td>
                      <td>
                        {l.photoCount > 0 ? (
                          <span className="pill ok">{l.photoCount}</span>
                        ) : l.photoSkippedReason ? (
                          <span className="pill act" title={l.photoSkippedReason}>
                            без фото: {l.photoSkippedReason}
                          </span>
                        ) : l.result === "missing" || l.result === "reversed" ? (
                          "—"
                        ) : (
                          <span className="pill bad">нет</span>
                        )}
                      </td>
                      <td>
                        <span className={`pill ${st.cls}`}>{st.text}</span>
                        {l.result === "found" && l.prevLocation ? (
                          <div className="hint">был: {l.prevLocation === "machine" ? "на автомате" : partLocationLabel(l.prevLocation).toLowerCase()}</div>
                        ) : null}
                      </td>
                      <td>{!applied && !l.result ? <RemoveLineButton sessionId={s.session.id} lineId={l.id} /> : null}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {!applied && !s.session.reversesId && (
        <section className="group-block">
          <div className="section-title">
            Ещё не найдены
            <span className="group-count">{s.missing.length}</span>
          </div>
          {s.missing.length === 0 ? (
            <div className="empty">
              <b>Все числящиеся здесь узлы посчитаны</b>
              {s.expected.length === 0 ? "По учёту в этом месте ничего не лежало." : "Применение ничего не переведёт в «неизвестно где»."}
            </div>
          ) : (
            <>
              <div className="rows">
                {s.missing.map((u) => (
                  <Link key={u.id} className="row" href={`/parts/${u.id}`}>
                    <span className="t">{u.label}</span>
                    <span className="pill mono">с {u.where?.since ?? "—"}</span>
                  </Link>
                ))}
              </div>
              <p className="hint">При применении эти узлы уйдут в «местонахождение неизвестно» — найдутся на следующей инвентаризации или при замене.</p>
            </>
          )}
        </section>
      )}

      {applied && s.missing.length > 0 && (
        <section className="group-block">
          <div className="section-title">
            Не найдены
            <span className="group-count">{s.missing.length}</span>
          </div>
          <div className="rows">
            {s.missing.map((u) => (
              <Link key={u.id} className="row" href={`/parts/${u.id}`}>
                <span className="t">{u.label}</span>
                <span className="pill bad">{u.where ? partLocationLabel(u.where.location).toLowerCase() : "без места"}</span>
              </Link>
            ))}
          </div>
        </section>
      )}
    </>
  );
}
