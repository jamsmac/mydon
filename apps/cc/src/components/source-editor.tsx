"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { RAW_ROLES, RAW_ROLE_LABELS, type RawColumnRoles } from "@mydon/shared";
import { saveReport, saveSource, setRoles } from "../app/sources/actions";
import type { RawSourceState } from "../lib/core";

type Result = { ok: boolean; error?: string };

/** Общая обвязка формы: одна кнопка, одна ошибка словами. */
function useAction(): [boolean, string | null, (fn: () => Promise<Result>) => void] {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const act = (fn: () => Promise<Result>) => {
    setError(null);
    start(async () => {
      const res = await fn();
      if (res.ok) router.refresh();
      else setError(res.error ?? "Не получилось");
    });
  };
  return [pending, error, act];
}

/**
 * Завести систему-источник.
 *
 * Адрес кабинета можно оставить пустым: «ещё не записан» — честное состояние,
 * а выдуманный адрес хуже пустого поля.
 */
export function NewSource() {
  const [open, setOpen] = useState(false);
  const [pending, error, act] = useAction();
  const [code, setCode] = useState("");
  const [title, setTitle] = useState("");
  const [subtitle, setSubtitle] = useState("");
  const [url, setUrl] = useState("");

  if (!open) {
    return (
      <button type="button" className="btn sm ghost" onClick={() => setOpen(true)}>
        + Система
      </button>
    );
  }

  return (
    <form
      className="srcform"
      onSubmit={(e) => {
        e.preventDefault();
        act(async () => {
          const res = await saveSource({ code: code.trim(), title, subtitle, url });
          if (res.ok) {
            setOpen(false);
            setCode("");
            setTitle("");
            setSubtitle("");
            setUrl("");
          }
          return res;
        });
      }}
    >
      <div className="srcfr">
        <label>
          Код
          <input
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="click"
            required
            pattern="[a-z][a-z0-9_]{1,63}"
            title="латиница, цифры и подчёркивание, начиная с буквы"
          />
        </label>
        <label>
          Название
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Click" required />
        </label>
      </div>
      <div className="srcfr">
        <label>
          Что это в хозяйстве
          <input
            value={subtitle}
            onChange={(e) => setSubtitle(e.target.value)}
            placeholder="Платежи · кабинет мерчанта"
          />
        </label>
        <label>
          Адрес кабинета
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="можно оставить пустым"
          />
        </label>
      </div>
      <div className="srcfa">
        <button className="btn sm" type="submit" disabled={pending}>
          Завести
        </button>
        <button type="button" className="btn sm ghost" onClick={() => setOpen(false)}>
          Отмена
        </button>
        {error && <span className="err-text">{error}</span>}
      </div>
      <p className="hint">
        Код попадает в адрес и в базу, поэтому только латиница. Адрес кабинета
        можно не заполнять: пустое поле честнее выдуманного адреса.
      </p>
    </form>
  );
}

/** Завести отчёт внутри системы. Роли назначаются потом, по первой выгрузке. */
export function NewReport({ source }: { source: RawSourceState }) {
  const [open, setOpen] = useState(false);
  const [pending, error, act] = useAction();
  const [code, setCode] = useState("");
  const [title, setTitle] = useState("");
  const [ru, setRu] = useState("");
  const [path, setPath] = useState("");

  if (!open) {
    return (
      <button type="button" className="btn sm ghost" onClick={() => setOpen(true)}>
        + Отчёт
      </button>
    );
  }

  return (
    <form
      className="srcform"
      onSubmit={(e) => {
        e.preventDefault();
        act(async () => {
          const res = await saveReport({ source: source.code, code: code.trim(), title, ru, path });
          if (res.ok) {
            setOpen(false);
            setCode("");
            setTitle("");
            setRu("");
            setPath("");
          }
          return res;
        });
      }}
    >
      <div className="srcfr">
        <label>
          Код
          <input
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="settlements"
            required
            pattern="[a-z][a-z0-9_]{1,63}"
            title="латиница, цифры и подчёркивание, начиная с буквы"
          />
        </label>
        <label>
          Как называется в системе
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Settlements" required />
        </label>
      </div>
      <div className="srcfr">
        <label>
          Что это по-русски
          <input value={ru} onChange={(e) => setRu(e.target.value)} placeholder="Расчёты с мерчантом" />
        </label>
        <label>
          Где его нажать
          <input value={path} onChange={(e) => setPath(e.target.value)} placeholder="Отчёты → Расчёты" />
        </label>
      </div>
      <div className="srcfa">
        <button className="btn sm" type="submit" disabled={pending}>
          Завести
        </button>
        <button type="button" className="btn sm ghost" onClick={() => setOpen(false)}>
          Отмена
        </button>
        {error && <span className="err-text">{error}</span>}
      </div>
      <p className="hint">
        Роли колонок здесь не задаются: их назначают по настоящим заголовкам
        первой выгрузки. Угадывать название колонки, которой не видел, — то же
        самое, что выдумывать данные.
      </p>
    </form>
  );
}

