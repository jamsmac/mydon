"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import type { BrvValue, TnvedRate } from "../lib/core";
import { deactivateTnvedRate, saveTnvedRate, setBrvValue } from "../app/catalog/actions";

/**
 * Справочник растаможки GLOBERENT: ставки ТН ВЭД + БРВ (перенос PROMACH).
 * Проценты показываются процентами (5%), в базе живут долями (0.05).
 */

const pct = (share: string): string => `${(Number(share) * 100).toLocaleString("ru-RU")}%`;
const nfmt = (v: string | number): string => Number(v).toLocaleString("ru-RU");

function TnvedForm({ domain, initial, onDone }: { domain: string; initial?: TnvedRate; onDone: () => void }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function onSubmit(form: FormData) {
    start(async () => {
      const res = await saveTnvedRate(domain, form);
      if (res.ok) {
        setError(null);
        onDone();
        router.refresh();
      } else {
        setError(res.message ?? "Не получилось");
      }
    });
  }

  const sharePct = (share: string | undefined): string =>
    share === undefined ? "" : String(Number(share) * 100);

  return (
    <form
      className="form card"
      style={{ marginTop: 10 }}
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit(new FormData(event.currentTarget));
      }}
    >
      {initial && <input type="hidden" name="id" value={initial.id} />}
      <label>
        <span>Код ТН ВЭД</span>
        <input name="code" defaultValue={initial?.code ?? ""} placeholder="8429519900" autoFocus />
      </label>
      <label>
        <span>Название товара</span>
        <input name="nameRu" defaultValue={initial?.nameRu ?? ""} placeholder="Погрузчик фронтальный…" />
      </label>
      <label>
        <span>Пошлина, %</span>
        <input name="dutyPct" inputMode="decimal" defaultValue={sharePct(initial?.importDutyRate)} placeholder="5" />
      </label>
      <label>
        <span>Сбор за оформление, % (стандарт 0.2)</span>
        <input name="feePct" inputMode="decimal" defaultValue={sharePct(initial?.customsFeeRate)} placeholder="0.2" />
      </label>
      <label>
        <span>НДС, %</span>
        <input name="vatPct" inputMode="decimal" defaultValue={sharePct(initial?.vatRate)} placeholder="12" />
      </label>
      <label>
        <span>Акциз, % (обычно 0)</span>
        <input name="excisePct" inputMode="decimal" defaultValue={sharePct(initial?.exciseRate)} placeholder="0" />
      </label>
      <label>
        <span>Утильсбор, БРВ (0 — не облагается)</span>
        <input name="utilBrv" inputMode="numeric" defaultValue={initial?.utilizationBrvCount ?? ""} placeholder="0" />
      </label>
      <label>
        <span>Доп. пошлина, $/см³ (0 — нет)</span>
        <input name="extraCc" inputMode="decimal" defaultValue={initial?.extraDutyPerCcUsd ?? ""} placeholder="0" />
      </label>
      <label>
        <span>Масса брутто от–до, кг (для проверки расчёта)</span>
        <span style={{ display: "flex", gap: 8 }}>
          <input name="massMin" inputMode="numeric" defaultValue={initial?.grossMassMinKg ?? ""} placeholder="от" />
          <input name="massMax" inputMode="numeric" defaultValue={initial?.grossMassMaxKg ?? ""} placeholder="до" />
        </span>
      </label>
      <label>
        <span>Допустимые двигатели через запятую (пусто — любой)</span>
        <input name="engines" defaultValue={initial?.engineTypeConstraint ?? ""} placeholder="diesel,electric" />
      </label>
      <label>
        <span>Заметка</span>
        <input name="notes" defaultValue={initial?.notes ?? ""} />
      </label>
      <div className="form-actions">
        <button type="submit" className="btn primary" disabled={pending}>
          {pending ? "…" : initial ? "Сохранить" : "Добавить ставку"}
        </button>
        <button type="button" className="btn" onClick={onDone}>
          Отмена
        </button>
        {error && <span className="err-text">{error}</span>}
      </div>
    </form>
  );
}

