"use client";

import { useEffect, useState } from "react";
import {
  TZ,
  UNITS,
  looksLikeXlsx,
  normalizeSourceKey,
  parseRegisterRows,
  parseXlsx,
  suggestCard,
  type CardRef,
  type RegisterRow,
  type Suggestion,
} from "@mydon/shared";
import { money, plural } from "../lib/format";
import { runRegisterImport } from "../app/stock/actions";
import type { ImportBatchItem, ImportBatchesReport } from "../lib/core";
import type { WarehouseOption } from "./stock-panel";

/**
 * Экран «Импорт закупок» (срез D, задача 4).
 *
 * Три шага на одном экране: (1) выбрать файл → разбор тем же `parseXlsx`,
 * что и приём выгрузок (`app/sources/actions.ts`, `importFile`); (2)
 * предпросмотр — числа реестра и список имён с предложенной карточкой
 * (Task 2 `suggestCard`), которые владелец подтверждает/меняет/отклоняет;
 * (3) подтверждение и запись — `core.importBatches` (Task 3), сначала
 * `dryRun: true` (ничего не пишет, отчёт тот же, что и настоящий прогон —
 * R-D7), потом настоящая запись по нажатию.
 *
 * ПРЕДЛОЖЕНИЕ ≠ ПРИВЯЗКА (как и во всём срезе): пока владелец явно не нажал
 * «Подтвердить» или не выбрал карточку сам, строка идёт в импорт с
 * `ingredientId: null` — даже если для её имени есть предложение. Иначе
 * непросмотренная подсказка молча стала бы решением.
 */

// ── Решение владельца по имени: где хранится и как переживает перезагрузку ──

interface Decision {
  ingredientId: string | null;
  /** "suggested" — ещё НЕ решено (предложение видно, но не принято владельцем);
   *  "confirmed" — владелец подтвердил связь (предложенную или свою);
   *  "rejected" — владелец явно сказал «карточки нет». */
  status: "suggested" | "confirmed" | "rejected";
}

/**
 * У `raw_link` (сырой слой источников) `kind` — enum Postgres ровно из трёх
 * значений: machine/product/point (packages/db/src/schema.ts,
 * `rawLinkKindEnum`). Добавить туда «ingredient» без миграции нельзя, а миграция
 * — не эта задача. Поэтому решение владельца по имени реестра хранится в
 * браузере (localStorage), НЕ в Core: переживает перезагрузку и повторный
 * заход НА ЭТОМ УСТРОЙСТВЕ, но не синхронизируется между браузерами и не
 * виден в API. Явный компромисс — см. отчёт задачи.
 */
// Версия ключа поднята вместе с переездом мастера внутрь листа «Приход».
// Решения прошлого разбора лежат в localStorage браузера владельца; на старом
// ключе мастер открылся бы с НЕЗАКОНЧЕННЫМ разбором прошлого файла как с
// текущим — и это выглядело бы не ошибкой, а «он что-то помнит».
const STORAGE_KEY = "mydon.registerImport.decisions.v2";

function loadStoredDecisions(): Record<string, Decision> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    return JSON.parse(raw) as Record<string, Decision>;
  } catch {
    return {}; // приватный режим/битый JSON — решения просто не восстановились
  }
}

function saveStoredDecisions(decisions: Record<string, Decision>): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(decisions));
  } catch {
    // localStorage может быть запрещён (приватный режим) — решение просто
    // не переживёт эту сессию, но экран продолжает работать.
  }
}

/** Ключ группы «то же имя у того же поставщика» — единица решения владельца. */
function groupKey(row: RegisterRow): string {
  return `${normalizeSourceKey(row.supplier)}::${normalizeSourceKey(row.name)}`;
}

interface NameGroup {
  key: string;
  name: string;
  supplier: string;
  rows: RegisterRow[];
  suggestion: Suggestion;
}

function groupSum(g: NameGroup): number {
  return g.rows.reduce((n, r) => n + (r.costGross ?? 0), 0);
}

