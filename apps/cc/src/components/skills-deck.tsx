"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { runSkill } from "../app/skills/actions";
import type { SkillDeck, SkillDeckItem } from "../lib/core";
import { plural, when } from "../lib/format";
import { BUSINESS_LABEL, TIER_LABEL } from "../lib/labels";

/** Состояние агента словами: цвет лампы дублируется текстом, а не заменяется им. */
const AGENT_STATUS_LABEL: Record<SkillDeckItem["agentStatus"], string> = {
  active: "работает",
  paused: "выключен",
  draft: "не заведён",
  deprecated: "в архиве",
};

/** Лампа: работает — «идёт работа», выключен — «спокойно», остальное — «не запустится». */
const LED_CLASS: Record<SkillDeckItem["agentStatus"], string> = {
  active: "working",
  paused: "idle",
  draft: "blocked",
  deprecated: "blocked",
};

/** Статус задачи последнего запуска приходит строкой — переводим известные. */
const RUN_STATUS_LABEL: Record<string, string> = {
  todo: "поставлена",
  in_progress: "в работе",
  done: "сделана",
  cancelled: "отменена",
};

/**
 * Витрина навыков: что агенты умеют и что из этого можно запустить сейчас.
 *
 * Фильтры — направление и агент: у владельца десятки навыков, и вопрос он
 * задаёт себе не «какие вообще», а «что умеет вот этот».
 */
