import type { GapDigest } from "../lib/core";
import { plural } from "../lib/format";

/**
 * Сводка за сутки во «Входящих» (Н-2, волна 6).
 *
 * ОДНА ЗАПИСЬ В СУТКИ, А НЕ ПОШТУЧНО. Во «Входящих» и без того 42
 * непрочитанных; если сверху посыплются отдельные «пробел закрылся», читать
 * перестанут и сводку тоже. Поэтому здесь один блок, и он отвечает на три
 * вопроса сразу: что стало известно, что появилось, что висит давно.
 *
 * СТОИТ ПЕРВОЙ И НЕ ЖДЁТ РЕШЕНИЯ. Остальные секции «Входящих» — очередь дел;
 * эта — новости. Смешивать их в один счётчик нельзя: сводка не «ждёт слова»,
 * и попадание в счётчик непрочитанных сделало бы его неправдой.
 *
 * «Сверка не проходила» — ОТДЕЛЬНОЕ состояние, а не пустая сводка: молчание
 * из-за простоя и молчание из-за спокойного дня читаются одинаково, а значат
 * противоположное.
 */
export function GapDigestBlock({ digest }: { digest: GapDigest }) {
  const { becameKnown, appeared, returned, open, reconciled, day } = digest;
  const quiet = becameKnown.length === 0 && appeared.length === 0 && returned.length === 0;

  return (
    <section className="card" style={{ marginBottom: 16 }}>
      <div className="card-top">
        <h2 className="h2">Сводка за сутки</h2>
        <span className="muted">{day}</span>
      </div>

      {!reconciled ? (
        <p className="err-text">
          Сверка пробелов за этот день не проходила — это не «ничего не изменилось», а «не смотрели».
          Сверка идёт в 06:00 по Ташкенту.
        </p>
      ) : (
        <>
          {becameKnown.length > 0 && (
            <div className="rows">
              <div className="section-title">Стало известно</div>
              {becameKnown.map((g) => (
                <div className="row" key={g.key}>
                  <div className="t">
                    <b>{g.topic}</b>
                    <small className="hint">
                      закрылось после {g.openDays} {plural(g.openDays, "дня", "дней", "дней")} — теперь это считается
                    </small>
                  </div>
                </div>
              ))}
            </div>
          )}

          {returned.length > 0 && (
            <div className="rows">
              <div className="section-title">Снова не считается</div>
              {returned.map((g) => (
                <div className="row" key={g.key}>
                  <div className="t">
                    <b>{g.topic}</b>
                    <small className="hint">{g.missing}</small>
                  </div>
                </div>
              ))}
            </div>
          )}

          {appeared.length > 0 && (
            <div className="rows">
              <div className="section-title">Появилось</div>
              {appeared.map((g) => (
                <div className="row" key={g.key}>
                  <div className="t">
                    <b>{g.topic}</b>
                    <small className="hint">{g.missing}</small>
                  </div>
                </div>
              ))}
            </div>
          )}

          {quiet && <p className="muted">За сутки ничего не закрылось и ничего нового не появилось.</p>}
        </>
      )}

      <p className="muted">
        Открыто пробелов: {open.total}
        {open.stale.length > 0 && <> · висят дольше двух недель: {open.stale.length}</>}
      </p>
    </section>
  );
}
