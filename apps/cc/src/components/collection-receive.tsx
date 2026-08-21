"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { DENOMINATIONS, parseDenominations, type DenominationCounts } from "@mydon/shared";
import { cancelCollection, receiveCollection } from "../app/collections/actions";

/**
 * Разбор суммы — теми же правилами, что и серверное действие (`actions.ts`):
 * иначе «сошлось на глаз» на экране и «сошлось у ядра» на сервере могли бы
 * разойтись на пробелах/запятых. Пустая строка — не число, а «ещё не ввели»
 * (в отличие от `Number("")===0`, который спутал бы «не ввели» с «ноль сум»).
 */
function parseAmount(raw: string): number | null {
  if (raw.trim().length === 0) return null;
  const n = Number(raw.replace(/[\s,]/g, ""));
  return Number.isFinite(n) ? n : null;
}

/**
 * Приём инкассации: пересчитал наличные — ввёл сумму — принял.
 *
 * Разбивка по купюрам (срез К, задача 6) — необязательный довесок за
 * переключателем «По купюрам»: восемь полей номиналов скрыты по умолчанию,
 * ввод только суммы (как у всех 386 существующих записей) работает без
 * единого лишнего клика. Сумма купюр считается на глазах и сверяется с
 * введённой суммой ДО отправки — ядро (Task 3) всё равно повторит эту же
 * проверку при записи, форма её не заменяет, а лишь показывает раньше.
 * Отмена — для ошибочных нажатий оператора (след остаётся в журнале).
 */
export function CollectionReceive({ id }: { id: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [amount, setAmount] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [showDenoms, setShowDenoms] = useState(false);
  const [denomRaw, setDenomRaw] = useState<Record<string, string>>({});

  const denomsTouched = Object.values(denomRaw).some((v) => v.trim() !== "");
  const parsedDenoms = denomsTouched ? parseDenominations(denomRaw) : null;
  const denomError = parsedDenoms && "error" in parsedDenoms ? parsedDenoms.error : null;
  const amountNum = parseAmount(amount);

  // Расхождение видно ДО отправки: то же сообщение, что вернёт ядро при
  // несовпадении (`Сумма купюр не сошлась с заявленной…`, collections.service.ts).
  const mismatch =
    parsedDenoms && !("error" in parsedDenoms) && amountNum !== null && parsedDenoms.total !== amountNum
      ? { поКупюрам: parsedDenoms.total, заявлено: amountNum, разница: parsedDenoms.total - amountNum }
      : null;

  const canSubmit = amount.trim().length > 0 && !pending && !denomError && !mismatch;

  function act(fn: () => Promise<{ ok: boolean; error?: string }>) {
    start(async () => {
      const res = await fn();
      if (res.ok) router.refresh();
      else setError(res.error ?? "Не получилось");
    });
  }

  function submitReceive(): void {
    const denominations: DenominationCounts | undefined =
      denomsTouched && parsedDenoms && !("error" in parsedDenoms) ? parsedDenoms.counts : undefined;
    act(() => receiveCollection(id, amount, denominations));
  }

  function toggleDenoms(): void {
    // Скрыть = отказаться от разбивки: поля чистятся, чтобы забытое значение
    // в свёрнутой панели молча не блокировало приём одной суммой.
    if (showDenoms) setDenomRaw({});
    setShowDenoms((v) => !v);
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <input
          className="close-note"
          style={{ width: 130, flex: "none", textAlign: "right" }}
          placeholder="сумма, сум"
          inputMode="numeric"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && canSubmit) submitReceive();
          }}
        />
        <button type="button" className="btn sm ok" disabled={!canSubmit} onClick={submitReceive}>
          Принять
        </button>
        <button type="button" className="btn sm ghost" disabled={pending} onClick={() => act(() => cancelCollection(id))}>
          Отмена
        </button>
        <button type="button" className="btn sm ghost" onClick={toggleDenoms} aria-expanded={showDenoms}>
          {showDenoms ? "Скрыть купюры" : "По купюрам"}
        </button>
        {error && <span className="err-text">{error}</span>}
      </div>

      {showDenoms && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
          {DENOMINATIONS.map((d) => (
            <input
              key={d}
              className="close-note"
              style={{ width: 84, flex: "none", textAlign: "right" }}
              placeholder={d.toLocaleString("ru-RU")}
              aria-label={`купюр номиналом ${d.toLocaleString("ru-RU")} сум`}
              inputMode="numeric"
              value={denomRaw[String(d)] ?? ""}
              onChange={(e) => setDenomRaw((prev) => ({ ...prev, [String(d)]: e.target.value }))}
            />
          ))}
        </div>
      )}

      {showDenoms && denomsTouched && (
        <p className={denomError || mismatch ? "err-text" : "hint"} style={{ margin: 0 }}>
          {denomError
            ? denomError
            : mismatch
              ? `Купюры дают ${mismatch.поКупюрам.toLocaleString("ru-RU")} сум, введено ${mismatch.заявлено.toLocaleString("ru-RU")} сум — разница ${mismatch.разница.toLocaleString("ru-RU")} сум`
              : `Купюрами: ${(parsedDenoms as { total: number }).total.toLocaleString("ru-RU")} сум — совпадает с введённой суммой`}
        </p>
      )}
    </div>
  );
}