/** Сгруппировать строки реестра по (поставщик, имя) и посчитать предложение один раз на группу. */
function buildGroups(rows: RegisterRow[], cards: CardRef[]): NameGroup[] {
  const bySupplier = new Map<string, RegisterRow[]>();
  for (const r of rows) {
    const k = normalizeSourceKey(r.supplier);
    const list = bySupplier.get(k);
    if (list) list.push(r);
    else bySupplier.set(k, [r]);
  }
  const byKey = new Map<string, NameGroup>();
  for (const r of rows) {
    const key = groupKey(r);
    let g = byKey.get(key);
    if (!g) {
      const sameSupplier = bySupplier.get(normalizeSourceKey(r.supplier)) ?? [];
      g = { key, name: r.name, supplier: r.supplier, rows: [], suggestion: suggestCard(r, cards, sameSupplier) };
      byKey.set(key, g);
    }
    g.rows.push(r);
  }
  // Деньги сосредоточены (топ-10 = 88,6% по разбору реестра) — крупные имена сверху,
  // владелец решает по ним первым делом, а не в порядке файла.
  return [...byKey.values()].sort((a, b) => groupSum(b) - groupSum(a));
}

/** Начальные решения: из localStorage, где были; иначе — «предложено» как есть от suggestCard. */
function initialDecisions(groups: NameGroup[], stored: Record<string, Decision>): Record<string, Decision> {
  const out: Record<string, Decision> = {};
  for (const g of groups) {
    out[g.key] = stored[g.key] ?? { ingredientId: g.suggestion.cardId, status: "suggested" };
  }
  return out;
}

const BASIS_LABEL: Record<NonNullable<Suggestion["basis"]>, string> = {
  exact: "точное совпадение имени",
  supplier: "единственное наименование поставщика",
  keyword: "ключевое слово",
};

/**
 * Судьба строки при импорте — тем же порядком проверок, что и
 * `StockService.importBatches` (Task 3): сперва карточка, потом дата. Так
 * числа предпросмотра совпадают буквально с настоящим отчётом ядра.
 *
 * Количество и единицу измерения здесь НЕ проверяем: это забота ядра
 * (`prepareBatch`) построчно — плохая строка (нулевое количество, пустая или
 * незнакомая единица) уйдёт в `rejected` С ПРИЧИНОЙ, а не потеряется молча в
 * отдельном клиентском ведре. Дублировать эту проверку на витрине значило бы
 * держать два места, которые могут разойтись.
 */
type RowFate = "unmatched" | "noDate" | "ready";

function confirmedIngredientId(row: RegisterRow, decisions: Record<string, Decision>): string | null {
  const d = decisions[groupKey(row)];
  return d?.status === "confirmed" ? d.ingredientId : null;
}

function classify(row: RegisterRow, decisions: Record<string, Decision>): RowFate {
  if (!confirmedIngredientId(row, decisions)) return "unmatched";
  if (!row.receivedOn) return "noDate";
  return "ready";
}

function sumRows(rows: RegisterRow[]): number {
  return rows.reduce((n, r) => n + (r.costGross ?? 0), 0);
}

/**
 * Строки → вход `POST /stock/batches/import`. Отправляются ВСЕ строки без
 * исключения — количество/единица без значения превращаются в 0/"", и если
 * строка всё же дойдёт до проверки на складе (карточка подтверждена, дата
 * есть), `prepareBatch` отклонит именно её с понятной причиной, а не всю
 * пачку: DTO этой строки больше не требует "количество > 0" на входе
 * (fix(core) «одна плохая строка не должна ронять весь импорт», уже в ветке).
 */
/**
 * Ключ повтора строки реестра — по СОДЕРЖИМОМУ, а не по позиции в файле.
 *
 * Ядро по умолчанию берёт номер строки, и для одноразовой загрузки этого хватило
 * бы. Но владельцу предстоит править сам файл: 47 строк пришли без даты прихода,
 * и он будет проставлять их вручную. Любая вставка или удаление строки сдвигает
 * номера всех строк ниже — при повторной загрузке они выглядели бы новыми, и уже
 * загруженные закупки завелись бы второй раз, задвоив историю цен, а при
 * выключенном закрытии — и остаток.
 *
 * Строка закупки опознаётся счётом, наименованием и количеством. Если в одном
 * счёте две одинаковые строки (тот же товар, то же количество), они различаются
 * порядковым номером среди таких же — иначе законный дубль схлопнулся бы в одну.
 * Счёта нет — вместо него дата прихода: она у строки уже проверена.
 */
