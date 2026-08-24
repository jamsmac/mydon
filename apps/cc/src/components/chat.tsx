"use client";

import { useRef, useState, useTransition } from "react";
import Link from "next/link";
import { ask } from "../app/assistant/actions";

interface Msg {
  who: "you" | "mydon";
  text: string;
  approvalId?: string;
}

const SUGGESTIONS = ["брифинг", "что просрочено", "какие автоматы простаивают", "что было"];

export function Chat() {
  const [msgs, setMsgs] = useState<Msg[]>([
    { who: "mydon", text: "Спрашивай обычными словами. Например: «брифинг», «найди Olma», «что я решал»." },
  ]);
  const [input, setInput] = useState("");
  const [pending, startTransition] = useTransition();
  const endRef = useRef<HTMLDivElement>(null);

  function send(text: string) {
    const q = text.trim();
    if (!q || pending) return;
    setMsgs((m) => [...m, { who: "you", text: q }]);
    setInput("");
    startTransition(async () => {
      try {
        const reply = await ask(q);
        setMsgs((m) => [...m, { who: "mydon", text: reply.text, approvalId: reply.approvalId }]);
      } catch {
        setMsgs((m) => [
          ...m,
          { who: "mydon", text: "Помощник не ответил — попробуй ещё раз." },
        ]);
      }
      requestAnimationFrame(() => endRef.current?.scrollIntoView({ behavior: "smooth" }));
    });
  }

  return (
    <div className="chat">
      <div className="chat-log">
        {msgs.map((m, i) => (
          <div key={i} className={`msg ${m.who}`}>
            <div className="bubble">{m.text}</div>
            {m.approvalId && (
              <Link href="/approvals" className="msg-link">
                Открыть очередь решений →
              </Link>
            )}
          </div>
        ))}
        {pending && (
          <div className="msg mydon">
            <div className="bubble typing">…</div>
          </div>
        )}
        <div ref={endRef} />
      </div>

      <div className="chips">
        {SUGGESTIONS.map((s) => (
          <button key={s} className="chip" onClick={() => send(s)} disabled={pending}>
            {s}
          </button>
        ))}
      </div>

      <form
        className="chat-input"
        onSubmit={(e) => {
          e.preventDefault();
          send(input);
        }}
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Спроси MYDON…"
          aria-label="Вопрос помощнику"
          autoComplete="off"
        />
        <button type="submit" disabled={pending || !input.trim()}>
          →
        </button>
      </form>
    </div>
  );
}
