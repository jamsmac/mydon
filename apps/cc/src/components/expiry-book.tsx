import Link from "next/link";
import type { ExpiryFlag, ExpiryReport, ExpiryReportRow, StockBatchRow } from "../lib/core";
import { ListShell, type ListShellKpi } from "./list-shell";
import { daysBetween, fmtDay } from "../lib/globerent";
import { plural } from "../lib/format";

/** Порядок и подписи показателей — дословно по брифу (§ Your Job, шаг 1). */
const FLAG_ORDER: readonly ExpiryFlag[] = ["expired", "expiring", "ok", "none"];
/**
 * Подписи флага срока — общий словарь для этого листа и карточки ингредиента
 * (Task 6, `ingredient-card-360.tsx`): один и тот же флаг не должен называться
 * по-разному в двух местах CC, поэтому обе подписи экспортированы отсюда.
 */
export const FLAG_LABELS: Record<ExpiryFlag, string> = {
  expired: "Просрочено",
  expiring: "Истекает < 14 дней",
  ok: "В порядке",
  none: "Без срока",
};
/** Цвет плашки флага на строке — тот же набор `chip.b/.g/.h`, что и везде в CC. */
export const FLAG_CHIP_CLASS: Record<ExpiryFlag, string> = {
  expired: "chip h",
  expiring: "chip b",
  ok: "chip g",
  none: "chip",
};

function isExpiryFlag(v: string | undefined): v is ExpiryFlag {
  return v === "expired" || v === "expiring" || v === "ok" || v === "none";
}

/**
 * Срок словами относительно ответа сервера (`asOf`), НЕ признак — признак
 * (`row.flag`) уже посчитан Core и остаётся источником истины; здесь только
 * текст. Дней при `flag==="expired"` может неожиданно оказаться 0 (границы
 * суток vs `now` с временем на сервере) — текст на этот случай не противоречит
 * флагу ни в одну, ни в другую сторону.
 *
 * Параметр типизирован как `StockBatchRow` (а не `ExpiryReportRow`), чтобы
 * карточка ингредиента (Task 6) могла звать эту же функцию для голых партий
 * без `fefoOrder` — слово «истекает через N дней» не должно расходиться между
 * листом и карточкой.
 */
export function rowDueLabel(row: StockBatchRow, asOf: string): { text: string; hot: boolean } {
  if (row.expiry === null) return { text: "без срока", hot: false };
  const days = daysBetween(asOf, row.expiry);
  if (days === null) return { text: `дата непонятна: ${row.expiry}`, hot: false };
  if (row.flag === "expired") {
    return {
      text: days === 0 ? "истёк сегодня" : `истёк ${Math.abs(days)} ${plural(Math.abs(days), "день", "дня", "дней")} назад`,
      hot: true,
    };
  }
  if (row.flag === "expiring") {
    return {
      text: days === 0 ? "истекает сегодня" : `через ${days} ${plural(days, "день", "дня", "дней")}`,
      hot: true,
    };
  }
  return { text: `до ${fmtDay(row.expiry)}`, hot: false };
}

/**
 * Имя поставщика для строки (R-C4 + честность из брифа): карточка нашлась —
 * показываем её имя; не нашлась, но человек что-то ввёл (`supplierRaw`) —
 * показываем как ввёл, с пометкой «не сопоставлен», иначе опечатку от
 * «не вводили» не отличить; ничего не вводили — не показываем совсем (не
 * плодим «поставщик: —» на каждой строке).
 */
function supplierText(row: ExpiryReportRow): string | null {
  if (row.supplierId !== null) return row.supplierName ?? "поставщик без имени в карточке";
  if (row.supplierRaw !== null) return `«${row.supplierRaw}» — не совпало с реестром`;
  return null;
}

/**
 * Лист «Сроки годности» (Task 5): показатели по флагам → поиск/фильтр →
 * партии карточками-строками. Три честных пустых состояния (§ шаг 3 брифа) —
 * см. ветки ниже; ни одна не подменяет другую.
 */
