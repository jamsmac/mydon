"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import type { SystemConfigItem } from "../lib/core";
import { saveSystemConfig } from "../app/system/actions";

const SOURCE_LABEL: Record<SystemConfigItem["source"], string> = {
  db: "задано в панели",
  env: "из окружения",
  default: "по умолчанию",
};

/** Один тумблер: контрол по типу + строка «откуда значение» + сохранение. */
function Row({ item }: { item: SystemConfigItem }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [value, setValue] = useState(item.value);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  function onSave() {
    start(async () => {
      const res = await saveSystemConfig(item.key, value);
      setMsg(res.ok ? { kind: "ok", text: "Сохранено" } : { kind: "err", text: res.error ?? "Ошибка" });
      if (res.ok) router.refresh();
    });
  }

  const dirty = value !== item.value;

  return (
    <div className="row" style={{ display: "block" }}>
      <label className="form">
        <span>
          {item.label} <small className="hint">({item.key})</small>
        </span>

        {item.kind === "select" && (
          <select value={value} onChange={(e) => setValue(e.target.value)}>
            {(item.options ?? []).map((o) => (
              <option key={o} value={o}>
                {o === "" ? "— выкл —" : o}
              </option>
            ))}
          </select>
        )}

        {item.kind === "bool" && (
          <select value={value} onChange={(e) => setValue(e.target.value)}>
            <option value="1">Да (на паузе)</option>
            <option value="0">Нет (работают)</option>
          </select>
        )}

        {(item.kind === "text" || item.kind === "number") && (
          <input
            value={value}
            inputMode={item.kind === "number" ? "decimal" : "text"}
            placeholder={item.placeholder ?? ""}
            onChange={(e) => setValue(e.target.value)}
          />
        )}

        {item.help && <small className="hint">{item.help}</small>}
      </label>

      <div className="form-actions">
        <span className={`pill ${item.source === "db" ? "ok" : ""}`}>{SOURCE_LABEL[item.source]}</span>
        <button type="button" className="btn primary" onClick={onSave} disabled={pending || !dirty}>
          {pending ? "Сохраняю…" : "Сохранить"}
        </button>
        {msg && <span className={msg.kind === "ok" ? "ok-text" : "err-text"}>{msg.text}</span>}
      </div>
    </div>
  );
}

/**
 * Пульт активации: не-секретные глобальные тумблеры (мозг/RAG/пауза/бюджет).
 * Секреты (API-ключи) остаются в .env — их здесь принципиально нет.
 */
export function SystemEditor({ items }: { items: SystemConfigItem[] }) {
  return (
    <div className="rows">
      {items.map((it) => (
        <Row key={it.key} item={it} />
      ))}
    </div>
  );
}