function buildExtIds(rows: RegisterRow[]): Map<number, string> {
  const счётчик = new Map<string, number>();
  const out = new Map<number, string>();
  for (const row of rows) {
    const основа = [
      row.invoiceNo ?? row.receivedOn ?? "без-документа",
      normalizeSourceKey(row.name),
      row.qty ?? 0,
    ].join("::");
    const n = (счётчик.get(основа) ?? 0) + 1;
    счётчик.set(основа, n);
    out.set(row.fileRow, n === 1 ? основа : `${основа}::${n}`);
  }
  return out;
}

function buildItems(
  rows: RegisterRow[],
  decisions: Record<string, Decision>,
  warehouseId: string,
): ImportBatchItem[] {
  const extIds = buildExtIds(rows);
  return rows.map((row) => ({
    fileRow: row.fileRow,
    extId: extIds.get(row.fileRow) ?? String(row.fileRow),
    ingredientId: confirmedIngredientId(row, decisions),
    warehouseId,
    qtyReceived: row.qty ?? 0,
    unit: row.unit ?? "",
    receivedOn: row.receivedOn,
    supplier: row.supplier.trim().length > 0 ? row.supplier : null,
    invoiceNo: row.invoiceNo,
    invoiceDate: row.invoiceDate,
    unitPriceGross: row.priceGross,
    note: row.note,
    name: row.name,
  }));
}

