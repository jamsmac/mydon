"use client";

import { useEffect, useRef } from "react";
import { Sky } from "./sky-liquid";

/**
 * Фон панели: звёздное небо Ташкента (лёгкий canvas) + «жидкий эфир» (WebGL).
 * Перенесён из дизайна Claude Design. Выключается кнопкой в шапке; выбор
 * помнится в браузере. При reduced-motion жидкость не запускается вовсе.
 */
const KEY = "mydon_bg";

export function Background() {
  const skyRef = useRef<HTMLCanvasElement>(null);
  const lqRef = useRef<HTMLDivElement>(null);
  const capRef = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let sky: { stop(): void } | null = null;
    let liquid: { start(): void; dispose(): void } | null = null;
    let disposed = false;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const on = async () => {
      if (disposed) return;
      if (!sky && skyRef.current) {
        sky = new Sky(skyRef.current, capRef.current);
        // Небо — над тем местом, где владелец сейчас. Разрешение не дали или
        // геолокации нет — остаётся Ташкент, без ошибок и вопросов.
        if ("geolocation" in navigator) {
          navigator.geolocation.getCurrentPosition(
            (pos) => {
              if (!disposed && sky) {
                (sky as unknown as { setLocation(a: number, b: number): void }).setLocation(
                  pos.coords.latitude,
                  pos.coords.longitude,
                );
              }
            },
            () => {},
            { timeout: 8000, maximumAge: 600000 },
          );
        }
      }
      if (!liquid && !reduced && lqRef.current) {
        // three тяжёлый — грузится только когда фон реально включён
        const [THREE, { createLiquidEther }] = await Promise.all([
          import("three"),
          import("./sky-liquid"),
        ]);
        if (disposed) return;
        liquid = createLiquidEther(THREE, lqRef.current);
        liquid.start();
      }
      if (wrapRef.current) wrapRef.current.style.opacity = "1";
    };
    const off = () => {
      if (liquid) {
        liquid.dispose();
        liquid = null;
      }
      if (sky) {
        sky.stop();
        sky = null;
      }
      if (wrapRef.current) wrapRef.current.style.opacity = "0";
    };

    const want = localStorage.getItem(KEY) !== "0";
    if (want) void on();
    window.dispatchEvent(new CustomEvent("mydon:bg-state", { detail: want }));

    const onToggle = () => {
      const now = localStorage.getItem(KEY) !== "0";
      const next = !now;
      localStorage.setItem(KEY, next ? "1" : "0");
      if (next) void on();
      else off();
      window.dispatchEvent(new CustomEvent("mydon:bg-state", { detail: next }));
    };
    window.addEventListener("mydon:bg-toggle", onToggle);

    return () => {
      disposed = true;
      window.removeEventListener("mydon:bg-toggle", onToggle);
      off();
    };
  }, []);

  return (
    <div className="bgw" ref={wrapRef} style={{ opacity: 0 }} aria-hidden>
      <canvas id="skyc" ref={skyRef} />
      <div id="lq" ref={lqRef} />
      <div className="bgcap" ref={capRef} />
    </div>
  );
}
