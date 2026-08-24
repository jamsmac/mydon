"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { deleteAgent, saveAgent, toggleAgent } from "../app/agents/actions";
import type { AgentCard } from "../lib/core";

const TIERS: { value: string; label: string }[] = [
  { value: "T0", label: "T0 — только спрашивает" },
  { value: "T1", label: "T1 — предлагает, решаешь ты" },
  { value: "T2", label: "T2 — мелкое делает сам" },
  { value: "T3", label: "T3 — многое делает сам" },
  { value: "T4", label: "T4 — почти всё сам" },
];

const BUSINESSES = [
  { value: "shared", label: "Общий" },
  { value: "globerent", label: "GLOBERENT" },
  { value: "vendhub", label: "VendHub" },
  { value: "personal", label: "Личное" },
  { value: "mydon", label: "MYDON" },
];

export function AgentEditor({ agent }: { agent: AgentCard }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const scheduleText = agent.schedule.map((s) => `${s.cron} | ${s.skill}`).join("\n");
  const on = agent.status === "active";

  function onSave(form: FormData) {
    start(async () => {
      const res = await saveAgent(agent.name, form);
      setMsg(res.ok ? { kind: "ok", text: "Сохранено" } : { kind: "err", text: res.error ?? "Ошибка" });
      if (res.ok) router.refresh();
    });
  }

  function onToggle() {
    start(async () => {
      const res = await toggleAgent(agent.name, !on);
      if (res.ok) router.refresh();
      else setMsg({ kind: "err", text: res.error ?? "Ошибка" });
    });
  }

  function onDelete() {
    start(async () => {
      const res = await deleteAgent(agent.name);
      if (res.ok && res.goTo) router.push(res.goTo);
      else setMsg({ kind: "err", text: res.error ?? "Ошибка" });
    });
  }

  return (
    <div className="card">
      <div className="card-top">
        <span className={`pill ${on ? "ok" : ""}`}>{on ? "работает" : "выключен"}</span>
        <button type="button" className="btn" onClick={onToggle} disabled={pending}>
          {on ? "Выключить" : "Включить"}
        </button>
      </div>

      <form
        className="form"
        onSubmit={(event) => {
          event.preventDefault();
          onSave(new FormData(event.currentTarget));
        }}
      >
        <label>
          <span>Направление</span>
          <select name="business" defaultValue={agent.business}>
            {BUSINESSES.map((b) => (
              <option key={b.value} value={b.value}>
                {b.label}
              </option>
            ))}
          </select>
        </label>

        <label>
          <span>Самостоятельность</span>
          <select name="autonomyDefault" defaultValue={agent.autonomyDefault}>
            {TIERS.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
          <small className="hint">
            Общий порог системы сейчас T0 — что бы ни стояло здесь, агент только предлагает.
          </small>
        </label>

        {/* Статус меняется кнопкой выше; в форме — скрытым полем, чтобы сохранение не сбрасывало его. */}
        <input type="hidden" name="status" value={agent.status} />

        <label>
          <span>Короткое описание</span>
          <input name="description" defaultValue={agent.description ?? ""} maxLength={512} />
        </label>

        <label>
          <span>Зачем нужен (миссия)</span>
          <textarea name="mission" rows={2} defaultValue={agent.mission ?? ""} maxLength={2000} />
        </label>

        <label>
          <span>Чего НЕ делает</span>
          <textarea
            name="nonGoals"
            rows={3}
            defaultValue={agent.nonGoals.join("\n")}
            placeholder="По одному на строку. Например: НЕ закупает товар"
          />
          <small className="hint">Границы важнее возможностей: тут пишем, куда агент не лезет.</small>
        </label>

        <label>
          <span>Навыки</span>
          <textarea
            name="skills"
            rows={3}
            defaultValue={agent.skills.join("\n")}
            placeholder="По одному на строку. Например: monitor-stock"
          />
        </label>

        <label>
          <span>Расписания</span>
          <textarea
            name="schedule"
            rows={3}
            defaultValue={scheduleText}
            placeholder="0 9 * * 1 | watch-receivables"
          />
          <small className="hint">
            Строка = «когда | что делать». Время ташкентское. Примеры: «0 9 * * *» — каждый день в
            09:00; «0 9 * * 1» — по понедельникам в 09:00; «30 7 * * *» — в 07:30.
          </small>
        </label>

        <label>
          <span>Потолок трат в день, $</span>
          <input
            name="budgetPerDayUsd"
            defaultValue={agent.budgetPerDayUsd ?? ""}
            placeholder="например 3"
            inputMode="decimal"
          />
        </label>

        <label>
          <span>При исчерпании бюджета</span>
          <select name="budgetOnExceeded" defaultValue={agent.budgetOnExceeded ?? ""}>
            <option value="">по умолчанию</option>
            <option value="pause">пауза — остановиться</option>
            <option value="downgrade">упростить — модель дешевле</option>
            <option value="ask">спросить владельца</option>
          </select>
        </label>

        <label>
          <span>Каналы идей (Telegram)</span>
          <textarea
            name="ideaChannels"
            rows={2}
            defaultValue={agent.ideaChannels.join("\n")}
            placeholder="По одному на строку. Например: promtjam"
          />
          <small className="hint">Публичные каналы, откуда агент берёт фишки (навыки scan-ideas / assess-ideas).</small>
        </label>

        <label>
          <span>Веб-источники (только чтение)</span>
          <textarea
            name="webSources"
            rows={3}
            defaultValue={agent.webSources.map((s) => `${s.name} | ${s.url}`).join("\n")}
            placeholder="Имя | https://адрес — по одному на строку"
          />
          <small className="hint">Сайты, которые агенту разрешено читать (навык read-sources).</small>
        </label>

        <label>
          <span>Навыки только через согласование (break-glass)</span>
          <textarea
            name="breakGlass"
            rows={2}
            defaultValue={agent.breakGlass.join("\n")}
            placeholder="По одному на строку. Эти навыки всегда спрашивают, даже на высокой автономии."
          />
        </label>

        <div className="form-actions">
          <button type="submit" className="btn primary" disabled={pending}>
            {pending ? "Сохраняю…" : "Сохранить"}
          </button>
          {msg && <span className={msg.kind === "ok" ? "ok-text" : "err-text"}>{msg.text}</span>}
        </div>
      </form>

      <div className="danger">
        {confirmDelete ? (
          <>
            <span className="err-text">Удалить «{agent.name}»? История его действий сохранится.</span>
            <button type="button" className="btn danger-btn" onClick={onDelete} disabled={pending}>
              Да, удалить
            </button>
            <button type="button" className="btn" onClick={() => setConfirmDelete(false)}>
              Отмена
            </button>
          </>
        ) : (
          <button type="button" className="btn" onClick={() => setConfirmDelete(true)}>
            Удалить агента
          </button>
        )}
      </div>
    </div>
  );
}
