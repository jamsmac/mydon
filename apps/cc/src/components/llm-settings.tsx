"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { saveLlmProfile } from "../app/system/actions";
import type { LlmProfileKey } from "../lib/core";
import type { LlmProfileValues } from "../lib/llm-profile";

const ROUTE_LABELS: Record<string, string> = {
  "codex-subscription": "Codex / подписка ChatGPT",
  "openai-api": "OpenAI API",
};

function modelLabel(model: string): string {
  return model === "gpt-5.6-sol" ? "GPT-5.6 Sol" : model || "модель не задана";
}

/**
 * Один видимый владельцу LLM-профиль. Здесь только не-секретная
 * конфигурация; формы API key/password намеренно нет.
 */
export function LlmSettings({ initial }: { initial: LlmProfileValues }) {
  const router = useRouter();
  const [draft, setDraft] = useState<LlmProfileValues>(initial);
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const set = (key: LlmProfileKey, value: string) => {
    setDraft((current) => ({ ...current, [key]: value }));
    setMessage(null);
  };

  const enabled = draft.LLM_ENABLED === "1";
  const routeLabel = ROUTE_LABELS[draft.LLM_ROUTE] ?? draft.LLM_ROUTE;
  const activation = !enabled
    ? { text: "Не активно", className: "" }
    : draft.LLM_ROUTE === "codex-subscription"
      ? { text: "Runtime не готов", className: "bad" }
      : { text: "Готовность неизвестна", className: "" };

  return (
    <section className="card llm-card" aria-labelledby="llm-settings-title">
      <div className="llm-card-head">
        <div>
          <div className="section-title" id="llm-settings-title">
            LLM
          </div>
          <p className="llm-summary">
            Выбрано: {routeLabel} · {modelLabel(draft.LLM_MODEL)}
          </p>
        </div>
        <span className={`pill ${activation.className}`}>{activation.text}</span>
      </div>

      <form
        className="form llm-form"
        onSubmit={(event) => {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          startTransition(async () => {
            try {
              const result = await saveLlmProfile(form);
              if (result.ok) {
                setMessage({ kind: "ok", text: "LLM-профиль сохранён" });
                router.refresh();
              } else {
                setMessage({ kind: "err", text: result.error ?? "Не получилось сохранить" });
              }
            } catch (error) {
              setMessage({
                kind: "err",
                text:
                  error instanceof Error
                    ? error.message
                    : "Связь оборвалась; настройки не сохранены",
              });
            }
          });
        }}
      >
        <label className="llm-toggle">
          <input
            type="checkbox"
            name="LLM_ENABLED"
            value="1"
            checked={enabled}
            onChange={(event) => set("LLM_ENABLED", event.currentTarget.checked ? "1" : "0")}
          />
          <span className="llm-toggle-copy">
            <strong>Использовать LLM</strong>
            <small>Сохранённые настройки сами по себе не запускают платные вызовы.</small>
          </span>
        </label>

        <div className="llm-grid">
          <label>
            <span>Маршрут</span>
            <select
              name="LLM_ROUTE"
              value={draft.LLM_ROUTE}
              aria-describedby="llm-route-help"
              onChange={(event) => set("LLM_ROUTE", event.currentTarget.value)}
            >
              {!ROUTE_LABELS[draft.LLM_ROUTE] && (
                <option value={draft.LLM_ROUTE}>Текущий: {draft.LLM_ROUTE}</option>
              )}
              <option value="codex-subscription">Codex / подписка ChatGPT (предпочтительно)</option>
              <option value="openai-api">OpenAI API (отдельная оплата)</option>
            </select>
            <small className="hint" id="llm-route-help">
              Автоматического переключения между подпиской и API нет.
            </small>
          </label>

          <label>
            <span>Модель</span>
            <input
              name="LLM_MODEL"
              value={draft.LLM_MODEL}
              required
              placeholder="gpt-5.6-sol"
              onChange={(event) => set("LLM_MODEL", event.currentTarget.value)}
            />
            <small className="hint">ID API; первоначально — GPT-5.6 Sol.</small>
          </label>
        </div>

        <div className="llm-grid llm-budget-grid">
          <label>
            <span>Общий потолок в день, $</span>
            <input
              name="LLM_GLOBAL_DAILY_BUDGET_USD"
              value={draft.LLM_GLOBAL_DAILY_BUDGET_USD}
              required
              inputMode="decimal"
              type="number"
              min="0"
              step="0.01"
              onChange={(event) => set("LLM_GLOBAL_DAILY_BUDGET_USD", event.currentTarget.value)}
            />
          </label>
          <label>
            <span>Потолок одного физического provider-вызова, $</span>
            <input
              name="LLM_MAX_RESERVATION_USD"
              value={draft.LLM_MAX_RESERVATION_USD}
              required
              inputMode="decimal"
              type="number"
              min="0"
              step="0.01"
              onChange={(event) => set("LLM_MAX_RESERVATION_USD", event.currentTarget.value)}
            />
          </label>
        </div>
        <p className="hint llm-budget-copy">
          Лимиты денег действуют в общем Core ledger для всех LLM-клиентов. $3 ограничивает каждый
          отдельный reserve/provider call, а не всю многошаговую задачу. Модель и подключение в этой
          карточке относятся к Agents.
        </p>

        <div className="llm-readiness" aria-label="Готовность подключения">
          <b>Готовность подключения</b>
          <div className="llm-readiness-row">
            <span>Codex / подписка ChatGPT</span>
            <span className="pill bad">runtime unsupported / fail-closed</span>
          </div>
          <div className="llm-readiness-row">
            <span>OpenAI API key в server env</span>
            <span className="pill">неизвестно до preflight</span>
          </div>
          <p className="hint">
            Ключ хранится только в окружении процесса Agents и не попадает в БД, панель или браузер.
            Подписка ChatGPT не оплачивает OpenAI API.
          </p>
        </div>

        <details className="llm-advanced">
          <summary>Расширенные настройки</summary>
          <div className="llm-grid">
            <label>
              <span>OpenAI-compatible base URL</span>
              <input
                name="LLM_BASE_URL"
                value={draft.LLM_BASE_URL}
                required
                inputMode="url"
                placeholder="https://api.openai.com/v1"
                onChange={(event) => set("LLM_BASE_URL", event.currentTarget.value)}
              />
              <small className="hint">
                Для маршрута OpenAI API Core принимает только официальный endpoint.
              </small>
            </label>
            <label>
              <span>Pricing provider ID</span>
              <input
                name="LLM_PRICE_PROVIDER_ID"
                value={draft.LLM_PRICE_PROVIDER_ID}
                required
                placeholder="openai"
                onChange={(event) => set("LLM_PRICE_PROVIDER_ID", event.currentTarget.value)}
              />
              <small className="hint">
                Для маршрута OpenAI API — <code>openai</code>.
              </small>
            </label>
          </div>
          <label>
            <span>Резервные модели (не маршруты)</span>
            <input
              name="LLM_FALLBACK_MODELS"
              value={draft.LLM_FALLBACK_MODELS}
              placeholder="model-a, model-b"
              onChange={(event) => set("LLM_FALLBACK_MODELS", event.currentTarget.value)}
            />
            <small className="hint">Через запятую. Это не переключает подписку на API.</small>
          </label>
          <p className="hint llm-legacy-copy">
            Устаревший <code>LLM_PROVIDER</code> скрыт: действующий маршрут задаёт{" "}
            <code>LLM_ROUTE</code>.
          </p>
        </details>

        <div className="form-actions">
          <button type="submit" className="btn primary" disabled={pending}>
            {pending ? "Сохраняю…" : "Сохранить настройки"}
          </button>
          {message && (
            <span className={message.kind === "ok" ? "ok-text" : "err-text"} aria-live="polite">
              {message.text}
            </span>
          )}
        </div>
      </form>
    </section>
  );
}
