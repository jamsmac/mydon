"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import type { FinanceCounterparty, FxCurrent } from "../lib/core";
import {
  cancelFinanceFlow,
  createFinanceFlow,
  payFinanceFlow,
  refreshFxRates,
  setFxRate,
} from "../app/finance/actions";

import { CATEGORY_LABELS } from "../lib/finance-labels";

/** Категории — словарь Core (FLOW_CATEGORIES) с русскими подписями. */
const CATEGORIES = Object.entries(CATEGORY_LABELS).map(([value, label]) => ({ value, label }));

/**
 * Форма ввода денег — единственная дверь money-домена (принцип MYDON).
 * Поля — модель платежа PROMACH: направление, план/факт, сумма+валюта+курс,
 * контрагент, категория, способ, срок, номер документа.
 */
export function NewFlowForm({
  domain,
  counterparties,
  fx,
  units = [],
}: {
  domain: string;
  counterparties: FinanceCounterparty[];
  fx: FxCurrent[];
  /** Единицы техники — для привязки расхода к себестоимости. */
  units?: { id: string; label: string }[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [currency, setCurrency] = useState("UZS");

  function onSubmit(form: FormData) {
    start(async () => {
      const res = await createFinanceFlow(domain, form);
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
      <button type="button" className="btn" onClick={() => setOpen(true)}>
        + Долг или платёж
      </button>
    );
  }

  const knownRate = fx.find((r) => r.currency === currency)?.rate ?? null;

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
        <span>Что заводим</span>
        <select name="status" defaultValue="planned">
          <option value="planned">обязательство — оплата ещё впереди</option>
          <option value="actual">платёж — деньги уже прошли</option>
        </select>
      </label>
      <label>
        <span>Направление</span>
        <select name="direction" defaultValue="in">
          <option value="in">нам должны / нам заплатили</option>
          <option value="out">мы должны / мы заплатили</option>
        </select>
      </label>
      <label>
        <span>Сумма</span>
        <input name="amount" inputMode="decimal" placeholder="150 000 000" autoFocus />
      </label>
      <label>
        <span>Валюта</span>
        <select name="currency" value={currency} onChange={(e) => setCurrency(e.target.value)}>
          <option value="UZS">сум</option>
          <option value="USD">USD</option>
          <option value="CNY">CNY</option>
          <option value="EUR">EUR</option>
        </select>
      </label>
      {currency !== "UZS" && (
        <label>
          <span>
            Курс к суму{knownRate !== null ? ` — можно не заполнять, возьмётся ${Number(knownRate).toLocaleString("ru-RU")}` : " — обязателен, действующего курса нет"}
          </span>
          <input name="rate" inputMode="decimal" placeholder={knownRate ?? "12500"} />
        </label>
      )}
      <label>
        <span>Контрагент из реестра</span>
        <select name="counterpartyId" defaultValue="">
          <option value="">— не привязывать —</option>
          {counterparties.map((c) => (
            <option value={c.id} key={c.id}>
              {c.name}
              {c.inn !== null ? ` · ИНН ${c.inn}` : ""}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>Или имя контрагента словами</span>
        <input name="counterparty" placeholder="ООО «…»" />
      </label>
      <label>
        <span>Категория</span>
        <select name="category" defaultValue="sale">
          {CATEGORIES.map((c) => (
            <option value={c.value} key={c.value}>{c.label}</option>
          ))}
        </select>
      </label>
      <label>
        <span>Способ</span>
        <select name="method" defaultValue="bank">
          <option value="bank">перечисление (официально)</option>
          <option value="cash">наличные (внутренний учёт)</option>
        </select>
      </label>
      {units.length > 0 && (
        <label>
          <span>Единица техники — расход войдёт в её себестоимость</span>
          <select name="unitId" defaultValue="">
            <option value="">— не привязывать —</option>
            {units.map((u) => (
              <option value={u.id} key={u.id}>{u.label}</option>
            ))}
          </select>
        </label>
      )}
      <label>
        <span>Срок оплаты — по нему считается просрочка</span>
        <input name="dueDate" type="date" />
      </label>
      <label>
        <span>Номер документа — можно позже</span>
        <input name="docNo" placeholder="счёт №…" />
      </label>
      <label>
        <span>Назначение словами</span>
        <input name="purpose" placeholder="предоплата за CPCD30…" />
      </label>
      <div className="form-actions">
        <button type="submit" className="btn primary" disabled={pending}>
          {pending ? "…" : "Записать"}
        </button>
        <button type="button" className="btn" onClick={() => setOpen(false)}>
          Отмена
        </button>
        {error && <span className="err-text">{error}</span>}
      </div>
    </form>
  );
}

/** Кнопки строки записи: оплатить (для плана) и отменить (след остаётся). */
export function FlowRowActions({ domain, id, status }: { domain: string; id: string; status: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const run = (fn: () => Promise<{ ok: boolean; message?: string }>) => {
    start(async () => {
      const res = await fn();
      if (res.ok) {
        setError(null);
        router.refresh();
      } else {
        setError(res.message ?? "Не получилось");
      }
    });
  };

  return (
    <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
      {status === "planned" && (
        <button
          type="button"
          className="btn sm"
          disabled={pending}
          onClick={() => run(() => payFinanceFlow(domain, id))}
        >
          оплачено
        </button>
      )}
      {status !== "cancelled" && (
        <button
          type="button"
          className="btn sm"
          disabled={pending}
          onClick={() => {
            if (window.confirm("Отменить запись? Строка останется в журнале.")) {
              run(() => cancelFinanceFlow(domain, id));
            }
          }}
        >
          ✕
        </button>
      )}
      {error && <span className="err-text">{error}</span>}
    </span>
  );
}

/** Установка курса валюты к суму — ручной override, как в PROMACH. */
export function FxForm({ domain }: { domain: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);

  function onSubmit(form: FormData, formElement: HTMLFormElement) {
    start(async () => {
      const res = await setFxRate(domain, form);
      setMsg(res.ok ? "Курс записан" : (res.message ?? "Не получилось"));
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
        <span>Валюта</span>
        <select name="currency" defaultValue="USD">
          <option value="USD">USD</option>
          <option value="CNY">CNY</option>
          <option value="EUR">EUR</option>
          <option value="RUB">RUB</option>
        </select>
      </label>
      <label style={{ margin: 0 }}>
        <span>Сумов за единицу</span>
        <input name="rate" inputMode="decimal" placeholder="12500" />
      </label>
      <label style={{ margin: 0 }}>
        <span>Заметка</span>
        <input name="note" placeholder="курс ЦБ на сегодня" />
      </label>
      <button type="submit" className="btn sm" disabled={pending}>
        {pending ? "…" : "Задать курс"}
      </button>
      <button
        type="button"
        className="btn sm"
        disabled={pending}
        onClick={() =>
          start(async () => {
            const res = await refreshFxRates(domain);
            setMsg(res.message ?? (res.ok ? "Курсы обновлены" : "Не получилось"));
            if (res.ok) router.refresh();
          })
        }
      >
        {pending ? "…" : "Обновить из ЦБ"}
      </button>
      {msg && <span className="hint">{msg}</span>}
    </form>
  );
}
