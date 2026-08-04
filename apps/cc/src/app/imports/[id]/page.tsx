import Link from "next/link";
import { notFound } from "next/navigation";
import {
  IMPORT_LIFECYCLE_LABELS,
  UNIT_STATUS_LABELS,
  type ImportLifecycle,
  type UnitStatus,
} from "@mydon/shared";
import { core, CoreUnavailable, type GrImportDetail } from "../../../lib/core";
import { CoreDown } from "../../../components/core-down";
import { ImportContractActions } from "../../../components/import-actions";
import { fmtDay } from "../../../lib/globerent";

export const dynamic = "force-dynamic";

const STATUS_RU: Record<string, string> = {
  draft: "черновик",
  in_progress: "в работе",
  completed: "завершён",
  cancelled: "отменён",
};

const nfmt = (v: string | number): string => Number(v).toLocaleString("ru-RU");

/** Карточка импортного контракта: график, единицы, массовые действия. */
export default async function ImportPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let c: GrImportDetail;
  try {
    c = await core.importContract(id);
  } catch (err) {
    if (err instanceof CoreUnavailable && err.detail.includes("404")) notFound();
    return <CoreDown detail={err instanceof CoreUnavailable ? err.detail : String(err)} />;
  }

  const lc = IMPORT_LIFECYCLE_LABELS[c.lifecycleStatus as ImportLifecycle] ?? c.lifecycleStatus;

  return (
    <>
      <div className="page-head">
        <nav className="crumbs" aria-label="Хлебные крошки">
          <Link href="/mydon">MYDON</Link>
          <span className="sep">/</span>
          <Link href="/domain/globerent?tab=imports">Импорт</Link>
          <span className="sep">/</span>
          <span className="cur">№ {c.contractNo}</span>
        </nav>
        <h1 className="h1">Импортный контракт № {c.contractNo}</h1>
        <p className="lead">
          {c.supplierName ?? "поставщик не указан"} · от {fmtDay(c.contractDate)} ·{" "}
          {STATUS_RU[c.status] ?? c.status} · этап: {lc}
        </p>
      </div>

      <div className="tiles">
        <div className="tile">
          <div className="lab">Сумма контракта</div>
          <div className="v" style={{ fontSize: 20 }}>{nfmt(c.totalAmount)} <span className="u">{c.currency}</span></div>
          <div className="foot"><span className="mk" />позиций: {c.items.length}</div>
        </div>
        <div className={`tile ${c.prepaymentAmount !== null && c.prepaymentPaidAt === null ? "is-hot" : "zero"}`}>
          <div className="lab">Предоплата заводу</div>
          <div className="v" style={{ fontSize: 20 }}>
            {c.prepaymentAmount !== null ? nfmt(c.prepaymentAmount) : "—"}
          </div>
          <div className="foot"><span className="mk" />
            {c.prepaymentAmount === null
              ? "не предусмотрена"
              : c.prepaymentPaidAt !== null
                ? "оплачена"
                : c.prepaymentDueDate !== null
                  ? `срок ${fmtDay(c.prepaymentDueDate)}`
                  : "срок не задан"}
          </div>
        </div>
        <div className={`tile ${c.balanceAmount !== null && c.balancePaidAt === null ? "is-hot" : "zero"}`}>
          <div className="lab">Балансовый платёж</div>
          <div className="v" style={{ fontSize: 20 }}>
            {c.balanceAmount !== null ? nfmt(c.balanceAmount) : "—"}
          </div>
          <div className="foot"><span className="mk" />
            {c.balanceAmount === null
              ? "не предусмотрен"
              : c.balancePaidAt !== null
                ? "оплачен"
                : c.balanceDueDate !== null
                  ? `срок ${fmtDay(c.balanceDueDate)}`
                  : "срок не задан"}
          </div>
        </div>
        <div className={`tile ${c.unitsActive > 0 ? "" : "zero"}`}>
          <div className="lab">Единиц техники</div>
          <div className="v">{c.unitsActive}</div>
          <div className="foot"><span className="mk" />
            {c.unitsTotal === 0 ? "материализуются подписанием" : "смотри вкладку «Склад»"}
          </div>
        </div>
      </div>

      <div className="sect">
        <div className="sect-h"><h3 className="h2">Действия</h3></div>
        <ImportContractActions
          id={c.id}
          status={c.status}
          prepaymentPaid={c.prepaymentPaidAt !== null}
          balancePaid={c.balancePaidAt !== null}
          hasPrepayment={c.prepaymentAmount !== null}
          hasBalance={c.balanceAmount !== null}
        />
        <p className="hint" style={{ marginTop: 8 }}>
          Массовые действия двигают только единицы, чей статус это позволяет
          (fromStatuses донора) — продвинутые не откатываются и считаются «пропущенными».
          Этап контракта пересчитывается монотонно: только вперёд.
        </p>
      </div>

      <div className="sect">
        <div className="sect-h"><h3 className="h2">Спецификация</h3></div>
        <div className="book">
          <div className="th">
            <span>Наименование</span>
            <span>Кол-во</span>
            <span style={{ textAlign: "right" }}>Сумма</span>
          </div>
          {c.items.map((it, i) => (
            <div className="tr" key={i}>
              <span className="nm">{it.name}</span>
              <span className="cd">×{it.qty}</span>
              <span className="pr">{nfmt(it.qty * it.price)} <span className="u">{c.currency}</span></span>
            </div>
          ))}
        </div>
      </div>

      {c.units.length > 0 && (
        <div className="sect">
          <div className="sect-h">
            <h3 className="h2">Единицы контракта</h3>
            <Link href="/domain/globerent?tab=units" className="chip b">весь склад →</Link>
          </div>
          {c.units.map((u) => (
            <div className="trow" key={u.id}>
              <div className="tb">
                <div className="tt">{u.code} · {u.name}</div>
                <div className="tm">
                  {UNIT_STATUS_LABELS[u.status as UnitStatus] ?? u.status}
                  {u.vin !== null ? ` · VIN ${u.vin}` : " · VIN не привязан"}
                  {u.declarationNumber !== null ? ` · ГТД ${u.declarationNumber}` : ""}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
