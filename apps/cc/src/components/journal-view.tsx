"use client";

import Link from "next/link";
import { useState } from "react";
import type { FieldState, Journal, JournalField, JournalOrder } from "../lib/core";

/**
 * Что означает цвет.
 *
 * Владелец обязан различать три разные вещи, которые в обычной таблице
 * сливаются: цифру первоисточника, наш вывод и результат сверки. Поэтому цвет
 * здесь не украшение, а часть смысла, и рядом всегда стоит подпись словами.
 */
const STATE_LABEL: Record<FieldState, string> = {
  source: "первоисточник",
  unchecked: "не сверено",
  matched: "сверено",
  mismatch: "расходится",
  absent: "нет данных",
};

function num(v: string): string {
  const n = Number(String(v).replace(",", "."));
  return Number.isFinite(n) ? n.toLocaleString("ru-RU") : v;
}

/** Время источника: день и часы, как в панели. */
function when(ts: string): string {
  const d = ts.slice(0, 10).split("-");
  const t = ts.slice(11, 16);
  return d.length === 3 ? `${d[2]}.${d[1]} ${t}` : ts;
}

/** Одна величина: значение, откуда взято, и ссылка в первоисточник. */
function Field({
  f,
  hrefOf,
}: {
  f: JournalField;
  hrefOf: (f: JournalField) => string | null;
}) {
  const href = hrefOf(f);
  const value = f.value ?? "—";
  return (
    <div className={`jf s-${f.state}`}>
      <span className="jfl">{f.label}</span>
      <span className="jfv mono">
        {href ? (
          <Link href={href} className="jflink">
            {value}
          </Link>
        ) : (
          value
        )}
      </span>
      {f.note && <span className="jfn">{f.note}</span>}
    </div>
  );
}

