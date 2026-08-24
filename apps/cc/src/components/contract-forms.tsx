"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { contractTotals, fmtMoney } from "@mydon/shared";
import type { FinanceCounterparty } from "../lib/core";
import {
  addContractAct,
  addContractPayment,
  createContract,
  setContractStatus,
} from "../app/contracts/actions";

interface DraftItem {
  name: string;
  qty: string;
  price: string;
}

/**
 * Форма нового UZS-договора (перенос ContractModule PROMACH, упрощённая):
 * позиции динамическим списком, итоги с НДС «изнутри» считаются на лету,
 * номер можно не заполнять — сервер возьмёт следующий.
 */
export function NewContractForm({ clients }: { clients: FinanceCounterparty[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<DraftItem[]>([{ name: "", qty: "1", price: "" }]);
  const [payType, setPayType] = useState("100");
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const parsed = items
    .filter((i) => i.name.trim() !== "")
    .map((i) => ({
      name: i.name.trim(),
      qty: Number(i.qty.replace(/\s/g, "")) || 0,
      price: Number(i.price.replace(/\s/g, "").replace(",", ".")) || 0,
    }));
  const totals = contractTotals(parsed);

  function onSubmit(form: FormData) {
    form.set("items", JSON.stringify(parsed));
    start(async () => {
      const res = await createContract(form);
      if (res.ok) {
        setOpen(false);
        setItems([{ name: "", qty: "1", price: "" }]);
        setError(null);
        if (res.id !== undefined) router.push(`/contracts/${res.id}`);
        else router.refresh();
      } else {
        setError(res.message ?? "Не получилось");
      }
    });
  }

  if (!open) {
    return (
      <button type="button" className="btn" onClick={() => setOpen(true)}>
        + Договор купли-продажи
      </button>
    );
  }

  const setItem = (idx: number, patch: Partial<DraftItem>) =>
    setItems((prev) => prev.map((it, i) => (i === idx ? { ...it, ...patch } : it)));

  return (
    <form
      className="form card"
      style={{ marginTop: 10 }}
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit(new FormData(event.currentTarget));
      }}
    >
      <label>
        <span>Номер — пусто, чтобы взять следующий по порядку</span>
        <input name="contractNo" inputMode="numeric" placeholder="авто" />
      </label>
      <label>
        <span>Дата договора</span>
        <input name="contractDate" type="date" defaultValue={new Date().toLocaleDateString("en-CA")} />
      </label>
      <label>
        <span>Покупатель — карточка из реестра (реквизиты снимутся снапшотом)</span>
        <select name="clientId" defaultValue="">
          <option value="">— не привязывать —</option>
          {clients.map((c) => (
            <option value={c.id} key={c.id}>
              {c.name}
              {c.inn !== null ? ` · ИНН ${c.inn}` : ""}
            </option>
          ))}
        </select>
      </label>

      <div>
        <span style={{ fontSize: 12, color: "var(--tx-3)" }}>Спецификация (цены — с НДС)</span>
        {items.map((it, idx) => (
          <div key={idx} style={{ display: "flex", gap: 6, marginTop: 6 }}>
            <input
              placeholder="HELI CPCD30, 2026 г.в."
              value={it.name}
              onChange={(e) => setItem(idx, { name: e.target.value })}
              style={{ flex: 3 }}
            />
            <input
              placeholder="шт"
              inputMode="numeric"
              value={it.qty}
              onChange={(e) => setItem(idx, { qty: e.target.value })}
              style={{ flex: 1, minWidth: 52 }}
            />
            <input
              placeholder="цена с НДС"
              inputMode="decimal"
              value={it.price}
              onChange={(e) => setItem(idx, { price: e.target.value })}
              style={{ flex: 2 }}
            />
            {items.length > 1 && (
              <button
                type="button"
                className="btn sm"
                onClick={() => setItems((prev) => prev.filter((_, i) => i !== idx))}
              >
                ✕
              </button>
            )}
          </div>
        ))}
        <button
          type="button"
          className="btn sm"
          style={{ marginTop: 6 }}
          onClick={() => setItems((prev) => [...prev, { name: "", qty: "1", price: "" }])}
        >
          + позиция
        </button>
        {totals.totalWithVat > 0 && (
          <p className="hint" style={{ marginTop: 6 }}>
            Итого: {fmtMoney(totals.totalWithVat)} сум, включая НДС 12% — {fmtMoney(totals.totalVat)} сум.
          </p>
        )}
      </div>

      <label>
        <span>Оплата</span>
        <select name="payType" value={payType} onChange={(e) => setPayType(e.target.value)}>
          <option value="100">100% предоплата</option>
          <option value="partial">частями (транши)</option>
          <option value="install">рассрочка</option>
          <option value="post">после поставки</option>
        </select>
      </label>
      {payType === "100" && (
        <label>
          <span>Оплата в течение, банковских дней</span>
          <input name="payDays" inputMode="numeric" placeholder="5" />
        </label>
      )}
      {payType === "install" && (
        <>
          <label>
            <span>Предоплата, %</span>
            <input name="prepayPct" inputMode="numeric" placeholder="30" />
          </label>
          <label>
            <span>Месяцев рассрочки</span>
            <input name="installMonths" inputMode="numeric" placeholder="6" />
          </label>
          <label>
            <span>Ставка, % годовых (0 — равные доли)</span>
            <input name="installInterest" inputMode="decimal" placeholder="0" />
          </label>
          <label>
            <span>Первый платёж</span>
            <input name="installFirstDate" type="date" />
          </label>
        </>
      )}
      <label>
        <span>Самовывоз в течение, банковских дней после 100% оплаты</span>
        <input name="deliveryDays" inputMode="numeric" placeholder="3" />
      </label>

      <div className="form-actions">
        <button type="submit" className="btn primary" disabled={pending || parsed.length === 0}>
          {pending ? "…" : "Создать договор"}
        </button>
        <button type="button" className="btn" onClick={() => setOpen(false)}>
          Отмена
        </button>
        {error && <span className="err-text">{error}</span>}
      </div>
      <p className="hint">
        График оплат сразу станет обязательствами со сроками — договор попадёт в агинг
        и «к сроку ≤ 7 дней» на вкладке «Финансы».
      </p>
    </form>
  );
}

