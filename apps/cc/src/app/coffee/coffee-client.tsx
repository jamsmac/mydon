"use client";

import { Fragment, useMemo, useState, useTransition } from "react";
import type {
  CoffeeBunkerIngredient,
  CoffeeConsumableRow,
  CoffeeLocation,
  CoffeeLocationSummaryRow,
  CoffeeRefillRow,
  CoffeeTareCell,
} from "../../lib/core";
import {
  addBunkerIngredient,
  recordCoffeeConsumable,
  removeBunkerIngredient,
  setCoffeeTare,
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

type Tab = "entry" | "table" | "settings";

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
}) {
  const [tab, setTab] = useState<Tab>("entry");
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
        <button className={tab === "settings" ? "on" : ""} onClick={() => setTab("settings")}>
          Настройки
        </button>
      </div>
      {tab === "entry" && (
        <EntryTab locations={props.locations} bunkerConfig={props.bunkerConfig} recentRefills={props.recentRefills} />
      )}
      {tab === "table" && <TableTab summary={props.summary} consumables={props.consumables} locations={props.locations} />}
      {tab === "settings" && <SettingsTab bunkerConfig={props.bunkerConfig} tareGrid={props.tareGrid} />}
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

// ── Вкладка 3: Настройки ──────────────────────────────────────────────────

function SettingsTab({ bunkerConfig, tareGrid }: { bunkerConfig: CoffeeBunkerIngredient[]; tareGrid: CoffeeTareCell[] }) {
  return (
    <>
      <div className="section-title">Ингредиенты по бункерам</div>
      {POSITIONS.map((p) => (
        <BunkerIngredients key={p} position={p} items={bunkerConfig.filter((c) => c.position === p)} />
      ))}

      <div className="section-title">Веса бункеров (тара, г)</div>
      <TareGridEditor tareGrid={tareGrid} />
    </>
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
