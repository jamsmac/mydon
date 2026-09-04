import Link from "next/link";
import { core, CoreUnavailable, type PartUnit } from "../../../lib/core";
import { CoreDown } from "../../../components/core-down";
import { WashingList, daysSince } from "../../../components/parts-washing";

export const dynamic = "force-dynamic";

const STALE_AFTER_DAYS = 3;

/** Сегодня в Ташкенте — суточные пороги считаются по рабочему дню владельца, а не по UTC. */
function todayInTashkent(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tashkent" }).format(new Date());
}

/**
 * Мойка и сушка одним экраном (У3, хвост раздела 8).
 *
 * До этого место узла смотрели фильтром на `/parts`, а двигали кнопкой на его
 * карточке — обход мойки требовал открыть каждый узел. Здесь сразу видно две
 * очереди работ и по кнопке на строку: помыл → сушка (или сразу склад, если
 * этап сушки выключен настройкой `PARTS_DRYING_STAGE`), высохло → склад.
 */
export default async function PartsWashingPage() {
  let washing: PartUnit[];
  let drying: PartUnit[];
  try {
    [washing, drying] = await Promise.all([core.parts({ location: "washing" }), core.parts({ location: "drying" })]);
  } catch (err) {
    return <CoreDown detail={err instanceof CoreUnavailable ? err.detail : String(err)} />;
  }

  const today = todayInTashkent();
  const byOldest = (a: PartUnit, b: PartUnit) => (a.where?.since ?? "").localeCompare(b.where?.since ?? "");
  washing.sort(byOldest);
  drying.sort(byOldest);
  const stale = washing.filter((u) => {
    const d = daysSince(u.where?.since, today);
    return d !== null && d > STALE_AFTER_DAYS;
  });

  return (
    <>
      <Link className="back" href="/parts">
        ← Узлы автоматов
      </Link>
      <div className="page-head">
        <h1>Мойка и сушка</h1>
        <p>
          Что помыть и что забрать на склад. Порядок сверху вниз — сначала то, что лежит дольше всех. Узел на
          автомате сюда не попадает: его снимают мастером замены.
        </p>
      </div>

      <div className="tiles">
        <div className={`tile${washing.length > 0 ? " is-hot" : " zero"}`}>
          <span className="lab">На мойке</span>
          <span className="v">{washing.length}</span>
          <span className="foot">{washing.length === 0 ? "мыть нечего" : "ждут мойки"}</span>
        </div>
        <div className={`tile${drying.length > 0 ? "" : " zero"}`}>
          <span className="lab">На сушке</span>
          <span className="v">{drying.length}</span>
          <span className="foot">{drying.length === 0 ? "сушить нечего" : "забрать на склад"}</span>
        </div>
        <div className={`tile${stale.length > 0 ? " is-hot" : " zero"}`}>
          <span className="lab">Зависли на мойке</span>
          <span className="v">{stale.length}</span>
          <span className="foot">дольше {STALE_AFTER_DAYS} суток</span>
        </div>
      </div>

      <section className="group-block">
        <div className="section-title">
          На мойке
          <span className="group-count">{washing.length}</span>
        </div>
        <WashingList
          units={washing}
          today={today}
          staleAfterDays={STALE_AFTER_DAYS}
          action={{ to: "washed", label: "Помыл", okText: "Помыт — ушёл дальше по цепочке" }}
        />
        {washing.length === 0 && (
          <div className="empty">
            <b>Мыть нечего</b>
            Узлы попадают сюда, когда их снимают с автомата на мойку — мастером замены в боте.
          </div>
        )}
      </section>

      <section className="group-block">
        <div className="section-title">
          На сушке
          <span className="group-count">{drying.length}</span>
        </div>
        <WashingList units={drying} today={today} action={{ to: "warehouse", label: "На склад", okText: "На складе" }} />
        {drying.length === 0 && (
          <div className="empty">
            <b>На сушке пусто</b>
            Помытый узел приходит сюда сам. Если этап сушки не нужен, выключите его настройкой{" "}
            <code>PARTS_DRYING_STAGE</code> — тогда «Помыл» отправит узел прямо на склад.
          </div>
        )}
      </section>
    </>
  );
}
