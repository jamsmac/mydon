import Link from "next/link";
import { notFound } from "next/navigation";
import { fmtMoney, paymentBadge } from "@mydon/shared";
import { core, CoreUnavailable, type GrContractDetail } from "../../../lib/core";
import { CoreDown } from "../../../components/core-down";
import {
  ContractActForm,
  ContractPaymentForm,
  ContractStatusButtons,
} from "../../../components/contract-forms";
import { fmtDay } from "../../../lib/globerent";
import { flowStatusLabel } from "../../../lib/finance-labels";
import { when } from "../../../lib/format";

export const dynamic = "force-dynamic";

const STATUS_RU: Record<string, string> = {
  active: "действует",
  closed: "закрыт",
  cancelled: "отменён",
};

/** Карточка UZS-договора: спецификация, оплата, график, акты (перенос PROMACH). */
export default async function ContractPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let c: GrContractDetail;
  try {
    c = await core.contract(id);
  } catch (err) {
    if (err instanceof CoreUnavailable && err.detail.includes("404")) notFound();
    return <CoreDown detail={err instanceof CoreUnavailable ? err.detail : String(err)} />;
  }

  const total = Number(c.totalWithVat);
  const badge = paymentBadge(c.paidUzs, total);
  const buyer = c.buyer ?? {};

  return (
    <>
      <div className="page-head">
        <nav className="crumbs" aria-label="Хлебные крошки">
          <Link href="/mydon">MYDON</Link>
          <span className="sep">/</span>
          <Link href="/domain/globerent?tab=docs:contract">Договоры</Link>
          <span className="sep">/</span>
          <span className="cur">№ {c.contractNo}/ОП</span>
        </nav>
        <h1 className="h1">Договор № {c.contractNo}/ОП</h1>
        <p className="lead">
          от {fmtDay(c.contractDate)} · {STATUS_RU[c.status] ?? c.status} · {badge}
        </p>
      </div>

      <div className="tiles">
        <div className="tile">
          <div className="lab">Сумма с НДС</div>
          <div className="v" style={{ fontSize: 20 }}>{fmtMoney(total)} <span className="u">сум</span></div>
          <div className="foot"><span className="mk" />НДС 12%: {fmtMoney(Number(c.totalVat))} сум</div>
        </div>
        <div className={`tile ${c.paidUzs >= total && total > 0 ? "" : c.paidUzs > 0 ? "" : "zero"}`}>
          <div className="lab">Оплачено (сум. экв.)</div>
          <div className="v" style={{ fontSize: 20 }}>{fmtMoney(c.paidUzs)}</div>
          <div className="foot"><span className="mk" />{badge} · платежей: {c.paymentsCount}</div>
        </div>
        <div className={`tile ${c.actsCount > 0 ? "" : "zero"}`}>
          <div className="lab">Актов передачи</div>
          <div className="v">{c.actsCount}</div>
          <div className="foot"><span className="mk" />{c.actsCount > 0 ? "техника передаётся" : "не передавалась"}</div>
        </div>
      </div>

      <div className="sect">
        <div className="sect-h">
          <h3 className="h2">Статус</h3>
          <span className={`chip ${c.status === "active" ? "g" : c.status === "cancelled" ? "h" : ""}`}>
            {STATUS_RU[c.status] ?? c.status}
          </span>
        </div>
        <ContractStatusButtons id={c.id} status={c.status} />
        <p className="hint" style={{ marginTop: 6 }}>
          Между «закрыт» и «отменён» — только через «действует». По отменённому платежи и акты не принимаются.
        </p>
      </div>

      {/* ── Покупатель: snapshot на момент подписания ── */}
      <div className="sect">
        <div className="sect-h">
          <h3 className="h2">Покупатель</h3>
          {c.clientId !== null && (
            <Link href={`/card/${c.clientId}`} className="chip b">карточка в реестре →</Link>
          )}
        </div>
        <div className="pass">
          {[
            ["Название", buyer.name ?? c.clientName],
            ["Директор", buyer.director],
            ["ИНН", buyer.inn],
            ["Адрес", buyer.address],
            ["Р/с", buyer.account],
            ["Банк", buyer.bank],
            ["МФО", buyer.mfo],
            ["Телефон", buyer.phone],
          ]
            .filter(([, v]) => v)
            .map(([k, v]) => (
              <div className="f" key={String(k)}>
                <small style={{ color: "var(--tx-3)" }}>{k}</small>
                <div>{v}</div>
              </div>
            ))}
        </div>
        <p className="hint" style={{ marginTop: 6 }}>
          Реквизиты — снимок на момент подписания: правки карточки в реестре договор не меняют.
        </p>
      </div>

      {/* ── Спецификация ── */}
      <div className="sect">
        <div className="sect-h"><h3 className="h2">Спецификация</h3></div>
        <div className="book">
          <div className="th">
            <span>Наименование</span>
            <span>Кол-во</span>
            <span style={{ textAlign: "right" }}>Сумма с НДС</span>
          </div>
          {c.items.map((it, i) => (
            <div className="tr" key={i}>
              <span className="nm">{it.name}</span>
              <span className="cd">×{it.qty}</span>
              <span className="pr">{fmtMoney(it.qty * it.price)} <span className="u">сум</span></span>
            </div>
          ))}
        </div>
      </div>

      {/* ── Оплата ── */}
      <div className="sect">
        <div className="sect-h">
          <h3 className="h2">Платежи</h3>
          {total > 0 && (
            <span className={`chip ${c.paidUzs >= total ? "g" : "h"}`}>
              {Math.min(100, Math.round((c.paidUzs / total) * 100))}%
            </span>
          )}
        </div>
        {c.status !== "cancelled" && <ContractPaymentForm id={c.id} />}
        {c.payments.length > 0 && (
          <div style={{ marginTop: 10 }}>
            {c.payments.map((p) => (
              <div className="trow" key={p.id}>
                <div className="tb">
                  <div className="tt">
                    {Number(p.amount).toLocaleString("ru-RU")} {p.currency === "UZS" ? "сум" : p.currency}
                  </div>
                  <div className="tm">
                    {when(p.date)}
                    {p.docNo !== null ? ` · платёжка ${p.docNo}` : ""}
                    {p.currency !== "UZS" && p.amountUzs !== null
                      ? ` · ≈ ${Number(p.amountUzs).toLocaleString("ru-RU")} сум`
                      : ""}
                  </div>
                </div>
                <span className="due">{flowStatusLabel(p.status)}</span>
              </div>
            ))}
          </div>
        )}
        {c.planned.length > 0 && (
          <>
            <p className="hint" style={{ marginTop: 10, marginBottom: 4 }}>График (обязательства со сроками):</p>
            {c.planned.map((p) => (
              <div className="trow" key={p.id}>
                <div className="tb">
                  <div className="tt">{Number(p.amount).toLocaleString("ru-RU")} {p.currency === "UZS" ? "сум" : p.currency}</div>
                  <div className="tm">{p.purpose ?? "по графику"}</div>
                </div>
                <span className="due">{p.dueDate !== null ? `до ${fmtDay(p.dueDate)}` : "срок не задан"}</span>
              </div>
            ))}
          </>
        )}
        <p className="hint" style={{ marginTop: 8 }}>
          Каждый платёж — запись финконтура: договор виден в агинге и «к сроку» вкладки «Финансы».
          Оплаченность считается в сумовом эквиваленте — валюты не складываются сырыми числами.
        </p>
      </div>

      {/* ── Акты ── */}
      <div className="sect">
        <div className="sect-h"><h3 className="h2">Акты приёма-передачи</h3></div>
        {c.status !== "cancelled" && <ContractActForm id={c.id} />}
        {c.acts.length > 0 && (
          <div style={{ marginTop: 10 }}>
            {c.acts.map((a) => (
              <div className="trow" key={a.id}>
                <div className="tb">
                  <div className="tt">Акт № {a.actNo} от {fmtDay(a.actDate)}</div>
                  <div className="tm">
                    {[a.signedBySeller, a.signedByBuyer].filter(Boolean).join(" · ") || "подписанты не указаны"}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
