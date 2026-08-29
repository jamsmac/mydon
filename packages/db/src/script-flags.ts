/**
 * Общий разбор аргументов разовых скриптов.
 *
 * Две причины существования: одна реализация правила (белый список ДО
 * первого запроса к базе — опечатка в флаге не должна тихо переключить режим)
 * и два разных умолчания. `backfill-product-ids.js` без флагов ПИШЕТ: его
 * зовёт `ci.yml` без аргументов, и это проверенный прогон, а не сюрприз.
 * Скрипты этого среза (`backfill-collection-keys.js`, `fix-collection-time.js`)
 * без флагов ОТКАЗЫВАЮТ: их запускают руками по живой базе, а «умолчание —
 * запись» для операции над денежным журналом было бы ловушкой, а не
 * удобством.
 */

export type РазборФлагов =
  | { ok: true; dryRun: boolean; режим: string; числа: Record<string, number> }
  | { ok: false; error: string };

const ЧИСЛОВОЙ_ФЛАГ = /^(--[a-z-]+)=(.*)$/;

/**
 * Текст всегда называет `--dry-run`/`--apply` дословно (образец —
 * `backfill-product-ids.test.ts`, тест «опечатка в флаге ОТБИВАЕТСЯ»: он
 * сверяет ЛЮБУЮ ошибку неизвестного флага регэкспом `/--dry-run/`).
 */
function неизвестныйФлаг(
  arg: string,
  опции: { безФлагов: "запись" | "отказ"; числа?: Readonly<Record<string, number>> },
): string {
  const умолчание = опции.безФлагов === "запись" ? "без флагов — ЗАПИСЬ" : "без флагов — отказ";
  const доп = опции.числа ? Object.keys(опции.числа).map((k) => `${k}=<N>`).join(", ") : "";
  return `Неизвестные аргументы: ${arg}. Допустимо только --dry-run или --apply (${умолчание})${доп ? `, ${доп}` : ""}.`;
}

export function разобратьФлаги(
  argv: readonly string[],
  opts: { безФлагов: "запись" | "отказ"; числа?: Readonly<Record<string, number>> },
): РазборФлагов {
  let dryRun: boolean | null = null;
  const числа: Record<string, number> = { ...(opts.числа ?? {}) };

  for (const arg of argv) {
    if (arg === "--dry-run") {
      if (dryRun !== null) return { ok: false, error: "--dry-run и --apply вместе — выбери один режим" };
      dryRun = true;
      continue;
    }
    if (arg === "--apply") {
      if (dryRun !== null) return { ok: false, error: "--dry-run и --apply вместе — выбери один режим" };
      dryRun = false;
      continue;
    }
    const m = ЧИСЛОВОЙ_ФЛАГ.exec(arg);
    if (m) {
      const [, имя, значение] = m;
      if (!opts.числа || !(имя! in opts.числа)) {
        return { ok: false, error: неизвестныйФлаг(arg, opts) };
      }
      if (!/^\d+$/.test(значение!)) {
        return { ok: false, error: `${arg}: значение обязано быть целым неотрицательным числом` };
      }
      числа[имя!] = Number(значение);
      continue;
    }
    return { ok: false, error: неизвестныйФлаг(arg, opts) };
  }

  if (dryRun === null) {
    if (opts.безФлагов === "отказ") {
      return { ok: false, error: "нужен ровно один из флагов: --dry-run или --apply" };
    }
    return { ok: true, dryRun: false, режим: "Режим: ЗАПИСЬ (без флагов — умолчание).", числа };
  }

  return {
    ok: true,
    dryRun,
    // Текст сохранён дословно: его читает существующий тест
    // `backfill-product-ids.test.ts` (образец, откуда разбор переехал сюда).
    режим: dryRun ? "Режим: ПРИМЕРКА (--dry-run), записи не будет." : "Режим: ЗАПИСЬ (--apply).",
    числа,
  };
}
