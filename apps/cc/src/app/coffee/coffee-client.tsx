"use client";

import { Fragment, useMemo, useState, useTransition } from "react";
import type {
  CoffeeBunkerIngredient,
  CoffeeConsumableRow,
  CoffeeContainerConsumptionReport,
  CoffeeContainerReturnRow,
  CoffeeFillStatusRow,
  CoffeeLocation,
  CoffeeLocationReconcileGroup,
  CoffeeLocationSummaryRow,
  CoffeeMachineCandidate,
  CoffeePlacementRow,
  CoffeeRefillRow,
  CoffeeStockLevelRow,
  CoffeeTareCell,
  CoffeeWashScheduleRow,
  CoffeeWashScheduleStatusRow,
} from "../../lib/core";
import { BunkerLevels } from "../../components/bunker-levels";
import {
  addBunkerIngredient,
  autoLinkCoffeeLocations,
  createCoffeeAlertTask,
  createCoffeeLocation,
  deleteCoffeeContainerReturn,
  deleteCoffeeRefill,
  updateCoffeeLocation,
  ingestCoffeeStock,
  linkCoffeeLocation,
  unlinkCoffeeMachine,
  recordCoffeeConsumable,
  removeBunkerIngredient,
  removeCoffeeWashSchedule,
  setCoffeeIngredientPrice,
  setCoffeeTare,
  setCoffeeTargetFillWeight,
  setCoffeeWashSchedule,
  submitCoffeeRefill,
} from "./actions";

/**
 * Кофе-бункеры — три вкладки, порт данных и структуры 1:1 с рабочим
 * референс-приложением владельца (vendhubunker): «Ввод данных» / «Таблица» /
 * «Настройки». Цветовая тема сознательно не копирует референс дословно —
 * страница живёт внутри тёмной оболочки MYDON (свой акцент, свои токены),
 * иначе второй несовместимый фирменный стиль внутри одной панели выглядел бы
 * сломанным, а не «как в референсе». Поля, разбивка бункеров 1–8, наборов
 * 1–27 и вся логика — перенесены точно.
 */

const POSITIONS = [1, 2, 3, 4, 5, 6, 7, 8];
const CONTAINERS = Array.from({ length: 27 }, (_, i) => i + 1);

type Tab = "entry" | "table" | "journal" | "reconcile" | "settings";

function todayIso(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Tashkent" });
}

export function CoffeeClient(props: {
  locations: CoffeeLocation[];
  bunkerConfig: CoffeeBunkerIngredient[];
  tareGrid: CoffeeTareCell[];
  recentRefills: CoffeeRefillRow[];
  summary: CoffeeLocationSummaryRow[];
  consumables: CoffeeConsumableRow[];
  stockLevels: CoffeeStockLevelRow[];
  fillStatus: CoffeeFillStatusRow[];
  reconcile: CoffeeLocationReconcileGroup[];
  reconcileFrom: string;
  reconcileTo: string;
  washScheduleStatus: CoffeeWashScheduleStatusRow[];
  washSchedules: CoffeeWashScheduleRow[];
  machineCandidates: CoffeeMachineCandidate[];
  /** Журнал: история заливок (включая импорт Telegram) и возвратов наборов. */
  refillJournal: CoffeeRefillRow[];
  containerReturns: CoffeeContainerReturnRow[];
  /** История размещений: какой аппарат когда на какой точке стоял. */
  placements: CoffeePlacementRow[];
  /** Фактический расход по наборам за период сверки (заливка − возврат). */
  containerConsumption: CoffeeContainerConsumptionReport;
  /** Первый активный человек VendHub — кому уходит задача из «Сверки». */
  defaultOwnerRef: string | null;
}) {
  const [tab, setTab] = useState<Tab>("entry");
  const alertCount =
    props.fillStatus.filter((r) => r.status === "underfill").length +
    props.reconcile.reduce((n, g) => n + g.rows.filter((r) => r.reconcile.status === "anomaly").length, 0) +
    props.washScheduleStatus.filter((r) => r.status === "overdue").length;
  return (
    <>
      <div className="coffee-tabs">
        <button className={tab === "entry" ? "on" : ""} onClick={() => setTab("entry")}>
          Ввод данных
        </button>
        <button className={tab === "table" ? "on" : ""} onClick={() => setTab("table")}>
          Таблица
        </button>
        <button className={tab === "journal" ? "on" : ""} onClick={() => setTab("journal")}>
          Журнал
        </button>
        <button className={tab === "reconcile" ? "on" : ""} onClick={() => setTab("reconcile")}>
          Сверка{alertCount > 0 ? ` (${alertCount})` : ""}
        </button>
        <button className={tab === "settings" ? "on" : ""} onClick={() => setTab("settings")}>
          Настройки
        </button>
      </div>
      {tab === "entry" && (
        <EntryTab locations={props.locations} bunkerConfig={props.bunkerConfig} recentRefills={props.recentRefills} />
      )}
      {tab === "table" && (
        <TableTab summary={props.summary} consumables={props.consumables} locations={props.locations} fillStatus={props.fillStatus} />
      )}
      {tab === "journal" && (
        <JournalTab locations={props.locations} refills={props.refillJournal} containerReturns={props.containerReturns} />
      )}
      {tab === "reconcile" && (
        <ReconcileTab
          fillStatus={props.fillStatus}
          reconcile={props.reconcile}
          from={props.reconcileFrom}
          to={props.reconcileTo}
          washScheduleStatus={props.washScheduleStatus}
          containerConsumption={props.containerConsumption}
          defaultOwnerRef={props.defaultOwnerRef}
        />
      )}
      {tab === "settings" && (
        <SettingsTab
          bunkerConfig={props.bunkerConfig}
          tareGrid={props.tareGrid}
          stockLevels={props.stockLevels}
          locations={props.locations}
          washSchedules={props.washSchedules}
          machineCandidates={props.machineCandidates}
          placements={props.placements}
        />
      )}
    </>
  );
}

