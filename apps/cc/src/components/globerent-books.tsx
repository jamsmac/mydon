import Link from "next/link";
import { CONTRACTOR_ROLE_LABELS, type ContractorRole } from "@mydon/shared";
import type { Entity } from "../lib/core";
import { when } from "../lib/format";
import {
  amountLabel,
  contractClient,
  contractEnd,
  contractorInn,
  docDate,
  endLabel,
  equipmentCapacity,
  equipmentLine,
  fmtDay,
  salePriceLabel,
} from "../lib/globerent";

/**
 * Профильные таблицы GLOBERENT: договоры, счета, контрагенты, техника.
 *
 * Общая таблица «Название · Код · Цена» для документов не годится: у договора
 * главное — срок и контрагент, у счёта — сумма и дата. Колонки под тип,
 * стили — те же .book/.trow, что и в остальной панели.
 */

function CountFoot({ n }: { n: number }) {
  return <p style={{ fontSize: 12, color: "var(--tx-3)", marginTop: 10 }}>{n} записей</p>;
}

/** Договоры: срочные сверху, срок — чипом справа («осталось 5 дней» горит). */
export function ContractsBook({ items, today }: { items: Entity[]; today: string }) {
  // Порядок: сначала действующие по близости срока, затем без даты, затем истёкшие.
  const rank = (e: Entity): [number, string] => {
    const end = contractEnd(e);
    if (end === null || !/^\d{4}-\d{2}-\d{2}/.test(end)) return [1, e.name];
    const day = end.slice(0, 10);
    return day < today ? [2, day] : [0, day];
  };
  const sorted = [...items].sort((a, b) => {
    const [ra, ka] = rank(a);
    const [rb, kb] = rank(b);
    return ra !== rb ? ra - rb : ka.localeCompare(kb);
  });
  return (
    <div>
      {sorted.map((e) => {
        const { text, hot } = endLabel(contractEnd(e), today);
        const meta = [contractClient(e), amountLabel(e), e.externalRef].filter(Boolean).join(" · ");
        return (
          <Link href={`/card/${e.id}`} className={`trow ${hot ? "hot" : ""}`} key={e.id}>
            <div className="tb">
              <div className="tt">{e.name}</div>
              {meta && <div className="tm">{meta}</div>}
            </div>
            <span className={`due ${hot ? "hot" : ""}`}>{text}</span>
          </Link>
        );
      })}
      <CountFoot n={items.length} />
    </div>
  );
}

/** Счета: сумма — главная колонка, контрагент и дата — подписью. */
export function InvoicesBook({ items }: { items: Entity[] }) {
  // Свежие сверху: сравнение дат строками, не-ISO уходит в конец.
  const key = (e: Entity): string => {
    const d = docDate(e);
    return d !== null && /^\d{4}-\d{2}-\d{2}/.test(d) ? d.slice(0, 10) : "0000-00-00";
  };
  const sorted = [...items].sort((a, b) => key(b).localeCompare(key(a)));
  return (
    <div>
      <div className="book">
        <div className="th">
          <span>Счёт</span>
          <span>Контрагент</span>
          <span style={{ textAlign: "right" }}>Сумма</span>
        </div>
        {sorted.map((e) => {
          const d = docDate(e);
          return (
            <Link href={`/card/${e.id}`} className="tr" key={e.id}>
              <span className="nm">
                {e.name}
                {d !== null && <small style={{ color: "var(--tx-3)" }}> · {fmtDay(d)}</small>}
              </span>
              <span className="cd">{contractClient(e) ?? "—"}</span>
              <span className="pr">{amountLabel(e) ?? "—"}</span>
            </Link>
          );
        })}
      </div>
      <CountFoot n={items.length} />
    </div>
  );
}

/** Контрагенты: ИНН — ключ сведения тёзок из разных систем, показываем всегда. */
/** Оборот по книге закупок владельца — есть только у тех, кого свели с реестром. */
function оборотОф(e: Entity): number | null {
  const v = (e.attrs ?? {})["оборот по реестру"];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export function ContractorsBook({ items }: { items: Entity[] }) {
  // Список сортируется по закупкам, когда они известны У ВСЕХ: поставщик на
  // 60 млн и поставщик на полмиллиона — разные собеседники, и порядок должен
  // об этом говорить. Именно `every`, а не `some`: в реестре GLOBERENT сумма
  // есть у шести карточек из 226, и одной хватило бы, чтобы переименовать
  // колонку у всех, а 220 строк показали бы в ней дату под шапкой «сумма».
  const сОборотом = items.length > 0 && items.every((e) => оборотОф(e) !== null);
  const rows = сОборотом
    ? [...items].sort((a, b) => (оборотОф(b) ?? -1) - (оборотОф(a) ?? -1))
    : items;

  return (
    <div>
      <div className="book">
        <div className="th">
          <span>Название</span>
          <span>ИНН</span>
          {/* «Закупки», а не «Оборот»: это сумма НАШИХ закупок у поставщика,
              и в контексте GLOBERENT «оборот» читался бы как оборот по нему. */}
          <span style={{ textAlign: "right" }}>{сОборотом ? "Закупки, сум" : "Обновлено"}</span>
        </div>
        {rows.map((e) => {
          const оборот = оборотОф(e);
          const роли = Array.isArray((e.attrs ?? {})["roles"]) ? ((e.attrs ?? {})["roles"] as string[]) : [];
          return (
            <Link href={`/card/${e.id}`} className="tr" key={e.id}>
              {/* Чип вынесен из обрезаемого потока: у `.book .nm` стоит
                  ellipsis, и роль пропадала вместе с хвостом длинного имени.
                  Имя сжимается, чип держит свою ширину. */}
              <span className="nm" style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {e.name}
                </span>
                {роли.map((r) => (
                  <span className="chip" key={r} style={{ flex: "0 0 auto" }}>
                    {CONTRACTOR_ROLE_LABELS[r as ContractorRole] ?? r}
                  </span>
                ))}
              </span>
              <span className="cd">{contractorInn(e) ?? "—"}</span>
              <span className="pr">
                {оборот !== null ? оборот.toLocaleString("ru-RU") : when(e.updatedAt)}
              </span>
            </Link>
          );
        })}
      </div>
      <CountFoot n={items.length} />
    </div>
  );
}

/** Техника HELI: линейка и грузоподъёмность вместо «кода», цена продажи справа. */
export function EquipmentBook({ items }: { items: Entity[] }) {
  return (
    <div>
      <div className="book">
        <div className="th">
          <span>Модель</span>
          <span>Характеристики</span>
          <span style={{ textAlign: "right" }}>Цена продажи</span>
        </div>
        {items.map((e) => {
          const traits = [equipmentLine(e), equipmentCapacity(e)].filter(Boolean).join(" · ");
          return (
            <Link href={`/card/${e.id}`} className="tr" key={e.id}>
              <span className="nm">{e.name}</span>
              <span className="cd">{traits || (e.externalRef ?? "—")}</span>
              <span className="pr">{salePriceLabel(e) ?? "—"}</span>
            </Link>
          );
        })}
      </div>
      <CountFoot n={items.length} />
    </div>
  );
}