export function SkillsDeck({ deck }: { deck: SkillDeck }) {
  const [business, setBusiness] = useState<string | null>(null);
  const [agent, setAgent] = useState<string | null>(null);

  const businesses = [...new Set(deck.items.map((i) => i.business))].sort((a, b) =>
    a.localeCompare(b, "ru"),
  );
  const inBusiness = deck.items.filter((i) => business === null || i.business === business);
  const agents = [...new Set(inBusiness.map((i) => i.agent))].sort((a, b) => a.localeCompare(b, "ru"));
  const shown = inBusiness.filter((i) => agent === null || i.agent === agent);

  return (
    <>
      <p className="eyebrow">Направление</p>
      <div className="chips" role="group" aria-label="Фильтр по направлению">
        <button
          type="button"
          className="chip"
          aria-pressed={business === null}
          onClick={() => {
            setBusiness(null);
            setAgent(null);
          }}
        >
          Все направления
        </button>
        {businesses.map((b) => (
          <button
            key={b}
            type="button"
            className="chip"
            aria-pressed={business === b}
            onClick={() => {
              setBusiness(b);
              // Агент из другого направления после смены фильтра дал бы пустой
              // экран без объяснения — сбрасываем вместе с направлением.
              setAgent(null);
            }}
          >
            {BUSINESS_LABEL[b] ?? b}
          </button>
        ))}
      </div>

      <p className="eyebrow" style={{ marginTop: 12 }}>
        Агент
      </p>
      <div className="chips" role="group" aria-label="Фильтр по агенту">
        <button type="button" className="chip" aria-pressed={agent === null} onClick={() => setAgent(null)}>
          Все агенты
        </button>
        {agents.map((a) => (
          <button
            key={a}
            type="button"
            className="chip"
            aria-pressed={agent === a}
            onClick={() => setAgent(a)}
          >
            {a}
          </button>
        ))}
      </div>

      {shown.length === 0 ? (
        <div className="empty">
          <b>Под этот фильтр навыков нет</b>
          Сними фильтр — или впиши навык агенту в его карточке.
        </div>
      ) : (
        <div
          className="grid"
          style={{ gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", marginTop: 12 }}
        >
          {shown.map((item) => (
            <SkillCard key={`${item.agent}/${item.skill}`} item={item} />
          ))}
        </div>
      )}
    </>
  );
}

function SkillCard({ item }: { item: SkillDeckItem }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [taskId, setTaskId] = useState<string | null>(null);

  // Запускается только закреплённый навык работающего агента: остальное Core
  // отклонит, и честнее не давать нажать, чем показать отказ после нажатия.
  const canRun = item.agentStatus === "active" && item.enabled;
  const hint = canRun
    ? undefined
    : item.agentStatus === "active"
      ? "Впиши навык агенту в его карточке"
      : "Включи агента в его карточке";
  // Архивный агент по расписанию не ходит, даже если строки в карточке остались.
  const crons = item.agentStatus === "deprecated" ? [] : item.crons;

  function submit(form: FormData) {
    start(async () => {
      const res = await runSkill(item.agent, item.skill, form);
      if (res.ok) {
        setError(null);
        setTaskId(res.taskId ?? null);
        router.refresh();
      } else {
        // Поля НЕ трогаем: длинный вход владельца не должен пропасть из-за
        // отказа Core (конвенция форм, решение 24.08).
        setTaskId(null);
        setError(res.error ?? "Не получилось запустить");
      }
    });
  }

  return (
    <section className="panel console">
      <div className="eyebrow">
        {BUSINESS_LABEL[item.business] ?? item.business} · <Av8 name={item.agent} /> {item.agent}{" "}
        <span className={`led ${LED_CLASS[item.agentStatus]}`}>
          {AGENT_STATUS_LABEL[item.agentStatus]}
        </span>
      </div>
      <h3 style={{ fontSize: 15, fontWeight: 700 }}>{item.skill}</h3>
      <p style={{ margin: "4px 0 8px", fontSize: 13, color: "var(--tx-2)" }}>{item.description}</p>

      <div className="tags">
        <span className="pill">{item.executor === "llm" ? "модель" : "код"}</span>
        <span className="pill">{item.tier ? (TIER_LABEL[item.tier] ?? item.tier) : "тир не задан"}</span>
        {item.modelEffort && <span className="pill">усилие {item.modelEffort}</span>}
        {crons.length > 0 && (
          <span className="pill num">
            {crons.length} {plural(crons.length, "расписание", "расписания", "расписаний")}
          </span>
        )}
        {/* Агент есть в файлах, но карточки в базе нет: причина «не запускается»
            другая, чем у выключенного навыка, и лечится тоже иначе. */}
        {item.agentStatus === "draft" ? (
          <span className="pill">без карточки</span>
        ) : (
          !item.enabled && <span className="pill">выключен у агента</span>
        )}
        {/* Файл навыка обещает модель, а внутри код: важнее любой другой метки —
            владелец должен знать, что ответ придёт не от модели. */}
        {item.hasCode && item.executor === "llm" && <span className="pill warn">исполнится код</span>}
      </div>

      {item.problems.length > 0 && (
        <p className="warn-text" style={{ marginTop: 8 }}>
          {item.problems.join("; ")}
        </p>
      )}

      <p className="stats">
        {item.lastRun ? (
          <>
            <span>
              Последний запуск:{" "}
              {RUN_STATUS_LABEL[item.lastRun.status] ?? item.lastRun.status} ·{" "}
              {when(item.lastRun.createdAt)}
            </span>
            <Link href={`/tasks/${item.lastRun.taskId}`}>открыть</Link>
          </>
        ) : (
          <span>Ещё не запускался</span>
        )}
      </p>
      {item.lastRun?.blockedReason && (
        <p className="warn-text">Остановлен: {item.lastRun.blockedReason}</p>
      )}
      {/* Итог показываем началом строки: ответ модели бывает на экран, а карточка
          в сетке должна остаться карточкой — целиком он лежит в задаче. */}
      {item.lastRun?.resultNote && <p className="hint">{short(item.lastRun.resultNote)}</p>}

      <form
        className="form"
        style={{ marginTop: 10 }}
        onSubmit={(event) => {
          event.preventDefault();
          submit(new FormData(event.currentTarget));
        }}
      >
        <textarea
          name="input"
          rows={2}
          placeholder="Вход задачи (необязательно)"
          aria-label={`Вход задачи для навыка ${item.skill}`}
        />
        {item.executor === "llm" && (
          <select name="modelEffort" aria-label="Усилие модели" defaultValue="">
            <option value="">как в навыке</option>
            <option value="low">low</option>
            <option value="medium">medium</option>
            <option value="high">high</option>
            <option value="xhigh">xhigh</option>
          </select>
        )}
        <div className="btns">
          <button type="submit" className="btn sm" disabled={!canRun || pending} title={hint}>
            Запустить
          </button>
        </div>
        {error && <p className="warn-text">{error}</p>}
        {taskId && (
          <p className="ok-text">
            Задача поставлена — <Link href={`/tasks/${taskId}`}>открыть задачу</Link>
          </p>
        )}
      </form>
    </section>
  );
}

/** Первые полторы строки итога — остальное читается в самой задаче. */
function short(text: string): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > 140 ? `${one.slice(0, 140)}…` : one;
}

/**
 * Аватар агента: 8×8 клеток, детерминированно от имени.
 *
 * Имя рядом читается словами — картинка нужна, чтобы карточку одного агента
 * находить глазом в сетке, поэтому она aria-hidden.
 */
function Av8({ name }: { name: string }) {
  // FNV-1a: стабильный и короткий — одно имя всегда даёт один и тот же рисунок.
  let hash = 2166136261;
  for (let i = 0; i < name.length; i += 1) {
    hash ^= name.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  const cells: { x: number; y: number }[] = [];
  for (let y = 0; y < 8; y += 1) {
    for (let x = 0; x < 4; x += 1) {
      if (((hash >>> (y * 4 + x)) & 1) === 1) {
        // Левую половину зеркалим — получается «лицо», а не случайный шум.
        cells.push({ x, y }, { x: 7 - x, y });
      }
    }
  }
  return (
    <span className="av8" aria-hidden="true" data-name={name}>
      <svg viewBox="0 0 8 8" fill="currentColor">
        {cells.map((c) => (
          <rect key={`${c.x}-${c.y}`} x={c.x} y={c.y} width="1" height="1" />
        ))}
      </svg>
    </span>
  );
}