export function CustomsRatesPanel({
  domain,
  rates,
  brv,
}: {
  domain: string;
  rates: TnvedRate[];
  brv: BrvValue[];
}) {
  const router = useRouter();
  const [editing, setEditing] = useState<string | null>(null); // id | "new" | null
  const [pending, start] = useTransition();
  const [brvMsg, setBrvMsg] = useState<string | null>(null);
  const [rateMsg, setRateMsg] = useState<string | null>(null);

  const currentBrv = brv[0] ?? null;

  function removeRate(id: string) {
    if (!window.confirm("Убрать ставку из работы? Строка останется в истории.")) return;
    start(async () => {
      const res = await deactivateTnvedRate(domain, id);
      if (res.ok) {
        setRateMsg(null);
        router.refresh();
      } else {
        setRateMsg(res.message ?? "Не получилось");
      }
    });
  }

  function onBrvSubmit(form: FormData, formElement: HTMLFormElement) {
    start(async () => {
      const res = await setBrvValue(domain, form);
      setBrvMsg(res.ok ? "БРВ записана" : (res.message ?? "Не получилось"));
      if (res.ok) {
        formElement.reset();
        router.refresh();
      }
    });
  }

  return (
    <>
      {/* ── БРВ: базовая расчётная величина (утильсбор = БРВ × count) ── */}
      <div className="sect" style={{ marginTop: 0 }}>
        <div className="sect-h">
          <h3 className="h2">БРВ</h3>
          {currentBrv !== null && (
            <span className="chip b">{nfmt(currentBrv.valueUzs)} сум · с {currentBrv.validFrom}</span>
          )}
        </div>
        <form
          className="form"
          style={{ display: "flex", gap: 8, alignItems: "flex-end", flexWrap: "wrap" }}
          onSubmit={(event) => {
            event.preventDefault();
            onBrvSubmit(new FormData(event.currentTarget), event.currentTarget);
          }}
        >
          <label style={{ margin: 0 }}>
            <span>Сумов</span>
            <input name="valueUzs" inputMode="numeric" placeholder="412000" />
          </label>
          <label style={{ margin: 0 }}>
            <span>Действует с</span>
            <input name="validFrom" type="date" />
          </label>
          <label style={{ margin: 0 }}>
            <span>Заметка</span>
            <input name="note" placeholder="постановление…" />
          </label>
          <button type="submit" className="btn sm" disabled={pending}>Задать БРВ</button>
          {brvMsg && <span className="hint">{brvMsg}</span>}
        </form>
      </div>

      {/* ── Ставки ТН ВЭД ── */}
      <div className="sect">
        <div className="sect-h">
          <h3 className="h2">Ставки ТН ВЭД</h3>
          <span className="chip">действующих · {rates.length}</span>
        </div>
        {rates.length === 0 ? (
          <div className="empty">
            <b>Ставок пока нет</b>
            Добавь коды ТН ВЭД погрузчиков (например 8429519900) — по ним считается растаможка в калькуляторе.
          </div>
        ) : (
          <div className="book">
            <div className="th">
              <span>Код · товар</span>
              <span>Пошлина · сбор · НДС</span>
              <span style={{ textAlign: "right" }}>Утиль · $/см³</span>
            </div>
            {rates.map((r) => (
              <div className="tr" key={r.id} style={{ cursor: "pointer" }} onClick={() => setEditing(r.id)}>
                <span className="nm">
                  <b style={{ fontFamily: "var(--fm)" }}>{r.code}</b> · {r.nameRu}
                </span>
                <span className="cd">
                  {pct(r.importDutyRate)} · {pct(r.customsFeeRate)} · {pct(r.vatRate)}
                </span>
                <span className="pr">
                  {r.utilizationBrvCount > 0 ? `${r.utilizationBrvCount} БРВ` : "—"} ·{" "}
                  {Number(r.extraDutyPerCcUsd) > 0 ? `${r.extraDutyPerCcUsd}$` : "—"}
                  <button
                    type="button"
                    className="btn sm"
                    style={{ marginLeft: 8 }}
                    disabled={pending}
                    onClick={(e) => {
                      e.stopPropagation();
                      removeRate(r.id);
                    }}
                  >
                    ✕
                  </button>
                </span>
              </div>
            ))}
          </div>
        )}
        {editing === null ? (
          <button type="button" className="btn" style={{ marginTop: 10 }} onClick={() => setEditing("new")}>
            + Ставка ТН ВЭД
          </button>
        ) : (
          <TnvedForm
            domain={domain}
            initial={editing === "new" ? undefined : rates.find((r) => r.id === editing)}
            onDone={() => setEditing(null)}
          />
        )}
        {rateMsg && <p className="err-text">{rateMsg}</p>}
        <p className="hint" style={{ marginTop: 8 }}>
          Проценты вводятся процентами (5 = 5%). Ставки — основа расчёта растаможки:
          пошлина и сбор от таможенной базы, НДС сверху, утиль в БРВ, доп. пошлина за см³ двигателя.
        </p>
      </div>
    </>
  );
}