export function ExpiryBook({
  report,
  hrefBase,
  tab,
  q,
  flag,
}: {
  /** null — Core не ответил на `/stock/expiry` (провал запроса, НЕ «партий нет»). */
  report: ExpiryReport | null;
  hrefBase: string;
  /** Текущий `?tab=` — сохраняется в ссылках плиток и скрытым полем формы. */
  tab: string;
  q: string;
  /** Сырой `?flag=` из адреса — валидируется здесь же. */
  flag: string | undefined;
}) {
  const activeFlag = isExpiryFlag(flag) ? flag : null;

  // Ссылка плитки/сброса — тем же приёмом, что `href(t, status)` у плиток
  // «Парк»: флаг ДОБАВЛЯЕТСЯ к текущему адресу, не заменяет поиск. Повторный
  // клик по уже активной плитке снимает фильтр (переключатель, а не тупик).
  const flagHref = (f: ExpiryFlag | null) => {
    const params = new URLSearchParams({ tab });
    if (f) params.set("flag", f);
    if (q) params.set("q", q);
    return `${hrefBase}?${params.toString()}`;
  };

  // Счётчики — ВСЕГДА по полному отчёту, а не по текущему фильтру листа:
  // тот же приём, что у плиток «Парк» (цифра считает весь парк, а клик уже
  // сужает список ниже). null — Core не ответил: плитки честно показывают
  // «—», а не 0 (0 читался бы как «просрочек нет»).
  const counts = report?.counts ?? null;
  const kpi: ListShellKpi[] = FLAG_ORDER.map((f) => ({
    label: FLAG_LABELS[f],
    value: counts === null ? "—" : String(counts[f]),
    hot: counts !== null && (f === "expired" || f === "expiring") && counts[f] > 0,
    foot: counts === null ? "не удалось проверить" : undefined,
    href: counts === null ? undefined : flagHref(activeFlag === f ? null : f),
  }));

  const allRows = report?.rows ?? [];
  const byFlag = activeFlag === null ? allRows : allRows.filter((r) => r.flag === activeFlag);
  const query = q.trim().toLowerCase();
  const shownRows = query
    ? byFlag.filter(
        (r) =>
          r.ingredientName.toLowerCase().includes(query) ||
          (r.batchCode ?? "").toLowerCase().includes(query) ||
          (r.supplierName ?? "").toLowerCase().includes(query) ||
          (r.supplierRaw ?? "").toLowerCase().includes(query),
      )
    : byFlag;

  return (
    <ListShell kpi={kpi} searchQ="">
      {/* Свой поиск, как у ProductsBook (см. комментарий ListShell): несёт ещё
          и текущий флаг скрытым полем — иначе поиск при активной плитке молча
          сбрасывал бы фильтр. */}
      <form className="search" action={hrefBase} method="get" style={{ marginBottom: 14 }}>
        <input type="hidden" name="tab" value={tab} />
        {activeFlag && <input type="hidden" name="flag" value={activeFlag} />}
        <input
          type="search"
          name="q"
          defaultValue={q}
          placeholder="Поиск по ингредиенту, партии, поставщику…"
          aria-label="Поиск по партиям"
        />
        <button className="btn" type="submit" style={{ flex: "none", padding: "0 18px" }}>
          Найти
        </button>
      </form>

      {activeFlag && (
        <p className="hint" style={{ marginBottom: 14 }}>
          Показаны только «{FLAG_LABELS[activeFlag]}» ({byFlag.length}) ·{" "}
          <Link href={flagHref(null)}>сбросить фильтр</Link>
        </p>
      )}

      {report === null ? (
        // Пустое состояние 1/3: ядро не ответило. НЕ «просрочки нет» — тот же
        // урок, что в срезе B с «Бункерами».
        <div className="empty">
          <b>Не удалось проверить сроки годности</b>
          Core не ответил на запрос партий (/stock/expiry) — обнови страницу. Это не значит,
          что просрочек нет: показатели выше сейчас не посчитаны.
        </div>
      ) : allRows.length === 0 ? (
        // Пустое состояние 2/3: партий нет вовсе (честный факт прода на
        // 21.08.2026 — до среза партий не заводили ни одной).
        <div className="empty">
          <b>Партии ещё не заводились</b>
          Приход с партией появился только что — старый остаток (кофе, сухое молоко, матча и
          другое сырьё) заведён снимком без привязки к партии. Заведи первый приход с партией
          во вкладке «Остаток» карточки ингредиента — тогда здесь появятся сроки.
        </div>
      ) : shownRows.length === 0 ? (
        // Пустое состояние 3/3: фильтр/поиск ничего не нашёл — партии есть.
        <div className="empty">
          <b>Ничего не нашлось</b>
          Поменяй запрос или сними фильтр.
        </div>
      ) : (
        <>
          <div>
            {shownRows.map((row) => {
              const due = rowDueLabel(row, report.asOf);
              const supplier = supplierText(row);
              return (
                <Link href={`/card/${row.ingredientId}`} className={`trow ${due.hot ? "hot" : ""}`} key={row.id}>
                  <div className="tb">
                    <div className="tt">
                      {row.ingredientName}
                      {row.batchCode ? ` · ${row.batchCode}` : ""}
                    </div>
                    <div className="tm">
                      <span className={FLAG_CHIP_CLASS[row.flag]}>{FLAG_LABELS[row.flag]}</span>
                      <span>{row.warehouseName}</span>
                      <span>получено {fmtDay(row.receivedOn)}</span>
                      <span>
                        остаток {row.remaining.toLocaleString("ru-RU")} {row.unit}
                      </span>
                      {supplier && <span>{supplier}</span>}
                      {row.opened && (
                        <span>вскрыта{row.openedOn ? ` ${fmtDay(row.openedOn)}` : ""}</span>
                      )}
                      {row.fefoOrder === 1 && <span>к списанию первой (FEFO)</span>}
                    </div>
                  </div>
                  <span className={`due ${due.hot ? "hot" : ""}`}>{due.text}</span>
                </Link>
              );
            })}
          </div>
          <p style={{ fontSize: 12, color: "var(--tx-3)", marginTop: 10 }}>
            {shownRows.length === allRows.length
              ? `${allRows.length} ${plural(allRows.length, "партия", "партии", "партий")}`
              : `${shownRows.length} из ${allRows.length}`}
          </p>
        </>
      )}
    </ListShell>
  );
}
