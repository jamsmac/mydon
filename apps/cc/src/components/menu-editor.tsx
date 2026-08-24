"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState, useTransition } from "react";
import type { MenuLine } from "@mydon/shared";
import { copyMenuFrom, createMenuProduct, saveMenu, setProductCategory } from "../app/card/actions";

/** Товар каталога, который можно поставить в меню. */
export interface MenuProductOption {
  id: string;
  name: string;
  /** 10 — кофейные (горячие), 11 — прохладительные, null — не размечен. */
  cat: number | null;
  /** Каталожная цена продажи — фолбэк, когда у аппарата нет своей. */
  price: number | null;
}

/** История цены товара на ЭТОМ аппарате — восстановлена из заказов источника. */
export interface MenuPriceInfo {
  price: number | null;
  periods: { price: number; from: string; to: string | null; orders: number }[];
  orders: number;
  mismatched: boolean;
}

/** Позиция из истории продаж, которой нет в меню (с карточкой или без). */
export interface UnlinkedSale {
  product: string;
  price: number | null;
  orders: number;
  /** Есть карточка каталога — можно поставить в меню одной кнопкой. */
  productId: string | null;
}

const sum = (n: number) => n.toLocaleString("ru-RU");

/**
 * Меню автомата — образец VendHub-OS, разложенный на реестр mydon:
 * товары из каталога, цена аппарата — оверрайд поверх каталожной,
 * горячее/холодное — категория карточки товара (тумблер одной кнопкой),
 * меню другого автомата копируется целиком как шаблон, недостающий товар
 * создаётся на месте и попадает в каталог. Детали (история цены по заказам)
 * раскрываются по строке, а не вываливаются все сразу.
 *
 * Стейт против сервера. `lines` — локальный черновик; `base` — снимок меню,
 * от которого черновик начат. После router.refresh() пропсы свежеют, а
 * useState — нет (урок «застывших инициализаторов» этого проекта), поэтому:
 * серверное меню изменилось и черновик чист — молча принимаем новое;
 * изменилось при живом черновике — предупреждаем, а сервер откажет по base
 * (сохранение не перетрёт чужое). Копирование и создание товара меняют меню
 * на сервере, значит при живом черновике они выключены — сначала сохранить.
 */
