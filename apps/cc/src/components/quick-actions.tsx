"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { quickDomainTask } from "../app/tasks/actions";

/**
 * Быстрые кнопки дашборда направления: пополнение, инкассация, чистка, ремонт.
 * Один клик — задача поставлена (срок завтра, приоритет высокий); исполнитель —
 * первый активный человек направления, иначе назначается в карточке задачи.
 */
export function QuickActions({
  domain,
  actions,
  defaultOwnerRef,
}: {
  domain: string;
  actions: string[];
  defaultOwnerRef: string | null;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [done, setDone] = useState<string | null>(null);

  function fire(title: string) {
    start(async () => {
      const res = await quickDomainTask(domain, title, defaultOwnerRef);
      setDone(res.ok ? `Задача «${title}» поставлена` : (res.error ?? "Не получилось"));
      if (res.ok) router.refresh();
    });
  }

  return (
    <div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {actions.map((a) => (
          <button key={a} type="button" className="btn sm" disabled={pending} onClick={() => fire(a)}>
            + {a}
          </button>
        ))}
      </div>
      {done && <p className="hint" style={{ marginTop: 8 }}>{done}</p>}
    </div>
  );
}
