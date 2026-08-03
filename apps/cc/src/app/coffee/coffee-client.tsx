"use client";

import { Fragment, useMemo, useState, useTransition } from "react";
import type {
  CoffeeBunkerIngredient,
  CoffeeConsumableRow,
  CoffeeFillStatusRow,
  CoffeeLocation,
  CoffeeLocationReconcileGroup,
  CoffeeLocationSummaryRow,
  CoffeeRefillRow,
  CoffeeStockLevelRow,
  CoffeeTareCell,
} from "../../lib/core";
import {
  addBunkerIngredient,
  ingestCoffeeStock,
  recordCoffeeConsumable,
  removeBunkerIngredient,
  setCoffeeIngredientPrice,
  setCoffeeTare,
  setCoffeeTargetFillWeight,
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

type Tab = "entry" | "table" | "reconcile" | "settings";

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
}) {
  const [tab, setTab] = useState<Tab>("entry");
  const alertCount =
    props.fillStatus.filter((r) => r.status === "underfill").length +
    props.reconcile.reduce((n, g) => n + g.rows.filter((r) => r.reconcile.status === "anomaly").length, 0);
  return (
    <>
      <div className="page-head">
        <h1>Кофе-бункеры</h1>
        <p>Ежедневная заливка, сводка по точкам, настройки ингредиентов и тары.</p>
      </div>
      <div className="coffee-tabs">
        <button className={tab === "entry" ? "on" : ""} onClick={() => setTab("entry")}>
          Ввод данных
        </button>
        <button className={tab === "table" ? "on" : ""} onClick={() => setTab("table")}>
          Таблица
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
      {tab === "table" && <TableTab summary={props.summary} consumables={props.consumables} locations={props.locations} />}
      {tab === "reconcile" && (
        <ReconcileTab fillStatus={props.fillStatus} reconcile={props.reconcile} from={props.reconcileFrom} to={props.reconcileTo} />
      )}
      {tab === "settings" && (
        <SettingsTab bunkerConfig={props.bunkerConfig} tareGrid={props.tareGrid} stockLevels={props.stockLevels} />
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

// ── Вкладка 2: Таблица ────────────────────────────────────────────────────

function TableTab({
  summary,
  consumables,
  locations,
}: {
  summary: CoffeeLocationSummaryRow[];
  consumables: CoffeeConsumableRow[];
  locations: CoffeeLocation[];
}) {
  return (
    <>
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

function StatusBadge({ status, label }: { status: "ok" | "anomaly" | "unknown" | "underfill"; label: string }) {
  const cls = status === "ok" ? "ok" : status === "unknown" ? "" : "bad";
  return <span className={`pill ${cls}`}>{label}</span>;
}

function ReconcileTab({
  fillStatus,
  reconcile,
  from,
  to,
}: {
  fillStatus: CoffeeFillStatusRow[];
  reconcile: CoffeeLocationReconcileGroup[];
  from: string;
  to: string;
}) {
  const underfills = fillStatus.filter((r) => r.status === "underfill");
  const anomalyGroups = reconcile
    .map((g) => ({ ...g, rows: g.rows.filter((r) => r.reconcile.status === "anomaly") }))
    .filter((g) => g.rows.length > 0);

  return (
    <>
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
                  </tr>
                ))}
              </tbody>
            </table>
          </Fragment>
        ))
      )}
    </>
  );
}

// ── Вкладка 3: Настройки ──────────────────────────────────────────────────

function SettingsTab({
  bunkerConfig,
  tareGrid,
  stockLevels,
}: {
  bunkerConfig: CoffeeBunkerIngredient[];
  tareGrid: CoffeeTareCell[];
  stockLevels: CoffeeStockLevelRow[];
}) {
  return (
    <>
      <div className="section-title">Ингредиенты по бункерам</div>
      {POSITIONS.map((p) => (
        <BunkerIngredients key={p} position={p} items={bunkerConfig.filter((c) => c.position === p)} />
      ))}

      <div className="section-title">Веса бункеров (тара, г)</div>
      <TareGridEditor tareGrid={tareGrid} />

      <div className="section-title">Склад ингредиентов (остаток, г)</div>
      <StockSection bunkerConfig={bunkerConfig} stockLevels={stockLevels} />
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