function downloadReport(report: ImportBatchesReport, fileLabel: string): void {
  const lines: string[] = [];
  const now = new Date().toLocaleString("ru-RU", { timeZone: TZ });
  lines.push(`Импорт реестра закупок «${fileLabel}» — отчёт от ${now}`);
  lines.push(report.dryRun ? "(предпросмотр, ничего не записано)" : "(настоящая запись)");
  lines.push("");
  lines.push(`Создано партий: ${report.created}`);
  lines.push(
    report.closed > 0
      ? `Закрыто расходом: ${report.closed} на ${report.closeOn} — остаток не изменился`
      : `Закрыто расходом: 0 — партии ОТКРЫТЫ, остаток вырос`,
  );
  lines.push(`Пропущено как повтор (уже были): ${report.skippedRepeat}`);
  lines.push("");
  lines.push(`Без даты прихода — ${report.noDate.length}:`);
  for (const i of report.noDate) lines.push(`  строка ${i.fileRow}: ${i.name ?? "(без имени)"}`);
  lines.push("");
  lines.push(`Не сопоставлена карточка — ${report.unmatched.length}:`);
  for (const i of report.unmatched) lines.push(`  строка ${i.fileRow}: ${i.name ?? "(без имени)"}`);
  lines.push("");
  lines.push(`Отклонено ядром при проверке — ${report.rejected.length}:`);
  for (const r of report.rejected) lines.push(`  строка ${r.fileRow}: ${r.name ?? "(без имени)"} — ${r.reason}`);

  const blob = new Blob([lines.join("\n")], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `import-zakupok-${new Date().toISOString().slice(0, 10)}.txt`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

const IMPORT_SOURCE = "purchase_register";

type Phase = "pick" | "review" | "confirm" | "done";

export function RegisterImport({
  ingredientCards,
  warehouses,
}: {
  /** null — карточки прочитать не удалось. Это НЕ «карточек нет»: без них
   *  предложений не будет, и сказать «нет» значит соврать. */
  ingredientCards: CardRef[] | null;
  /** null — склады прочитать не удалось; см. выше. */
  warehouses: WarehouseOption[] | null;
}) {
  const [phase, setPhase] = useState<Phase>("pick");
  const [fileName, setFileName] = useState<string | null>(null);
  const [rawBytes, setRawBytes] = useState<Uint8Array | null>(null);
  const [sheets, setSheets] = useState<string[] | null>(null);
  const [chosenSheet, setChosenSheet] = useState<string>("");
  const [pickError, setPickError] = useState<string | null>(null);
  const [parsing, setParsing] = useState(false);

  const [rows, setRows] = useState<RegisterRow[]>([]);
  const [groups, setGroups] = useState<NameGroup[]>([]);
  const [decisions, setDecisions] = useState<Record<string, Decision>>({});

  // Закрытие включено, а даты нет — отправлять нельзя: ядро приняло бы пустую
  // строку как «не закрывать», партии остались бы открытыми и остаток задвоился,
  // причём отчёт выглядел бы успешным. Лучше не дать нажать.
  const закрытиеБезДаты = (): boolean => closeEnabled && closeOnDate.trim() === "";
  const карточки = ingredientCards ?? [];
  const склады = warehouses ?? [];
  const ядроМолчит = ingredientCards === null || warehouses === null;
  const [warehouseId, setWarehouseId] = useState(склады.length === 1 ? склады[0]!.id : "");
  const [closeEnabled, setCloseEnabled] = useState(true);
  const [closeOnDate, setCloseOnDate] = useState(() => new Date().toLocaleDateString("en-CA", { timeZone: TZ }));

  const [dryReport, setDryReport] = useState<ImportBatchesReport | null>(null);
  const [dryError, setDryError] = useState<string | null>(null);
  const [dryPending, setDryPending] = useState(false);
  const [writePending, setWritePending] = useState(false);
  const [writeError, setWriteError] = useState<string | null>(null);
  const [finalReport, setFinalReport] = useState<ImportBatchesReport | null>(null);

  // Решения переживают перезагрузку страницы: отклонённое имя не предложится
  // снова (R-D4), а подтверждённое не надо решать заново при повторном заходе.
  useEffect(() => {
    if (Object.keys(decisions).length > 0) saveStoredDecisions(decisions);
  }, [decisions]);

  const cardNameById = new Map(карточки.map((c) => [c.id, c.name]));

  async function runParse(bytes: Uint8Array, sheetName: string | undefined): Promise<void> {
    setParsing(true);
    setPickError(null);
    try {
      const sheet = await parseXlsx(bytes, sheetName);
      if (sheet.sheetNames.length > 1 && sheetName === undefined) {
        setSheets(sheet.sheetNames);
        setChosenSheet(sheet.sheetNames[0] ?? "");
        return; // ждём явного выбора листа — не глотаем первый молча
      }
      setSheets(null);
      const today = new Date().toLocaleDateString("en-CA", { timeZone: TZ });
      // parseXlsx всегда съедает первую строку файла как заголовок — вернувшийся
      // rows[0] это вторая строка исходной книги, поэтому firstRowNumber = 2
      // (Task 1): тогда fileRow совпадает с номером строки, который видит
      // владелец в Excel, для ЛЮБОГО файла, прочитанного этим разбором.
      const parsed = parseRegisterRows({ columns: sheet.columns, rows: sheet.rows }, today, 2);
      if (parsed.length === 0) {
        setPickError("В листе не нашлось ни одной товарной строки — проверь, тот ли это лист и файл.");
        return;
      }
      const built = buildGroups(parsed, карточки);
      setRows(parsed);
      setGroups(built);
      setDecisions(initialDecisions(built, loadStoredDecisions()));
      setPhase("review");
    } catch (err) {
      setPickError(err instanceof Error ? err.message : "Файл не прочитался");
    } finally {
      setParsing(false);
    }
  }

  async function onFileChange(file: File | undefined): Promise<void> {
    if (!file) return;
    setFileName(file.name);
    setPickError(null);
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (!looksLikeXlsx(bytes)) {
      setPickError(
        "Реестр закупок читается только из книги Excel (.xlsx) — этот файл на неё не похож (нет заголовка zip).",
      );
      return;
    }
    setRawBytes(bytes);
    await runParse(bytes, undefined);
  }

  function setDecision(key: string, next: Decision): void {
    setDecisions((prev) => ({ ...prev, [key]: next }));
  }

  function confirmAllSuggested(): void {
    setDecisions((prev) => {
      const next = { ...prev };
      for (const g of groups) {
        const d = next[g.key];
        if (g.suggestion.cardId && d?.status === "suggested") {
          next[g.key] = { ingredientId: g.suggestion.cardId, status: "confirmed" };
        }
      }
      return next;
    });
  }

  function resetAll(): void {
    setPhase("pick");
    setFileName(null);
    setRawBytes(null);
    setSheets(null);
    setPickError(null);
    setRows([]);
    setGroups([]);
    setWarehouseId(склады.length === 1 ? склады[0]!.id : "");
    setDryReport(null);
    setDryError(null);
    setFinalReport(null);
    setWriteError(null);
    // decisions НЕ сбрасываем — это память об именах, а не о файле.
  }

  // ── Числа предпросмотра: тем же порядком, что и StockService.importBatches
  //    (сперва карточка, потом дата), чтобы совпасть с настоящим отчётом ядра.
  const totalSum = sumRows(rows);
  const fates = rows.map((r) => classify(r, decisions));
  const unmatchedRows = rows.filter((_, i) => fates[i] === "unmatched");
  const noDateRows = rows.filter((_, i) => fates[i] === "noDate");
  const readyRows = rows.filter((_, i) => fates[i] === "ready");
  const pendingSuggestions = groups.filter(
    (g) => g.suggestion.cardId !== null && decisions[g.key]?.status === "suggested",
  );

  async function runDryRun(): Promise<void> {
    setDryPending(true);
    setDryError(null);
    setDryReport(null);
    const items = buildItems(rows, decisions, warehouseId);
    const res = await runRegisterImport({
      source: IMPORT_SOURCE,
      dryRun: true,
      closeOn: closeEnabled ? closeOnDate.trim() || null : null,
      items,
    });
    setDryPending(false);
    if (res.ok && res.report) setDryReport(res.report);
    else setDryError(res.error ?? "Предпросмотр ядра не удался");
  }

  async function runWrite(): Promise<void> {
    const confirmText = `Записать импорт? Будет создано до ${readyRows.length} ${plural(readyRows.length, "партия", "партии", "партий")} на сумму ${money(sumRows(readyRows))}. Действие пишет в базу и его нельзя отменить кнопкой «назад» — только вручную скорректировать партию.`;
    if (!window.confirm(confirmText)) return;
    setWritePending(true);
    setWriteError(null);
    const items = buildItems(rows, decisions, warehouseId);
    const res = await runRegisterImport({
      source: IMPORT_SOURCE,
      dryRun: false,
      closeOn: closeEnabled ? closeOnDate.trim() || null : null,
      items,
    });
    setWritePending(false);
    if (res.ok && res.report) {
      setFinalReport(res.report);
      setPhase("done");
    } else {
      setWriteError(res.error ?? "Импорт не удался");
    }
  }

  const stepLabel =
    phase === "pick"
      ? "Шаг 1 из 3 · Файл"
      : phase === "review"
        ? "Шаг 2 из 3 · Предпросмотр и сопоставление"
        : phase === "confirm"
          ? "Шаг 3 из 3 · Подтверждение и запись"
          : "Готово";

  return (
    <div className="sect">
      <div className="sect-h">
        <h3 className="h2">Импорт закупок из реестра</h3>
        <span className="chip">{stepLabel}</span>
      </div>

      {/* Ядро не ответило на чтение справочников. Промолчать нельзя: экран
          покажет ноль предложений по всем именам и пустой список складов, и
          владелец решит, что карточек нет, — вместо того чтобы обновить
          страницу. */}
      {ядроМолчит && (
        <p className="hint" style={{ color: "var(--hot)" }}>
          {ingredientCards === null && warehouses === null
            ? "Не удалось прочитать карточки сырья и склады — ядро не ответило."
            : ingredientCards === null
              ? "Не удалось прочитать карточки сырья — ядро не ответило."
              : "Не удалось прочитать склады — ядро не ответило."}{" "}
          Это не значит, что их нет: обнови страницу, иначе разметка имён и выбор склада
          будут сделаны вслепую.
        </p>
      )}

      {/* ── Шаг 1: файл ── */}
      {phase === "pick" && (
        <div className="form card" style={{ margin: 0 }}>
          <label>
            <span>Файл реестра (Excel, .xlsx)</span>
            <input
              type="file"
              accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              onChange={(e) => void onFileChange(e.target.files?.[0])}
            />
          </label>

          {sheets && (
            <div className="srcfr">
              <label>
                Лист книги — в файле их несколько
                <select value={chosenSheet} onChange={(e) => setChosenSheet(e.target.value)} className="mapsel">
                  {sheets.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                className="btn sm"
                disabled={parsing || !rawBytes}
                onClick={() => rawBytes && void runParse(rawBytes, chosenSheet)}
              >
                {parsing ? "Читаю…" : "Разобрать этот лист"}
              </button>
            </div>
          )}

          {parsing && !sheets && <p className="hint">Читаю файл…</p>}
          {pickError && <span className="err-text">{pickError}</span>}

          <p className="hint">
            Разбор ждёт фиксированный порядок колонок реестра закупок (группа, год, поставщик,
            ИНН, наименование, ед. изм., кол-во, цена с НДС, стоимость с НДС, счёт-фактура,
            сумма оплаты, дата оплаты, примечание) — как в файле «вендхаб.xlsx». Поставщик и ИНН
            протягиваются вниз по группе строк, как в исходной таблице.
          </p>
        </div>
      )}

      {/* ── Шаг 2: предпросмотр + сопоставление имён ── */}
      {(phase === "review" || phase === "confirm") && (
        <>
          <div className="tiles" style={{ marginBottom: 14 }}>
            <div className="tile">
              <div className="lab">Строк в реестре</div>
              <div className="v">{rows.length}</div>
              <div className="foot">
                <span className="mk" />
                {groups.length} {plural(groups.length, "наименование", "наименования", "наименований")} ·{" "}
                {money(totalSum)}
                {fileName ? ` · ${fileName}` : ""}
              </div>
            </div>
            <div className={`tile ${noDateRows.length > 0 ? "is-hot" : "zero"}`}>
              <div className="lab">Без даты прихода</div>
              <div className="v">{noDateRows.length}</div>
              <div className="foot">
                <span className="mk" />
                {noDateRows.length > 0 ? `${money(sumRows(noDateRows))} — не импортируются` : "у всех сопоставленных дата есть"}
              </div>
            </div>
            <div className={`tile ${unmatchedRows.length > 0 ? "is-hot" : "zero"}`}>
              <div className="lab">Не сопоставлена карточка</div>
              <div className="v">{unmatchedRows.length}</div>
              <div className="foot">
                <span className="mk" />
                {unmatchedRows.length > 0 ? `${money(sumRows(unmatchedRows))} — не импортируются` : "все строки сопоставлены"}
              </div>
            </div>
            <div className={`tile ${readyRows.length > 0 ? "" : "zero"}`}>
              <div className="lab">Готово к записи</div>
              <div className="v">{readyRows.length}</div>
              <div className="foot">
                <span className="mk" />
                {money(sumRows(readyRows))}
                {pendingSuggestions.length > 0 ? ` · ждут решения: ${pendingSuggestions.length}` : ""}
              </div>
            </div>
          </div>
          <div className="sect-h">
            <h3 className="h2" style={{ fontSize: 14 }}>
              Сопоставление имён с карточками сырья
            </h3>
            {pendingSuggestions.length > 0 && (
              <button type="button" className="btn sm" onClick={confirmAllSuggested}>
                Подтвердить все предложенные ({pendingSuggestions.length})
              </button>
            )}
          </div>
          {/* Честно предупреждаем, где живут решения: они не в Core, и молчать
              об этом значит дать владельцу разметить 59 имён, сменить браузер и
              обнаружить пустой экран. */}
          <p className="hint" style={{ marginTop: -4 }}>
            Решения сохраняются в этом браузере, а не на сервере: с другого устройства
            сопоставление придётся подтвердить заново.
          </p>
          <div className="maplist">
            {groups.map((g) => {
              const d = decisions[g.key] ?? { ingredientId: g.suggestion.cardId, status: "suggested" as const };
              const sum = groupSum(g);
              const unitBad = g.rows.some((r) => r.unit !== null && !(UNITS as readonly string[]).includes(r.unit));
              return (
                <div className="maprow" key={g.key}>
                  <div className="mapv">
                    <span className="mapl">{g.name}</span>
                    <span className="mapc">
                      {g.supplier || "поставщик не записан"} · {g.rows.length}{" "}
                      {plural(g.rows.length, "строка", "строки", "строк")} · {money(sum)}
                    </span>
                    {g.suggestion.reason && <span className="hint" style={{ display: "block" }}>{g.suggestion.reason}</span>}
                    {unitBad && (
                      <span className="warn" style={{ display: "block" }}>
                        единица измерения не из списка ({UNITS.join(", ")}) — ядро отклонит такую строку
                      </span>
                    )}
                  </div>
                  <div className="mapt">
                    {d.ingredientId ? (
                      <>
                        <span className="mapok">{cardNameById.get(d.ingredientId) ?? "карточка"}</span>
                        <span className="chip">
                          {d.status === "confirmed"
                            ? g.suggestion.cardId === d.ingredientId
                              ? "подтверждено"
                              : "выбрано вручную"
                            : g.suggestion.basis
                              ? BASIS_LABEL[g.suggestion.basis]
                              : "предложено"}
                        </span>
                      </>
                    ) : d.status === "rejected" ? (
                      <span className="hint">карточка не нужна — твоё решение</span>
                    ) : (
                      <span className="warn">не сопоставлено</span>
                    )}
                  </div>
                  <select
                    className="mapsel"
                    value={d.ingredientId ?? (d.status === "rejected" ? "__none__" : "")}
                    onChange={(e) => {
                      const v = e.target.value;
                      if (v === "") return;
                      setDecision(g.key, v === "__none__" ? { ingredientId: null, status: "rejected" } : { ingredientId: v, status: "confirmed" });
                    }}
                  >
                    <option value="" disabled>
                      выбрать карточку…
                    </option>
                    {карточки.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                    <option value="__none__">нет карточки — не импортировать</option>
                  </select>
                  {g.suggestion.cardId && d.status === "suggested" && (
                    <button
                      type="button"
                      className="btn sm"
                      onClick={() => setDecision(g.key, { ingredientId: g.suggestion.cardId, status: "confirmed" })}
                    >
                      Подтвердить
                    </button>
                  )}
                </div>
              );
            })}
          </div>

          {phase === "review" && (
            <div className="form-actions">
              <button type="button" className="btn ghost" onClick={resetAll}>
                Начать заново
              </button>
              <button
                type="button"
                className="btn primary"
                disabled={склады.length === 0}
                onClick={() => setPhase("confirm")}
              >
                Далее: подтверждение и запись
              </button>
            </div>
          )}
        </>
      )}

      {/* ── Шаг 3: закрытие партии, склад, предпросмотр ядра, запись ── */}
      {phase === "confirm" && (
        <div className="sect" style={{ marginTop: 22 }}>
          <div
            style={{
              background: "var(--accent-soft)",
              border: "1px solid var(--accent-line)",
              borderRadius: "var(--r)",
              padding: 14,
              marginBottom: 14,
            }}
          >
            <b style={{ display: "block", marginBottom: 6 }}>Зачем партия сразу закрывается расходом</b>
            <p style={{ margin: 0, fontSize: 13, lineHeight: 1.5 }}>
              Приход из реестра — это история прошлых закупок (май 2025 — январь 2026 в этом
              файле), а не то, что реально лежит на складе сегодня: часть сырья давно
              израсходована. Если просто завести партию, остаток задвоится — на этом самом
              реестре разница ощутима: без закрытия остаток кофе показал бы ≈293 кг вместо
              настоящих ≈43 кг. Поэтому каждая партия из этого импорта сразу же виртуально
              списывается датой ниже: остаток склада не изменится, а сам приход останется виден
              в карточке партии (с пометкой «израсходовано до инвентаризации»).
            </p>
          </div>

          <div className="srcfr">
            <label>
              Склад, на который заводится приход
              <select value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)} className="mapsel">
                <option value="" disabled>
                  — выбери склад —
                </option>
                {склады.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </select>
            </label>
            <label style={{ alignSelf: "end" }}>
              <input type="checkbox" checked={closeEnabled} onChange={(e) => setCloseEnabled(e.target.checked)} />{" "}
              Закрыть партии расходом (историческая покупка)
            </label>
            {closeEnabled && (
              <label>
                Дата закрытия
                <input type="date" value={closeOnDate} onChange={(e) => setCloseOnDate(e.target.value)} />
              </label>
            )}
          </div>
          {warehouses === null ? (
            <p className="hint" style={{ color: "var(--hot)" }}>
              Не удалось прочитать список складов — ядро не ответило. Это не значит, что складов
              нет: обнови страницу, прежде чем заводить новый.
            </p>
          ) : склады.length === 0 ? (
            <p className="hint">
              Складов пока нет — заведи карточку с типом «склад» на вкладке «Склады», прежде чем
              импортировать.
            </p>
          ) : null}
          {!closeEnabled && (
            <p className="hint" style={{ color: "var(--hot)" }}>
              Без закрытия остаток по этим позициям задвоится, если это старая история, а не
              сегодняшняя поставка.
            </p>
          )}

          {закрытиеБезДаты() && (
            <p className="hint" style={{ color: "var(--hot)" }}>
              Закрытие включено, но дата не указана — импорт заблокирован. Пустая дата означала
              бы «не закрывать», партии остались бы открытыми и остаток задвоился бы, а отчёт
              выглядел бы успешным.
            </p>
          )}
          <div className="form-actions" style={{ marginTop: 14 }}>
            <button type="button" className="btn ghost" onClick={() => setPhase("review")}>
              Назад к сопоставлению
            </button>
            <button type="button" className="btn" disabled={dryPending || !warehouseId || закрытиеБезДаты()} onClick={() => void runDryRun()}>
              {dryPending ? "Проверяю…" : "Показать предпросмотр ядра (dry-run)"}
            </button>
            <button
              type="button"
              className="btn primary"
              disabled={writePending || !warehouseId || readyRows.length === 0 || закрытиеБезДаты()}
              onClick={() => void runWrite()}
            >
              {writePending ? "Записываю…" : "Импортировать по-настоящему"}
            </button>
          </div>

          {dryError && (
            <p className="hint" style={{ color: "var(--hot)", marginTop: 10 }}>
              Проверка ядра недоступна: {dryError}. Числа предпросмотра выше посчитаны в
              браузере тем же алгоритмом (`parseRegisterRows` + `suggestCard`), что использует
              ядро, но точный отчёт ядра (уже импортированные повторы, отклонённые ядром строки)
              подтвердить сейчас нельзя — вероятно, эта ветка ещё не задеплоена на прод.
            </p>
          )}
          {dryReport && (
            <div className="pass" style={{ marginTop: 12 }}>
              <div className="f">
                <div className="k">Проверка ядра (dry-run, ничего не записано)</div>
                <div className="val mono">
                  создаст {dryReport.created} · повтор {dryReport.skippedRepeat} · без даты{" "}
                  {dryReport.noDate.length} · не сопоставлено {dryReport.unmatched.length} · отклонено{" "}
                  {dryReport.rejected.length}
                </div>
              </div>
            </div>
          )}
          {writeError && <p className="err-text" style={{ marginTop: 10 }}>{writeError}</p>}
        </div>
      )}

      {/* ── Шаг 4 (отчёт после записи) ── */}
      {phase === "done" && finalReport && (
        <div className="sect" style={{ marginTop: 10 }}>
          <div className="tiles">
            <div className="tile">
              <div className="lab">Создано партий</div>
              <div className="v">{finalReport.created}</div>
              <div className="foot"><span className="mk" />на склад {склады.find((w) => w.id === warehouseId)?.name ?? warehouseId}</div>
            </div>
            {/* Закрытие — не деталь, а условие, при котором остаток не задвоится.
                Прогон без закрытия внешне неотличим от правильного, поэтому
                показываем его отдельной плиткой и красим, когда партии открыты. */}
            <div className={`tile ${finalReport.created > 0 && finalReport.closed === 0 ? "is-hot" : ""}`}>
              <div className="lab">Закрыто расходом</div>
              <div className="v">{finalReport.closed}</div>
              <div className="foot">
                <span className="mk" />
                {finalReport.closed > 0
                  ? `на ${finalReport.closeOn} — остаток не изменился`
                  : finalReport.created > 0
                    ? "партии ОТКРЫТЫ: остаток вырос на это количество"
                    : "закрывать было нечего"}
              </div>
            </div>
            <div className="tile">
              <div className="lab">Пропущено (повтор)</div>
              <div className="v">{finalReport.skippedRepeat}</div>
              <div className="foot"><span className="mk" />партия с этой строкой уже была</div>
            </div>
            <div className={`tile ${finalReport.noDate.length > 0 ? "is-hot" : "zero"}`}>
              <div className="lab">Без даты</div>
              <div className="v">{finalReport.noDate.length}</div>
              <div className="foot"><span className="mk" />не импортированы</div>
            </div>
            <div className={`tile ${finalReport.unmatched.length > 0 ? "is-hot" : "zero"}`}>
              <div className="lab">Не сопоставлено</div>
              <div className="v">{finalReport.unmatched.length}</div>
              <div className="foot"><span className="mk" />не импортированы</div>
            </div>
          </div>
          {finalReport.rejected.length > 0 && (
            <p className="hint" style={{ marginTop: 10, color: "var(--hot)" }}>
              Отклонено ядром при проверке: {finalReport.rejected.length} — причины в скачиваемом
              отчёте.
            </p>
          )}
          <div className="form-actions" style={{ marginTop: 14 }}>
            <button type="button" className="btn" onClick={() => downloadReport(finalReport, fileName ?? "реестр")}>
              Скачать проблемные строки текстом
            </button>
            <button type="button" className="btn ghost" onClick={resetAll}>
              Импортировать ещё файл
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