/**
 * Назначение ролей колонок по настоящим заголовкам выгрузки.
 *
 * Это и есть «заполнить источник»: пока роли не назначены, все срезы поверх
 * отчёта пусты — им не за что зацепиться. После назначения отчёт работает
 * наравне с описанными в коде, без выкладки.
 */
export function RolesEditor({
  source,
  report,
  columns,
  roles,
  origin,
}: {
  source: string;
  report: string;
  /** Настоящие заголовки последней выгрузки. */
  columns: string[];
  roles: RawColumnRoles;
  origin: "code" | "owner";
}) {
  const [pending, error, act] = useAction();
  const current = (role: string): string => {
    const v = (roles as Record<string, unknown>)[role];
    if (typeof v === "string") return v;
    if (Array.isArray(v) && typeof v[0] === "string") return v[0];
    return "";
  };
  const [draft, setDraft] = useState<Record<string, string>>(() =>
    Object.fromEntries(RAW_ROLES.map((r) => [r, current(r)])),
  );

  if (columns.length === 0) {
    return (
      <div className="empty">
        <b>Роли назначать пока не по чему</b>
        Колонки видно только после первой выгрузки. Пока её нет, назначать роль
        было бы угадыванием — а угаданная колонка это молчаливо сломанный срез.
      </div>
    );
  }

  const assigned = RAW_ROLES.filter((r) => draft[r]).length;
  // Колонка не может играть две роли сразу: это разные величины отчёта.
  const used = new Map<string, string>();
  for (const r of RAW_ROLES) if (draft[r]) used.set(draft[r], r);
  const doubled = RAW_ROLES.filter((r) => draft[r] && used.get(draft[r]) !== r);

  return (
    <div className="sect" style={{ marginTop: 16 }}>
      <div className="sect-h">
        <h3 className="h2">Роли колонок</h3>
        <span className="chip b">
          назначено {assigned} из {RAW_ROLES.length}
        </span>
        <span className="chip">{origin === "owner" ? "назначал ты" : "описано в коде"}</span>
      </div>

      <p className="hint" style={{ marginBottom: 10 }}>
        Роль — это договор о том, как отчёт связан с реестром. Выбор идёт из
        настоящих заголовков последней выгрузки ({columns.length} колонок): роль,
        указывающая на несуществующую колонку, — это молчаливо сломанный срез.
        Роли, которой в отчёте нет, просто не назначай — пустое значение
        законное состояние.
      </p>

      <div className="roleslist">
        {RAW_ROLES.map((r) => (
          <label className={`rolerow ${doubled.includes(r) ? "hot" : ""}`} key={r}>
            <span className="rolel">{RAW_ROLE_LABELS[r]}</span>
            <select
              className="mapsel"
              value={draft[r] ?? ""}
              disabled={pending}
              onChange={(e) => setDraft({ ...draft, [r]: e.target.value })}
            >
              <option value="">этой роли в отчёте нет</option>
              {columns.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </label>
        ))}
      </div>

      {doubled.length > 0 && (
        <p className="warn" style={{ marginTop: 8 }}>
          Одна колонка назначена сразу на несколько ролей — это разные величины
          отчёта, и так быть не может.
        </p>
      )}

      <div className="srcfa" style={{ marginTop: 10 }}>
        <button
          type="button"
          className="btn sm"
          disabled={pending || doubled.length > 0}
          onClick={() => act(() => setRoles(source, report, draft))}
        >
          Сохранить роли
        </button>
        {error && <span className="err-text">{error}</span>}
      </div>
    </div>
  );
}