// ── Вкладка 1: Ввод данных ────────────────────────────────────────────────

function EntryTab({
  locations,
  bunkerConfig,
  recentRefills,
}: {
  locations: CoffeeLocation[];
  bunkerConfig: CoffeeBunkerIngredient[];
  recentRefills: CoffeeRefillRow[];
}) {
  const [pending, start] = useTransition();
  const [date, setDate] = useState(todayIso());
  const [locationId, setLocationId] = useState("");
  const [position, setPosition] = useState("");
  const [container, setContainer] = useState("");
  const [weight, setWeight] = useState("");
  const [packages, setPackages] = useState("1");
  const [msg, setMsg] = useState<string | null>(null);

  const ingredientsByPosition = useMemo(() => {
    const m = new Map<number, string[]>();
    for (const c of bunkerConfig) m.set(c.position, [...(m.get(c.position) ?? []), c.ingredientName]);
    return m;
  }, [bunkerConfig]);

  function submit() {
    setMsg(null);
    const w = Number(weight);
    if (!locationId) return setMsg("Выберите адрес.");
    if (!position) return setMsg("Выберите бункер.");
    if (!Number.isFinite(w) || w <= 0) return setMsg("Вес должен быть положительным числом.");
    start(async () => {
      const res = await submitCoffeeRefill({
        locationId,
        position: Number(position),
        ...(container ? { containerNumber: Number(container) } : {}),
        filledWeight: w,
        packageCount: packages ? Number(packages) : 1,
        enteredDate: date,
      });
      if (res.ok) {
        setMsg("Сохранено ✅");
        setWeight("");
        setContainer("");
        setPackages("1");
      } else {
        setMsg(res.message ?? "Не удалось сохранить.");
      }
    });
  }

  return (
    <div className="card coffee-form">
      <label>
        Дата
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
      </label>
      <label>
        Адрес
        <select value={locationId} onChange={(e) => setLocationId(e.target.value)}>
          <option value="">Выберите адрес</option>
          {locations.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        Бункер
        <select value={position} onChange={(e) => setPosition(e.target.value)}>
          <option value="">Выберите бункер</option>
          {POSITIONS.map((p) => (
            <option key={p} value={p}>
              {p}
              {ingredientsByPosition.get(p) ? ` · ${ingredientsByPosition.get(p)!.join("/")}` : ""}
            </option>
          ))}
        </select>
      </label>
      <label>
        Набор
        <select value={container} onChange={(e) => setContainer(e.target.value)}>
          <option value="">Выберите набор</option>
          {CONTAINERS.map((n) => (
            <option key={n} value={n}>
              {String(n).padStart(3, "0")}
            </option>
          ))}
        </select>
      </label>
      <label>
        Вес (г)
        <input type="number" min={0} value={weight} onChange={(e) => setWeight(e.target.value)} />
      </label>
      <label>
        Количество упаковок
        <input type="number" min={1} value={packages} onChange={(e) => setPackages(e.target.value)} />
      </label>
      <button className="btn primary" disabled={pending} onClick={submit}>
        {pending ? "Сохраняю…" : "Сохранить"}
      </button>
      {msg && <p className={msg.includes("✅") ? "ok-msg" : "err-msg"}>{msg}</p>}

      <div className="section-title">История ввода</div>
      {recentRefills.length === 0 ? (
        <p className="muted">Пока пусто.</p>
      ) : (
        <div className="rows">
          {recentRefills.map((r) => (
            <div className="row" key={r.id}>
              <div className="t">
                <b>{r.locationName}</b>
                <small>
                  бункер {r.position}
                  {r.containerNumber ? ` · набор ${String(r.containerNumber).padStart(3, "0")}` : ""} ·{" "}
                  {r.enteredDate}
                </small>
              </div>
              <span className="pill">
                {r.filledWeight}г · {r.packageCount} уп.
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Вкладка: Журнал — история заливок и возвратов ─────────────────────────

/** Откуда запись: импорт истории, сотрудник через бота, панель. */
function sourceLabel(createdBy: string | null): string | null {
  if (!createdBy) return null;
  if (createdBy.startsWith("import:")) return "импорт истории";
  if (createdBy.startsWith("person:")) return "сотрудник";
  return createdBy;
}

function JournalTab({
  locations,
  refills,
  containerReturns,
}: {
  locations: CoffeeLocation[];
  refills: CoffeeRefillRow[];
  containerReturns: CoffeeContainerReturnRow[];
}) {
  const [locationId, setLocationId] = useState("");
  const [pending, start] = useTransition();
  // Удалённое скрываем сразу (оптимистично) — сервер уже пишет строку в аудит.
  const [gone, setGone] = useState<Set<string>>(new Set());
  const shownRefills = (locationId ? refills.filter((r) => r.locationId === locationId) : refills).filter(
    (r) => !gone.has(r.id),
  );
  const shownReturns = containerReturns.filter((r) => !gone.has(r.id));

  const remove = (id: string, action: (id: string) => Promise<{ ok: boolean; message?: string }>) => {
    if (!window.confirm("Удалить запись? Строка целиком сохранится в журнале аудита.")) return;
    start(async () => {
      const res = await action(id);
      if (res.ok) setGone((prev) => new Set([...prev, id]));
    });
  };

  return (
    <div className="card">
      <label style={{ display: "block", marginBottom: 12 }}>
        Точка{" "}
        <select value={locationId} onChange={(e) => setLocationId(e.target.value)}>
          <option value="">все точки</option>
          {locations.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </select>
      </label>

      <div className="section-title">Заливки · {shownRefills.length}</div>
      {shownRefills.length === 0 ? (
        <p className="muted">Заливок пока нет.</p>
      ) : (
        <div className="rows">
          {shownRefills.map((r) => (
            <div className="row" key={r.id}>
              <div className="t">
                <b>
                  {r.enteredDate} · {r.locationName}
                </b>
                <small>
                  бункер {r.position}
                  {r.containerNumber ? ` · набор ${String(r.containerNumber).padStart(3, "0")}` : ""}
                  {sourceLabel(r.createdBy) ? ` · ${sourceLabel(r.createdBy)}` : ""}
                </small>
              </div>
              <span className="pill">
                {r.filledWeight}г · {r.packageCount} уп.
              </span>
              <button
                type="button"
                className="row-x"
                title="Удалить запись (сохранится в аудите)"
                disabled={pending}
                onClick={() => remove(r.id, deleteCoffeeRefill)}
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}
      {refills.length >= 300 && (
        <p className="hint">Показаны последние 300 заливок — более старое есть в базе и участвует в сверке.</p>
      )}

      {/* Возвраты не привязаны к точке в учёте (заголовок сообщения — лишь
          подсказка), поэтому фильтр по точке на них не действует. */}
      <div className="section-title" style={{ marginTop: 18 }}>
        Возвраты наборов · {shownReturns.length}
      </div>
      {shownReturns.length === 0 ? (
        <p className="muted">Возвратов пока нет.</p>
      ) : (
        <div className="rows">
          {shownReturns.map((r) => (
            <div className="row" key={r.id}>
              <div className="t">
                <b>
                  {r.returnedDate} · набор {String(r.containerNumber).padStart(3, "0")} · поз. {r.position}
                </b>
                <small>
                  {r.locationNote ? `${r.locationNote} · ` : ""}
                  {sourceLabel(r.createdBy) ?? ""}
                </small>
              </div>
              <span className="pill">
                {r.weight}г{r.netWeight !== null ? ` · нетто ${r.netWeight}г` : " · тара не калибрована"}
              </span>
              <button
                type="button"
                className="row-x"
                title="Удалить запись (сохранится в аудите)"
                disabled={pending}
                onClick={() => remove(r.id, deleteCoffeeContainerReturn)}
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}
      {containerReturns.length >= 300 && (
        <p className="hint">Показаны последние 300 возвратов.</p>
      )}
    </div>
  );
}

// ── Вкладка 2: Таблица ────────────────────────────────────────────────────

function TableTab({
  summary,
  consumables,
  locations,
  fillStatus,
}: {
  summary: CoffeeLocationSummaryRow[];
  consumables: CoffeeConsumableRow[];
  locations: CoffeeLocation[];
  fillStatus: CoffeeFillStatusRow[];
}) {
  // Наглядные бункеры (слово владельца): столбики уровней по точкам —
  // как в референс-приложении, но живьём из последних заливок.
  const fillByLocation = new Map<string, CoffeeFillStatusRow[]>();
  for (const r of fillStatus) fillByLocation.set(r.locationName, [...(fillByLocation.get(r.locationName) ?? []), r]);

  return (
    <>
      {fillByLocation.size > 0 && (
        <>
          <div className="section-title">Наглядно: уровни бункеров (последняя заливка против эталона)</div>
          <div className="bunker-grid">
            {[...fillByLocation.entries()]
              .sort((a, b) => a[0].localeCompare(b[0], "ru"))
              .map(([name, rows]) => (
                <div className="bunker-card" key={name}>
                  <div className="bk-loc">{name}</div>
                  <BunkerLevels rows={rows} />
                </div>
              ))}
          </div>
        </>
      )}

      <div className="section-title">Сводка по бункерам</div>
      <div className="table-scroll">
        <table className="coffee-table">
          <thead>
            <tr>
              <th rowSpan={2}>Адрес</th>
              {POSITIONS.map((p) => (
                <th key={p} colSpan={2}>
                  {p}
                </th>
              ))}
            </tr>
            <tr>
              {POSITIONS.map((p) => (
                <Fragment key={p}>
                  <th className="sub">уп.</th>
                  <th className="sub">г</th>
                </Fragment>
              ))}
            </tr>
          </thead>
          <tbody>
            {summary.map((row) => (
              <tr key={row.location}>
                <td className="addr">{row.location}</td>
                {POSITIONS.map((p) => {
                  const cell = row.byPosition[p];
                  return (
                    <Fragment key={p}>
                      <td className="num-cell">{cell?.packageCount ?? ""}</td>
                      <td>{cell?.weight ?? ""}</td>
                    </Fragment>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="section-title">Капсула и крышки</div>
      <ConsumablesTable consumables={consumables} locations={locations} />
    </>
  );
}

function ConsumablesTable({ consumables, locations }: { consumables: CoffeeConsumableRow[]; locations: CoffeeLocation[] }) {
  const [pending, start] = useTransition();
  const byLocation = useMemo(() => new Map(consumables.map((c) => [c.location, c])), [consumables]);
  const [edits, setEdits] = useState<Record<string, { water: number; cups: number; lids: number }>>({});

  function valueOf(name: string, field: "water" | "cups" | "lids"): number {
    return edits[name]?.[field] ?? byLocation.get(name)?.[field] ?? 0;
  }

  function save(locationId: string, name: string) {
    const v = edits[name] ?? { water: valueOf(name, "water"), cups: valueOf(name, "cups"), lids: valueOf(name, "lids") };
    start(async () => {
      await recordCoffeeConsumable({ locationId, loggedDate: todayIso(), ...v });
    });
  }

  return (
    <div className="table-scroll">
      <table className="coffee-table">
        <thead>
          <tr>
            <th>Адрес</th>
            <th className="sub">Вода</th>
            <th className="sub">Стаканчики</th>
            <th className="sub">Крышки</th>
          </tr>
        </thead>
        <tbody>
          {locations.map((l) => (
            <tr key={l.id}>
              <td className="addr">{l.name}</td>
              {(["water", "cups", "lids"] as const).map((field) => (
                <td key={field}>
                  <input
                    type="number"
                    min={0}
                    className="cell-input"
                    disabled={pending}
                    defaultValue={valueOf(l.name, field)}
                    onBlur={(e) => {
                      const n = Number(e.target.value);
                      setEdits((prev) => ({
                        ...prev,
                        [l.name]: {
                          water: field === "water" ? n : valueOf(l.name, "water"),
                          cups: field === "cups" ? n : valueOf(l.name, "cups"),
                          lids: field === "lids" ? n : valueOf(l.name, "lids"),
                        },
                      }));
                      save(l.id, l.name);
                    }}
                  />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Вкладка: Сверка (алерты недолива и расхождения факт/ожидание) ──────────

const RECONCILE_LABEL: Record<"ok" | "anomaly" | "unknown", string> = {
  ok: "Сходится",
  anomaly: "Расхождение",
  unknown: "Нет данных",
};

const FILL_LABEL: Record<"ok" | "underfill" | "unknown", string> = {
  ok: "Норма",
  underfill: "Недолив",
  unknown: "Нет эталона",
};

function StatusBadge({ status, label }: { status: "ok" | "anomaly" | "unknown" | "underfill" | "overdue"; label: string }) {
  const cls = status === "ok" ? "ok" : status === "unknown" ? "" : "bad";
  return <span className={`pill ${cls}`}>{label}</span>;
}

const WASH_LABEL: Record<"ok" | "overdue" | "unknown", string> = {
  ok: "В графике",
  overdue: "Пора мыть",
  unknown: "Нет данных",
};

/** Кнопка «→ задача»: сигнал сверки превращается в задачу VendHub (срок завтра, high). */
function AlertTaskButton({ title, description, ownerRef }: { title: string; description: string; ownerRef: string | null }) {
  const [pending, start] = useTransition();
  const [done, setDone] = useState(false);
  if (done) return <span className="muted">задача поставлена</span>;
  return (
    <button
      className="tag-add"
      disabled={pending}
      title="Поставить задачу по этому сигналу (VendHub, срок завтра)"
      onClick={() =>
        start(async () => {
          const res = await createCoffeeAlertTask({ title, description, ownerRef });
          if (res.ok) setDone(true);
        })
      }
    >
      → задача
    </button>
  );
}

function ReconcileTab({
  fillStatus,
  reconcile,
  from,
  to,
  washScheduleStatus,
  containerConsumption,
  defaultOwnerRef,
}: {
  fillStatus: CoffeeFillStatusRow[];
  reconcile: CoffeeLocationReconcileGroup[];
  from: string;
  to: string;
  washScheduleStatus: CoffeeWashScheduleStatusRow[];
  containerConsumption: CoffeeContainerConsumptionReport;
  defaultOwnerRef: string | null;
}) {
  const underfills = fillStatus.filter((r) => r.status === "underfill");
  const anomalyGroups = reconcile
    .map((g) => ({ ...g, rows: g.rows.filter((r) => r.reconcile.status === "anomaly") }))
    .filter((g) => g.rows.length > 0);
  const overdueWash = washScheduleStatus.filter((r) => r.status === "overdue");
  const cc = containerConsumption;
  const num = (n: number) => n.toLocaleString("ru-RU");

  return (
    <>
      <div className="section-title">
        Расход по наборам (факт) · {cc.from} — {cc.to}
      </div>
      {cc.locations.length === 0 ? (
        <p className="muted">
          Пар «заливка → возврат» за период нет. Расход появляется, когда набор засыпали (с номером) и вернули.
        </p>
      ) : (
        <>
          <p className="hint">
            Всего израсходовано <b>{num(cc.totalGrams)} г</b>
            {cc.totalCost !== null ? <> · себестоимость <b>{num(Math.round(cc.totalCost))} сум</b></> : " · цены ингредиентов не заведены"}
            {" "}· пар {cc.rows.length}. Считается как нетто заливки − нетто возврата через тару набора — без телеметрии.
          </p>
          <table className="coffee-table">
            <thead>
              <tr>
                <th>Точка</th>
                <th>Расход, г</th>
                <th>Себестоимость, сум</th>
                <th>Пар</th>
                <th>Не посчитать</th>
              </tr>
            </thead>
            <tbody>
              {cc.locations.map((l) => (
                <tr key={l.locationId}>
                  <td>{l.locationName}</td>
                  <td>{num(l.grams)}</td>
                  <td>{l.cost !== null ? num(Math.round(l.cost)) : "—"}</td>
                  <td>{l.pairs}</td>
                  <td>{l.unknownPairs > 0 ? l.unknownPairs : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {cc.locations.some((l) => l.unknownPairs > 0) && (
            <p className="hint">
              «Не посчитать» — пары без калиброванной тары или где возврат тяжелее заливки; они не выдумываются нулями.
            </p>
          )}
        </>
      )}

      <div className="section-title">Недолив заливки (последняя заливка против эталона)</div>
      {underfills.length === 0 ? (
        <p className="muted">Недолива не обнаружено.</p>
      ) : (
        <table className="coffee-table">
          <thead>
            <tr>
              <th>Точка</th>
              <th>Бункер</th>
              <th>Ингредиент</th>
              <th>Чистый вес, г</th>
              <th>Эталон, г</th>
              <th>Статус</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {underfills.map((r) => (
              <tr key={`${r.locationId}:${r.position}`}>
                <td>{r.locationName}</td>
                <td className="num-cell">{r.position}</td>
                <td>{r.ingredientName ?? "—"}</td>
                <td className="num-cell">{r.netFillWeight ?? "—"}</td>
                <td className="num-cell">{r.targetFillWeight ?? "—"}</td>
                <td>
                  <StatusBadge status={r.status} label={FILL_LABEL[r.status]} />
                </td>
                <td>
                  <AlertTaskButton
                    title={`Долить бункер ${r.position} (${r.ingredientName ?? "?"}) — ${r.locationName}`}
                    description={`Недолив: чистый вес ${r.netFillWeight ?? "?"} г при эталоне ${r.targetFillWeight ?? "?"} г. Сигнал вкладки «Сверка» кофе-бункеров.`}
                    ownerRef={defaultOwnerRef}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div className="section-title">
        Расхождение факт/ожидание за период {from} — {to}
      </div>
      {anomalyGroups.length === 0 ? (
        <p className="muted">Расхождений сверх порога не найдено.</p>
      ) : (
        anomalyGroups.map((g) => (
          <Fragment key={g.locationId}>
            <div className="sub" style={{ marginTop: 8 }}>
              {g.locationName}
            </div>
            <table className="coffee-table">
              <thead>
                <tr>
                  <th>Ингредиент</th>
                  <th>Факт, г</th>
                  <th>Ожидание, г</th>
                  <th>Себестоимость факта</th>
                  <th>Себестоимость ожидания</th>
                  <th>Статус</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {g.rows.map((r) => (
                  <tr key={r.ingredientId}>
                    <td>{r.ingredientName}</td>
                    <td className="num-cell">{r.actualGrams ?? "—"}</td>
                    <td className="num-cell">{r.expectedGrams ?? "—"}</td>
                    <td className="num-cell">{r.costActual ?? "—"}</td>
                    <td className="num-cell">{r.costExpected ?? "—"}</td>
                    <td>
                      <StatusBadge status={r.reconcile.status} label={RECONCILE_LABEL[r.reconcile.status]} />
                    </td>
                    <td>
                      <AlertTaskButton
                        title={`Разобраться с расходом «${r.ingredientName}» — ${g.locationName}`}
                        description={`Расхождение факт/ожидание за ${from} — ${to}: факт ${r.actualGrams ?? "?"} г против ожидания ${r.expectedGrams ?? "?"} г. Сигнал вкладки «Сверка» кофе-бункеров.`}
                        ownerRef={defaultOwnerRef}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Fragment>
        ))
      )}

      <div className="section-title">Мойка/обслуживание — просрочено</div>
      {overdueWash.length === 0 ? (
        <p className="muted">Просроченных нет.</p>
      ) : (
        <table className="coffee-table">
          <thead>
            <tr>
              <th>Точка</th>
              <th>Бункер</th>
              <th>Дней с мойки</th>
              <th>Чашек с мойки</th>
              <th>Статус</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {overdueWash.map((r) => (
              <tr key={r.id}>
                <td>{r.locationName}</td>
                <td className="num-cell">{r.position ?? "вся точка"}</td>
                <td className="num-cell">{r.daysSinceWash ?? "—"}</td>
                <td className="num-cell">{r.cupsSinceWash ?? "—"}</td>
                <td>
                  <StatusBadge status={r.status} label={WASH_LABEL[r.status]} />
                </td>
                <td>
                  <AlertTaskButton
                    title={`Помыть ${r.position != null ? `бункер ${r.position}` : "кофемашину"} — ${r.locationName}`}
                    description={`Мойка просрочена: ${r.daysSinceWash != null ? `${r.daysSinceWash} дн. с последней` : "ещё ни разу не мыли"}${r.cupsSinceWash != null ? `, чашек с мойки ${r.cupsSinceWash}` : ""}. Сигнал вкладки «Сверка» кофе-бункеров.`}
                    ownerRef={defaultOwnerRef}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

// ── Вкладка 3: Настройки ──────────────────────────────────────────────────

function SettingsTab({
  bunkerConfig,
  tareGrid,
  stockLevels,
  locations,
  washSchedules,
  machineCandidates,
  placements,
}: {
  bunkerConfig: CoffeeBunkerIngredient[];
  tareGrid: CoffeeTareCell[];
  stockLevels: CoffeeStockLevelRow[];
  locations: CoffeeLocation[];
  washSchedules: CoffeeWashScheduleRow[];
  machineCandidates: CoffeeMachineCandidate[];
  placements: CoffeePlacementRow[];
}) {
  return (
    <>
      <div className="section-title">Точки</div>
      <LocationsEditSection locations={locations} />

      <div className="section-title">Привязка точек к автоматам реестра</div>
      <LocationLinkSection locations={locations} machines={machineCandidates} />

      <div className="section-title">История размещений</div>
      <PlacementHistorySection placements={placements} />

      <div className="section-title">Ингредиенты по бункерам</div>
      {POSITIONS.map((p) => (
        <BunkerIngredients key={p} position={p} items={bunkerConfig.filter((c) => c.position === p)} />
      ))}

      <div className="section-title">Веса бункеров (тара, г)</div>
      <TareGridEditor tareGrid={tareGrid} />

      <div className="section-title">Склад ингредиентов (остаток, г)</div>
      <StockSection bunkerConfig={bunkerConfig} stockLevels={stockLevels} />

      <div className="section-title">Расписание мойки/обслуживания</div>
      <WashScheduleSection locations={locations} schedules={washSchedules} />
    </>
  );
}

/**
 * Точки как справочник: переименование прямо в строке (сохранение по уходу из
 * поля), выключение вместо удаления (история заливок остаётся), добавление
 * новой. Каждая правка уходит в журнал аудита на стороне Core.
 */
function LocationsEditSection({ locations }: { locations: CoffeeLocation[] }) {
  const [pending, start] = useTransition();
  const [note, setNote] = useState<string | null>(null);
  const [newName, setNewName] = useState("");

  const run = (fn: () => Promise<{ ok: boolean; message?: string }>, after?: () => void) =>
    start(async () => {
      const res = await fn();
      setNote(res.ok ? null : res.message ?? "Не получилось");
      if (res.ok) after?.();
    });

  const rename = (l: CoffeeLocation, raw: string) => {
    const name = raw.trim();
    if (name.length === 0 || name === l.name) return;
    run(() => updateCoffeeLocation(l.id, { name }));
  };

  return (
    <>
      <p className="hint">
        Название правится прямо в поле (сохранится само). Ошибочную точку не удаляем, а выключаем — история
        заливок остаётся; выключенная не предлагается при вводе.
      </p>
      {note && <p className="hint">{note}</p>}
      <table className="coffee-table">
        <thead>
          <tr>
            <th>Название</th>
            <th>Активна</th>
          </tr>
        </thead>
        <tbody>
          {locations.map((l) => (
            <tr key={l.id}>
              <td>
                <input
                  className="tag-price"
                  style={{ width: "100%", textAlign: "left" }}
                  defaultValue={l.name}
                  disabled={pending}
                  onBlur={(e) => rename(l, e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                  }}
                />
              </td>
              <td>
                <input
                  type="checkbox"
                  checked={l.isActive}
                  disabled={pending}
                  onChange={(e) => run(() => updateCoffeeLocation(l.id, { isActive: e.target.checked }))}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <form
        className="tag-add-form"
        style={{ marginTop: 10, display: "flex", gap: 8 }}
        onSubmit={(e) => {
          e.preventDefault();
          const name = newName.trim();
          if (name.length === 0) return;
          run(
            () => createCoffeeLocation(name),
            () => setNewName(""),
          );
        }}
      >
        <input
          placeholder="Новая точка — название"
          value={newName}
          disabled={pending}
          onChange={(e) => setNewName(e.target.value)}
        />
        <button className="tag-add" disabled={pending || newName.trim().length === 0} type="submit">
          Добавить точку
        </button>
      </form>
    </>
  );
}

/**
 * История размещений: один аппарат мог работать на разных точках, на одной
 * точке — разные аппараты (слово владельца). Перепривязка в секции выше не
 * стирает прошлое — закрывает период и открывает новый; здесь видно всё.
 */
function PlacementHistorySection({ placements }: { placements: CoffeePlacementRow[] }) {
  if (placements.length === 0) {
    return <p className="hint">Пока пусто: история копится сама при каждой привязке/перестановке аппарата.</p>;
  }
  const period = (p: CoffeePlacementRow) =>
    `${p.startDate ?? "с неизвестной даты"} — ${p.endDate ?? "сейчас"}`;
  return (
    <div className="rows">
      {placements.map((p) => (
        <div className="row" key={p.id}>
          <div className="t">
            <b>
              {p.locationName} · {p.machineName}
              {p.machineRef ? ` №${p.machineRef}` : ""}
            </b>
            <small>
              {period(p)}
              {p.note ? ` · ${p.note}` : ""}
            </small>
          </div>
          <span className={`pill ${p.endDate === null ? "ok" : ""}`}>{p.endDate === null ? "стоит сейчас" : "история"}</span>
        </div>
      ))}
    </div>
  );
}

/**
 * Точка кофе ↔ карточка автомата в реестре: постоянная связь по id (переживает
 * переименования), автоподбор — по названию, только однозначные совпадения.
 * Через карточку точка получает серийник, координаты и место в общем учёте.
 */
function LocationLinkSection({ locations, machines }: { locations: CoffeeLocation[]; machines: CoffeeMachineCandidate[] }) {
  const [pending, start] = useTransition();
  const [note, setNote] = useState<string | null>(null);

  const machineLabel = (m: CoffeeMachineCandidate) =>
    `${m.name}${m.ref ? ` · №${m.ref}` : ""}${m.point ? ` · ${m.point}` : ""}`;
  const linked = locations.filter((l) => l.entityId !== null).length;

  return (
    <>
      <p className="hint">
        Привязано {linked} из {locations.length}. Связь даёт точке серийник и координаты карточки автомата.{" "}
        {machines.length === 0 && "В реестре пока нет карточек автоматов — они появляются из сбора/выгрузок ПО."}
      </p>
      {machines.length > 0 && (
        <button
          className="tag-add"
          disabled={pending}
          onClick={() =>
            start(async () => {
              const res = await autoLinkCoffeeLocations();
              setNote(res.message ?? (res.ok ? "Готово" : "Не получилось"));
            })
          }
        >
          Автопривязка по названию
        </button>
      )}
      {note && <p className="hint">{note}</p>}
      <table className="coffee-table">
        <thead>
          <tr>
            <th>Точка</th>
            <th>Аппараты на месте</th>
          </tr>
        </thead>
        <tbody>
          {locations.map((l) => {
            const стоят = l.machines ?? [];
            const занятые = new Set(стоят.map((m) => m.entityId));
            return (
              <tr key={l.id}>
                <td>{l.name}</td>
                <td>
                  {стоят.length === 0 ? (
                    <span className="hint">— пусто —</span>
                  ) : (
                    <div className="chips" style={{ marginBottom: 6 }}>
                      {стоят.map((m) => (
                        <span key={m.entityId} className="chip">
                          {m.name}
                          {m.ref ? ` · ${m.ref}` : ""}
                          <button
                            type="button"
                            className="btn ghost sm"
                            style={{ marginLeft: 6 }}
                            disabled={pending}
                            title="Снять аппарат с места"
                            onClick={() =>
                              start(async () => {
                                const res = await unlinkCoffeeMachine(m.entityId);
                                if (!res.ok) setNote(res.message ?? "Не удалось снять аппарат");
                              })
                            }
                          >
                            снять
                          </button>
                        </span>
                      ))}
                    </div>
                  )}
                  <select
                    disabled={pending || machines.length === 0}
                    value=""
                    onChange={(e) => {
                      const v = e.target.value;
                      if (v === "") return;
                      start(async () => {
                        const res = await linkCoffeeLocation(l.id, v);
                        if (!res.ok) setNote(res.message ?? "Не удалось поставить аппарат");
                      });
                    }}
                  >
                    <option value="">+ поставить аппарат…</option>
                    {machines
                      .filter((m) => !занятые.has(m.entityId))
                      .map((m) => (
                        <option key={m.entityId} value={m.entityId}>
                          {machineLabel(m)}
                        </option>
                      ))}
                  </select>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </>
  );
}

function WashScheduleSection({ locations, schedules }: { locations: CoffeeLocation[]; schedules: CoffeeWashScheduleRow[] }) {
  const [pending, start] = useTransition();
  const [adding, setAdding] = useState(false);
  const [locationId, setLocationId] = useState("");
  const [position, setPosition] = useState("");
  const [frequencyDays, setFrequencyDays] = useState("");
  const [frequencyCups, setFrequencyCups] = useState("");

  return (
    <>
      <table className="coffee-table">
        <thead>
          <tr>
            <th>Точка</th>
            <th>Бункер</th>
            <th>Частота, дней</th>
            <th>Частота, чашек</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {schedules.length === 0 && (
            <tr>
              <td colSpan={5} className="muted">
                Планов пока нет.
              </td>
            </tr>
          )}
          {schedules.map((s) => (
            <tr key={s.id}>
              <td>{s.locationName}</td>
              <td className="num-cell">{s.position ?? "вся точка"}</td>
              <td className="num-cell">{s.frequencyDays ?? "—"}</td>
              <td className="num-cell">{s.frequencyCups ?? "—"}</td>
              <td>
                <button
                  className="tag-x"
                  disabled={pending}
                  onClick={() =>
                    start(async () => {
                      await removeCoffeeWashSchedule(s.id);
                    })
                  }
                >
                  ×
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {adding ? (
        <div className="coffee-form" style={{ marginTop: 8 }}>
          <select value={locationId} onChange={(e) => setLocationId(e.target.value)}>
            <option value="">Точка…</option>
            {locations.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
          <input type="number" min={1} max={8} placeholder="Бункер (пусто — вся точка)" value={position} onChange={(e) => setPosition(e.target.value)} />
          <input type="number" min={1} placeholder="Частота, дней" value={frequencyDays} onChange={(e) => setFrequencyDays(e.target.value)} />
          <input type="number" min={1} placeholder="Частота, чашек" value={frequencyCups} onChange={(e) => setFrequencyCups(e.target.value)} />
          <button
            disabled={pending || !locationId || (!frequencyDays && !frequencyCups)}
            onClick={() =>
              start(async () => {
                await setCoffeeWashSchedule({
                  locationId,
                  ...(position ? { position: Number(position) } : {}),
                  ...(frequencyDays ? { frequencyDays: Number(frequencyDays) } : {}),
                  ...(frequencyCups ? { frequencyCups: Number(frequencyCups) } : {}),
                });
                setAdding(false);
                setLocationId("");
                setPosition("");
                setFrequencyDays("");
                setFrequencyCups("");
              })
            }
          >
            Сохранить
          </button>
          <button onClick={() => setAdding(false)}>Отмена</button>
        </div>
      ) : (
        <button className="tag-add" onClick={() => setAdding(true)}>
          + Добавить план
        </button>
      )}
    </>
  );
}

function StockSection({
  bunkerConfig,
  stockLevels,
}: {
  bunkerConfig: CoffeeBunkerIngredient[];
  stockLevels: CoffeeStockLevelRow[];
}) {
  const [pending, start] = useTransition();
  const stockById = new Map(stockLevels.map((s) => [s.ingredientId, s]));
  const ingredients = new Map<string, string>();
  for (const c of bunkerConfig) ingredients.set(c.ingredientId, c.ingredientName);
  for (const s of stockLevels) ingredients.set(s.ingredientId, s.ingredientName);
  const rows = [...ingredients.entries()].sort((a, b) => a[1].localeCompare(b[1], "ru"));

  if (rows.length === 0) return <p className="muted">Пока нет ингредиентов — заведите их в бункерах выше.</p>;

  return (
    <table className="coffee-table">
      <thead>
        <tr>
          <th>Ингредиент</th>
          <th>Остаток, г</th>
          <th>Пересчитано</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(([ingredientId, ingredientName]) => {
          const s = stockById.get(ingredientId);
          return (
            <tr key={ingredientId}>
              <td>{ingredientName}</td>
              <td className="num-cell">
                <input
                  type="number"
                  min={0}
                  className="cell-input"
                  disabled={pending}
                  defaultValue={s?.quantity ?? ""}
                  placeholder="—"
                  title="Пересчёт остатка склада, г — расхождение с прошлым уходит в лог"
                  onBlur={(e) => {
                    const v = e.target.value.trim();
                    if (v === "") return;
                    const quantity = Number(v);
                    if (!Number.isFinite(quantity) || quantity < 0) return;
                    start(async () => {
                      await ingestCoffeeStock(ingredientId, Math.round(quantity));
                    });
                  }}
                />
              </td>
              <td className="sub">{s ? new Date(s.countedAt).toLocaleString("ru-RU", { timeZone: "Asia/Tashkent" }) : "—"}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function BunkerIngredients({ position, items }: { position: number; items: CoffeeBunkerIngredient[] }) {
  const [pending, start] = useTransition();
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");

  return (
    <div className="bunker-ing">
      <div className="bunker-ing-h">Бункер {position}</div>
      <div className="tags">
        {items.length === 0 && !adding && <span className="muted">Пусто</span>}
        {items.map((it) => (
          <span className="tag" key={it.ingredientId}>
            {it.ingredientName}
            <input
              type="number"
              min={0}
              step="0.01"
              className="tag-price"
              disabled={pending}
              defaultValue={it.purchasePrice ?? ""}
              placeholder="цена/г"
              title="Закупочная цена за грамм, сум — для себестоимости расхода"
              onBlur={(e) => {
                const v = e.target.value.trim();
                if (v === "") return;
                const price = Number(v);
                if (!Number.isFinite(price) || price < 0) return;
                start(async () => {
                  await setCoffeeIngredientPrice(it.ingredientId, price);
                });
              }}
            />
            <input
              type="number"
              min={0}
              className="tag-price"
              disabled={pending}
              defaultValue={it.targetFillWeight ?? ""}
              placeholder="эталон г"
              title="Эталонный чистый вес заливки, г — сигнал недолива"
              onBlur={(e) => {
                const v = e.target.value.trim();
                if (v === "") return;
                const target = Number(v);
                if (!Number.isFinite(target) || target < 0) return;
                start(async () => {
                  await setCoffeeTargetFillWeight(position, it.ingredientId, target);
                });
              }}
            />
            <button
              className="tag-x"
              disabled={pending}
              onClick={() =>
                start(async () => {
                  await removeBunkerIngredient(position, it.ingredientId);
                })
              }
            >
              ×
            </button>
          </span>
        ))}
        {adding ? (
          <span className="tag-add-form">
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && name.trim()) {
                  start(async () => {
                    await addBunkerIngredient(position, name.trim());
                    setName("");
                    setAdding(false);
                  });
                }
                if (e.key === "Escape") setAdding(false);
              }}
              placeholder="Название"
            />
          </span>
        ) : (
          <button className="tag-add" onClick={() => setAdding(true)}>
            + Добавить
          </button>
        )}
      </div>
    </div>
  );
}

function TareGridEditor({ tareGrid }: { tareGrid: CoffeeTareCell[] }) {
  const [pending, start] = useTransition();
  const byKey = useMemo(() => new Map(tareGrid.map((c) => [`${c.containerNumber}:${c.position}`, c.tareWeight])), [tareGrid]);

  return (
    <div className="table-scroll">
      <table className="coffee-table">
        <thead>
          <tr>
            <th>#</th>
            {POSITIONS.map((p) => (
              <th key={p} className="sub">
                Бункер {p}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {CONTAINERS.map((n) => (
            <tr key={n}>
              <td className="addr">{String(n).padStart(3, "0")}</td>
              {POSITIONS.map((p) => (
                <td key={p}>
                  <input
                    type="number"
                    min={0}
                    className="cell-input"
                    disabled={pending}
                    defaultValue={byKey.get(`${n}:${p}`) ?? ""}
                    onBlur={(e) => {
                      const v = e.target.value.trim();
                      if (v === "") return;
                      const w = Number(v);
                      if (!Number.isFinite(w) || w < 0) return;
                      start(async () => {
                        await setCoffeeTare(n, p, w);
                      });
                    }}
                  />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