export function MenuEditor({
  machineId,
  domain,
  menu,
  products,
  machines,
  history,
  unlinked,
}: {
  machineId: string;
  /** Направление карточки; без него товар создавать некуда — форма скрыта. */
  domain: string | null;
  menu: MenuLine[];
  products: MenuProductOption[];
  /** Другие автоматы направления — источники для копирования меню. */
  machines: { id: string; name: string }[];
  /** productId → история цены на этом аппарате (из заказов источника). */
  history: Record<string, MenuPriceInfo>;
  unlinked: UnlinkedSale[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const serverKey = useMemo(() => JSON.stringify(menu), [menu]);
  const [lines, setLines] = useState<MenuLine[]>(menu);
  const [base, setBase] = useState(serverKey);
  const [dirty, setDirty] = useState(false);
  const [filter, setFilter] = useState<"all" | 10 | 11>("all");
  const [addId, setAddId] = useState("");
  const [copyId, setCopyId] = useState("");
  const [showNew, setShowNew] = useState(false);

  // Сервер прислал другое меню (копия, создание товара, второе окно).
  // Черновик чист — принимаем; живой черновик не трогаем, конфликт покажем.
  useEffect(() => {
    if (serverKey === base) return;
    if (!dirty) {
      setLines(menu);
      setBase(serverKey);
    }
    // Зависимость только serverKey нарочно: dirty/menu в момент срабатывания
    // читаются свежими, а реагировать надо на смену именно серверного меню.
  }, [serverKey]);
  const conflict = dirty && serverKey !== base;

  const byId = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);
  const inMenu = new Set(lines.map((l) => l.productId));

  const patch = (productId: string, price: number | null) => {
    setLines((prev) => prev.map((l) => (l.productId === productId ? { ...l, price } : l)));
    setDirty(true);
  };
  const addLine = (productId: string) => {
    if (inMenu.has(productId)) return;
    setLines((prev) => [...prev, { productId, price: null }]);
    setDirty(true);
  };
  const remove = (productId: string) => {
    setLines((prev) => prev.filter((l) => l.productId !== productId));
    setDirty(true);
  };

  /** Выполнить действие; dirty сбрасывает ТОЛЬКО сохранение меню. */
  const run = (fn: () => Promise<{ ok: boolean; error?: string }>, okText: string) => {
    setMsg(null);
    start(async () => {
      const res = await fn();
      if (res.ok) {
        setMsg({ ok: true, text: okText });
        router.refresh();
      } else {
        setMsg({ ok: false, text: res.error ?? "Не получилось" });
      }
    });
  };

  const save = () =>
    run(async () => {
      const res = await saveMenu(machineId, lines, base);
      if (res.ok) {
        // Сервер принял ровно этот черновик — он и есть новая база.
        setBase(JSON.stringify(lines));
        setDirty(false);
      }
      return res;
    }, "Меню сохранено");

  const toggleCat = (productId: string) => {
    const p = byId.get(productId);
    if (!p) return;
    const next = p.cat === 10 ? 11 : 10;
    run(() => setProductCategory(productId, next, machineId), "Категория обновлена");
  };

  const copy = () => {
    const from = machines.find((m) => m.id === copyId);
    if (!from) return;
    if (!window.confirm(`Заменить текущее меню (${lines.length} поз.) меню «${from.name}»?`)) return;
    // Черновика нет (кнопка активна только без правок) — refresh примет копию.
    run(() => copyMenuFrom(machineId, copyId), `Меню скопировано из «${from.name}»`);
  };

  const createNew = (form: FormData) => {
    if (!domain) return;
    run(async () => {
      const res = await createMenuProduct(domain, machineId, form);
      if (res.ok) setShowNew(false);
      return res;
    }, "Товар создан и добавлен в меню");
  };

  const visible = lines.filter((l) => {
    if (filter === "all") return true;
    return byId.get(l.productId)?.cat === filter;
  });
  const count = (c: 10 | 11) => lines.filter((l) => byId.get(l.productId)?.cat === c).length;
  const notInMenu = unlinked.filter((u) => u.productId === null || !inMenu.has(u.productId));

  return (
    <div className="sect" id="menu">
      <div className="sect-h">
        <h3 className="h2">Меню</h3>
        <span className="chip">{lines.length} поз.</span>
        <span className="sp" />
        {machines.length > 0 && (
          <>
            <select
              value={copyId}
              onChange={(e) => setCopyId(e.target.value)}
              disabled={pending || dirty}
              aria-label="Автомат-источник меню"
            >
              <option value="">Скопировать меню с…</option>
              {machines.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="btn ghost"
              onClick={copy}
              disabled={pending || !copyId || dirty}
              title={dirty ? "Сначала сохрани правки меню" : undefined}
            >
              Скопировать
            </button>
          </>
        )}
      </div>

      {/* Один тап — фильтр по температуре, как в клиентском меню VendingHub. */}
      <div className="mcm-chips">
        <button
          type="button"
          className={`chip${filter === "all" ? " b" : ""}`}
          onClick={() => setFilter("all")}
        >
          Все · {lines.length}
        </button>
        <button
          type="button"
          className={`chip${filter === 10 ? " b" : ""}`}
          onClick={() => setFilter(10)}
        >
          ☕ Горячие · {count(10)}
        </button>
        <button
          type="button"
          className={`chip${filter === 11 ? " b" : ""}`}
          onClick={() => setFilter(11)}
        >
          🥤 Холодные · {count(11)}
        </button>
      </div>

      {conflict && (
        <p className="err-text">
          ⚠ Меню изменилось в другом месте. Сохранение не перетрёт чужие правки — сервер его
          отклонит; обнови страницу (несохранённые правки цен пропадут).
        </p>
      )}

      {lines.length === 0 ? (
        <div className="empty">
          <b>Меню пусто</b>
          Добавь товары из каталога ниже, создай новый на месте — или скопируй
          готовое меню другого автомата кнопкой сверху.
        </div>
      ) : (
        <div className="mnu-grid">
          {visible.map((l) => {
            const p = byId.get(l.productId);
            const h = history[l.productId];
            const каталожная = p?.price ?? null;
            return (
              <div className="mnu-card" key={l.productId}>
                {/* Вся плитка ведёт в карточку товара — там история и детали. */}
                <Link
                  className="mnu-open"
                  href={`/card/${l.productId}#menus`}
                  aria-label={`Открыть карточку «${p?.name ?? "товар"}»`}
                />
                <div className="mnu-head">
                  <span className="mnu-name">{p?.name ?? "товар удалён"}</span>
                  <button
                    type="button"
                    className="mnu-x"
                    onClick={() => remove(l.productId)}
                    disabled={pending}
                    aria-label="Убрать из меню"
                    title="Убрать из меню"
                  >
                    ✕
                  </button>
                </div>

                <div className="mnu-row">
                  {/* Тумблер одной кнопкой: меняет категорию КАРТОЧКИ товара. */}
                  <button
                    type="button"
                    className={`chip mnu-cat${p?.cat === 10 ? " h" : p?.cat === 11 ? " g" : ""}`}
                    onClick={() => toggleCat(l.productId)}
                    disabled={pending || !p}
                    title="Переключить горячий/холодный"
                  >
                    {p?.cat === 10 ? "☕ горячий" : p?.cat === 11 ? "🥤 холодный" : "❔ не размечен"}
                  </button>
                  {/* Цена этого аппарата — правится не уходя со страницы. */}
                  <span className="mnu-price">
                    <input
                      inputMode="numeric"
                      placeholder={каталожная !== null ? String(каталожная) : "—"}
                      value={l.price ?? ""}
                      onChange={(e) => {
                        const v = e.target.value.replace(/\D/g, "");
                        patch(l.productId, v === "" ? null : Number(v));
                      }}
                      aria-label={`Цена «${p?.name ?? ""}» на этом аппарате`}
                    />
                    <span className="u">сум</span>
                  </span>
                </div>

                <div className="mnu-note">
                  {l.price === null
                    ? каталожная !== null
                      ? `по товару · ${sum(каталожная)} сум`
                      : "цена не задана"
                    : "своя цена аппарата"}
                  {h?.mismatched ? " · ⚠ заказы по другой" : ""}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Добавление из каталога: только товары, которых в меню ещё нет. */}
      <div className="mcm-add">
        <select value={addId} onChange={(e) => setAddId(e.target.value)} disabled={pending}>
          <option value="">Добавить товар из каталога…</option>
          {products
            .filter((p) => !inMenu.has(p.id))
            .map((p) => (
              <option key={p.id} value={p.id}>
                {p.cat === 10 ? "☕ " : p.cat === 11 ? "🥤 " : ""}
                {p.name}
                {p.price !== null ? ` · ${sum(p.price)}` : ""}
              </option>
            ))}
        </select>
        <button
          type="button"
          className="btn"
          disabled={pending || !addId}
          onClick={() => {
            addLine(addId);
            setAddId("");
          }}
        >
          В меню
        </button>
        {domain !== null && (
          <button
            type="button"
            className="btn ghost"
            onClick={() => setShowNew((v) => !v)}
            disabled={dirty && !showNew}
            title={dirty && !showNew ? "Сначала сохрани правки меню" : undefined}
          >
            {showNew ? "− Новый товар" : "+ Новый товар"}
          </button>
        )}
        <span className="sp" />
        <button type="button" className="btn pri" onClick={save} disabled={pending || !dirty}>
          Сохранить меню
        </button>
        {msg && <span className={msg.ok ? "ok-text" : "err-text"}>{msg.text}</span>}
      </div>

      {/* Товара нет в каталоге — создаётся здесь и появляется В КАТАЛОГЕ. */}
      {showNew && domain !== null && (
        <form
          className="form mcm-new"
          onSubmit={(event) => {
            event.preventDefault();
            createNew(new FormData(event.currentTarget));
          }}
        >
          <div style={{ display: "flex", gap: 8, alignItems: "flex-end", flexWrap: "wrap" }}>
            <label style={{ flex: "1 1 220px" }}>
              <span>Название</span>
              <input name="name" placeholder="Cappuccino 250ml" required minLength={2} />
            </label>
            <label style={{ flex: "0 0 140px" }}>
              <span>Категория</span>
              <select name="cat" defaultValue="10">
                <option value="10">☕ горячий</option>
                <option value="11">🥤 холодный</option>
              </select>
            </label>
            <label style={{ flex: "0 0 130px" }}>
              <span>Цена, сум</span>
              <input name="price" inputMode="numeric" placeholder="25000" />
            </label>
            <button type="submit" className="btn" disabled={pending}>
              Создать и в меню
            </button>
          </div>
          <p className="hint">Карточка появится в каталоге товаров направления — как обычная.</p>
        </form>
      )}

      {/* Продавалось по заказам, но в меню не стоит — кандидаты на добавление. */}
      {notInMenu.length > 0 && (
        <details className="mcm-det" style={{ marginTop: 12 }}>
          <summary>из истории продаж, не в меню · {notInMenu.length}</summary>
          <div className="mcm-hist">
            {notInMenu.map((u) => (
              /* Привязанные — по id карточки; сырые имена источника — своим
                 пространством ключей, чтобы тёзка карточки не столкнулась. */
              <div className="mcm-per" key={u.productId ?? `src:${u.product}`}>
                <b>{u.product}</b>
                <span className="mono">{u.price !== null ? `${sum(u.price)} сум` : "—"}</span>
                <span className="mono">{u.orders} зак.</span>
                {u.productId !== null ? (
                  <button
                    type="button"
                    className="btn ghost"
                    onClick={() => addLine(u.productId!)}
                    disabled={pending}
                  >
                    в меню
                  </button>
                ) : (
                  <span className="mono" title="Имя из источника без карточки каталога — привязка на карточке товара">
                    без карточки
                  </span>
                )}
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}