/** Кнопки статусов карточки договора: только разрешённые переходы. */
export function ContractStatusButtons({ id, status }: { id: string; status: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const fire = (to: string, confirmText?: string) => {
    if (confirmText !== undefined && !window.confirm(confirmText)) return;
    start(async () => {
      const res = await setContractStatus(id, to);
      if (res.ok) {
        setError(null);
        router.refresh();
      } else {
        setError(res.message ?? "Не получилось");
      }
    });
  };

  return (
    <span style={{ display: "inline-flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
      {status === "active" && (
        <>
          <button type="button" className="btn sm" disabled={pending} onClick={() => fire("closed")}>
            закрыть
          </button>
          <button
            type="button"
            className="btn sm"
            disabled={pending}
            onClick={() => fire("cancelled", "Отменить договор? Платежи и акты по нему станут недоступны.")}
          >
            отменить
          </button>
        </>
      )}
      {(status === "closed" || status === "cancelled") && (
        <button type="button" className="btn sm" disabled={pending} onClick={() => fire("active")}>
          восстановить активность
        </button>
      )}
      {error && <span className="err-text">{error}</span>}
    </span>
  );
}

/** Внесение платежа из выписки — по договору, деньги уходят в money_flow. */
export function ContractPaymentForm({ id }: { id: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);

  function onSubmit(form: FormData, formElement: HTMLFormElement) {
    start(async () => {
      const res = await addContractPayment(id, form);
      setMsg(res.ok ? "Платёж записан" : (res.message ?? "Не получилось"));
      if (res.ok) {
        formElement.reset();
        router.refresh();
      }
    });
  }

  return (
    <form
      className="form"
      style={{ display: "flex", gap: 8, alignItems: "flex-end", flexWrap: "wrap" }}
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit(new FormData(event.currentTarget), event.currentTarget);
      }}
    >
      <label style={{ margin: 0 }}>
        <span>Сумма</span>
        <input name="amount" inputMode="decimal" placeholder="50 000 000" />
      </label>
      <label style={{ margin: 0 }}>
        <span>Валюта</span>
        <select name="currency" defaultValue="UZS">
          <option value="UZS">сум</option>
          <option value="USD">USD</option>
        </select>
      </label>
      <label style={{ margin: 0 }}>
        <span>№ платёжки</span>
        <input name="docNo" placeholder="из выписки" />
      </label>
      <button type="submit" className="btn sm" disabled={pending}>
        {pending ? "…" : "Внести платёж"}
      </button>
      {msg && <span className="hint">{msg}</span>}
    </form>
  );
}

/** Акт приёма-передачи: партия позиций, подписанты. */
export function ContractActForm({ id }: { id: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function onSubmit(form: FormData) {
    start(async () => {
      const res = await addContractAct(id, form);
      if (res.ok) {
        setOpen(false);
        setError(null);
        router.refresh();
      } else {
        setError(res.message ?? "Не получилось");
      }
    });
  }

  if (!open) {
    return (
      <button type="button" className="btn sm" onClick={() => setOpen(true)}>
        + Акт приёма-передачи
      </button>
    );
  }
  return (
    <form
      className="form card"
      style={{ marginTop: 8 }}
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit(new FormData(event.currentTarget));
      }}
    >
      <label>
        <span>Номер акта</span>
        <input name="actNo" autoFocus />
      </label>
      <label>
        <span>Дата</span>
        <input name="actDate" type="date" defaultValue={new Date().toLocaleDateString("en-CA")} />
      </label>
      <label>
        <span>Подписал от продавца</span>
        <input name="signedBySeller" placeholder="ФИО" />
      </label>
      <label>
        <span>Подписал от покупателя</span>
        <input name="signedByBuyer" placeholder="ФИО" />
      </label>
      <div className="form-actions">
        <button type="submit" className="btn primary" disabled={pending}>
          {pending ? "…" : "Оформить акт"}
        </button>
        <button type="button" className="btn" onClick={() => setOpen(false)}>
          Отмена
        </button>
        {error && <span className="err-text">{error}</span>}
      </div>
    </form>
  );
}