/** Строка журнала: главное в свёрнутом виде, родословная — в раскрытом. */
function OrderRow({
  o,
  hrefOf,
}: {
  o: JournalOrder;
  hrefOf: (f: JournalField) => string | null;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`jrow s-${o.state} ${open ? "open" : ""}`}>
      <button type="button" className="jhead" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="jtoggle" aria-hidden>
          {open ? "−" : "+"}
        </span>
        <span className="jts mono">{when(o.ts)}</span>
        <span className="jmach">
          {o.machineName ?? o.machine}
          <span className="jsub mono">{o.machine}</span>
        </span>
        <span className="jprod">
          {o.product}
          {o.productEntityId === null && <span className="chip h">нет карточки</span>}
        </span>
        <span className="jamt mono">{num(o.amount)}</span>
        <span className="jpay">
          {o.paymentLabel ?? o.payment}
          {o.paymentLabel && !o.paymentConfirmed && <span className="jsub">не подтверждено</span>}
        </span>
        <span className={`jstate s-${o.state}`}>{STATE_LABEL[o.state]}</span>
      </button>

      {open && (
        <div className="jbody">
          {o.groups.map((g) => (
            <div className={`jgrp o-${g.origin}`} key={g.title}>
              <div className="jgh">
                <b>{g.title}</b>
                <span className="jsub">{g.subtitle}</span>
              </div>
              <div className="jfields">
                {g.fields.map((f) => (
                  <Field key={f.label} f={f} hrefOf={hrefOf} />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Журнал продаж по заказам источника.
 *
 * Первоисточник и наш вывод не смешиваются: номер заказа, машинный код, ресурс
 * заказа, статус платежа, цена и время — это то, что отдала панель, и оно так и
 * подписано. Карточка автомата, точка на момент заказа и цена периода — уже наш
 * вывод, и он помечен иначе. Сверка с другими источниками — третий род, и пока
 * она дневная, так и написано.
 *
 * Каждая величина ведёт по ссылке к своему первоисточнику: цифра панели — к той
 * самой строке выгрузки, наш вывод — к срезу, где он посчитан.
 */
export function JournalView({
  journal,
  base,
  sp,
  sourceCode,
  reportCode,
}: {
  journal: Journal;
  /** Адрес страницы направления — от него строятся все ссылки. */
  base: string;
  sp: Record<string, string>;
  sourceCode: string;
  reportCode: string;
}) {
  if (journal.snapshot === null) {
    return (
      <div className="empty">
        <b>Журнал пуст</b>
        Выгрузка заказов ещё не загружена — журналу нечего показывать.
      </div>
    );
  }
  if (journal.orders.length === 0) {
    return (
      <div className="empty">
        <b>Под фильтр ничего не подошло</b>
        Сними фильтр или поменяй запрос.
      </div>
    );
  }

  const link = (params: Record<string, string | null>) => {
    const p = new URLSearchParams(sp);
    for (const [k, v] of Object.entries(params)) {
      if (v === null) p.delete(k);
      else p.set(k, v);
    }
    return `${base}?${p.toString()}`;
  };

  // Ссылка ведёт туда, откуда величина взялась: цифра панели — в саму строку
  // выгрузки, наш вывод — в срез, где он посчитан.
  const hrefOf = (f: JournalField): string | null => {
    const l = f.link;
    if (!l) return null;
    if (l.kind === "card") return l.ref ? `/card/${l.ref}` : null;
    if (l.kind === "raw") {
      if (journal.externalIdColumn < 0 || !l.ref) return null;
      return link({ view: null, [`f${journal.externalIdColumn}`]: `=${l.ref}`, page: null });
    }
    return link({ view: l.kind === "goods" ? "goods" : l.kind, page: null });
  };

  const pages = Math.max(1, Math.ceil(journal.total / journal.size));
  const unchecked = journal.orders.length - journal.checked;

  return (
    <>
      <div className="tiles" style={{ marginBottom: 14 }}>
        <div className="tile mini">
          <div className="lab">Заказов в выгрузке</div>
          <div className="v">{journal.total.toLocaleString("ru-RU")}</div>
          <div className="foot">
            <span className="mk" />
            страница {journal.page} из {pages}
          </div>
        </div>
        <div className={`tile mini ${journal.checked > 0 ? "" : "zero"}`}>
          <div className="lab">Сверено на странице</div>
          <div className="v">{journal.checked}</div>
          <div className="foot">
            <span className="mk" />
            из {journal.orders.length} строк
          </div>
        </div>
        <div className={`tile mini ${journal.mismatched > 0 ? "is-hot" : "zero"}`}>
          <div className="lab">Расходится</div>
          <div className="v">{journal.mismatched}</div>
          <div className="foot">
            <span className="mk" />
            {journal.mismatched > 0 ? "источники не сошлись" : "разногласий нет"}
          </div>
        </div>
        <div className={`tile mini ${unchecked > 0 ? "" : "zero"}`}>
          <div className="lab">Не с чем сверять</div>
          <div className="v">{unchecked}</div>
          <div className="foot">
            <span className="mk" />
            второй источник молчит за эти дни
          </div>
        </div>
      </div>

      <p className="hint" style={{ marginBottom: 10 }}>
        Первоисточник —{" "}
        <a href={journal.sourceUrl} target="_blank" rel="noopener noreferrer" style={{ color: "var(--accent)" }}>
          {journal.sourceUrl}
        </a>
        . Номер заказа, машинный код, ресурс заказа, статус платежа, цена заказа,
        статус варки и время приходят оттуда и здесь не пересчитываются. Карточка
        автомата, точка на момент заказа и цена периода — это уже наш вывод
        поверх сырья, и он помечен отдельно. Сверка с другим источником пока
        дневная: OurVend не отдаёт время внутри дня, и выдавать дневное сравнение
        за построчное нельзя.
        <br />
        Раскрой строку — увидишь всё по группам. Каждая величина ведёт к своему
        первоисточнику: цифра панели — к той самой строке выгрузки.
      </p>

      <div className="jlegend">
        {(["source", "matched", "unchecked", "mismatch", "absent"] as FieldState[]).map((s) => (
          <span className={`jlg s-${s}`} key={s}>
            <i />
            {STATE_LABEL[s]}
          </span>
        ))}
      </div>

      <div className="jhead-row">
        <span />
        <span>Время</span>
        <span>Автомат</span>
        <span>Товар</span>
        <span style={{ textAlign: "right" }}>Сумма</span>
        <span>Оплата</span>
        <span>Состояние</span>
      </div>

      <div className="jlist">
        {journal.orders.map((o) => (
          <OrderRow key={`${o.idx}-${o.externalId}`} o={o} hrefOf={hrefOf} />
        ))}
      </div>

      <div className="pager" style={{ marginTop: 12 }}>
        {journal.page > 1 && (
          <Link className="btn sm ghost" href={link({ page: String(journal.page - 1) })}>
            ← назад
          </Link>
        )}
        <span className="hint">
          {journal.page} / {pages} · {journal.total.toLocaleString("ru-RU")} заказов ·{" "}
          {sourceCode}/{reportCode}
        </span>
        {journal.page < pages && (
          <Link className="btn sm ghost" href={link({ page: String(journal.page + 1) })}>
            вперёд →
          </Link>
        )}
      </div>
    </>
  );
}
