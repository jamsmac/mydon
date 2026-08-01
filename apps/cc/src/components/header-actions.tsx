"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Ic } from "./icons";

/** Кнопки шапки: поиск, фон, решения. Фон общается с Background событиями. */
export function HeaderActions({ pendingCount }: { pendingCount: number }) {
  const [bgOn, setBgOn] = useState(false);

  useEffect(() => {
    const sync = (e: Event) => setBgOn(Boolean((e as CustomEvent).detail));
    window.addEventListener("mydon:bg-state", sync);
    return () => window.removeEventListener("mydon:bg-state", sync);
  }, []);

  return (
    <>
      <Link href="/registry" className="iconbtn" aria-label="Поиск по реестру">
        <Ic name="search" />
      </Link>
      <button
        type="button"
        className={`iconbtn ${bgOn ? "on" : ""}`}
        aria-label="Фон: небо над Ташкентом"
        onClick={() => window.dispatchEvent(new CustomEvent("mydon:bg-toggle"))}
      >
        <Ic name="sky" />
      </button>
      <Link href="/inbox" className="iconbtn" aria-label="Входящие">
        <Ic name="bell" />
        {pendingCount > 0 && <span className="cnt">{pendingCount}</span>}
      </Link>
    </>
  );
}
