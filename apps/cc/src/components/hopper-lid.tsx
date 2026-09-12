"use client";

import { useState } from "react";
import { isWeighBasis, lidWeightFromPair, WEIGH_BASES, WEIGH_BASIS_LABELS, type WeighBasis } from "@mydon/shared";

/**
 * Крышка бункера в паспорте узла (решение 12.09.2026).
 *
 * Два поля, но одно действие: сказать, с чем взвешена ТАРА, и один раз узнать
 * вес крышки. Зная его, техник взвешивает бункер как удобно — система сама
 * приводит замеры к одному основанию. Не зная — разные состояния просто не
 * сравниваются, и возврат встаёт в разбор.
 *
 * Считалка «по паре» здесь не украшение: вес крышки узнают, не снимая бункер с
 * весов дважды в разные дни — взвесили с крышкой, сняли, взвесили, разница и
 * есть крышка. Правило разницы — общее с сервером (`lidWeightFromPair`), чтобы
 * отказ «с крышкой должно быть тяжелее» звучал одинаково с обеих сторон.
 */
export function HopperLid({ tareBasis, lidWeight }: { tareBasis: string; lidWeight: number | null }) {
  const [basis, setBasis] = useState<WeighBasis>(isWeighBasis(tareBasis) ? tareBasis : "with_lid");
  const [lid, setLid] = useState(lidWeight === null ? "" : String(lidWeight));
  const [pairOpen, setPairOpen] = useState(false);
  const [withLid, setWithLid] = useState("");
  const [withoutLid, setWithoutLid] = useState("");
  const [pairMsg, setPairMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  function computeFromPair() {
    const a = Number.parseInt(withLid, 10);
    const b = Number.parseInt(withoutLid, 10);
    if (!Number.isFinite(a) || !Number.isFinite(b)) {
      setPairMsg({ kind: "err", text: "Нужны оба замера — с крышкой и без" });
      return;
    }
    const res = lidWeightFromPair(a, b);
    if ("problem" in res) {
      setPairMsg({ kind: "err", text: res.problem });
      return;
    }
    setLid(String(res.lidWeight));
    setPairMsg({ kind: "ok", text: `Крышка ${res.lidWeight} г — не забудь сохранить паспорт` });
  }

  return (
    <>
      <label>
        <span>Тара взвешена</span>
        <div className="mb-seg" role="group" aria-label="С чем взвешена тара">
          {WEIGH_BASES.map((b) => (
            <button key={b} type="button" className={basis === b ? "on" : ""} onClick={() => setBasis(b)}>
              {WEIGH_BASIS_LABELS[b]}
            </button>
          ))}
        </div>
        <input type="hidden" name="tareBasis" value={basis} />
        <small className="hint">
          До 12.09.2026 тару мерили только с крышкой — если её вносили тогда, оставь «с крышкой».
        </small>
      </label>
      <label>
        <span>Вес крышки, г</span>
        <input
          name="lidWeight"
          value={lid}
          onChange={(e) => setLid(e.target.value)}
          inputMode="numeric"
          placeholder="не измерен"
        />
        <small className="hint">
          {lid.trim() === ""
            ? "Пока не измерен: замер «без крышки» против тары «с крышкой» не посчитается — возврат уйдёт в разбор."
            : "Известен: взвешивай бункер как удобно, система приведёт замеры друг к другу."}
        </small>
      </label>
      {!pairOpen && (
        <div className="form-actions">
          <button type="button" className="btn sm" onClick={() => setPairOpen(true)}>
            Не знаю — посчитать по двум замерам
          </button>
        </div>
      )}
      {pairOpen && (
        <div className="form" style={{ borderLeft: "2px solid var(--line)", paddingLeft: 12 }}>
          <label>
            <span>Бункер с крышкой, г</span>
            <input value={withLid} onChange={(e) => setWithLid(e.target.value)} inputMode="numeric" />
          </label>
          <label>
            <span>Он же без крышки, г</span>
            <input value={withoutLid} onChange={(e) => setWithoutLid(e.target.value)} inputMode="numeric" />
          </label>
          <div className="form-actions">
            <button type="button" className="btn" onClick={computeFromPair}>
              Посчитать крышку
            </button>
            <button type="button" className="btn sm" onClick={() => { setPairOpen(false); setPairMsg(null); }}>
              Свернуть
            </button>
            {pairMsg && <span className={pairMsg.kind === "ok" ? "ok-text" : "err-text"}>{pairMsg.text}</span>}
          </div>
          <small className="hint">Два замера подряд, не снимая бункер с весов: разница и есть крышка.</small>
        </div>
      )}
    </>
  );
}
