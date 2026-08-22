import { Inject, Injectable } from "@nestjs/common";
import {
  coffeeBunkerConfig,
  coffeeContainerTare,
  coffeeIngredient,
  coffeeRefill,
  collection,
  entity,
  machinePlacement,
  moneyFlow,
  purchase,
  rawReportDef,
  sale,
  stockBatch,
  stockMovement,
} from "@mydon/db";
import { netWeight, parseRecipe, productKind, resolveIngredientPrice, strictNumber, TZ } from "@mydon/shared";
import { eq, ne, sql } from "drizzle-orm";
import { DB, type Db } from "../db/db.module";
import { appConfig } from "../config";
import { CollectionsService, type ИнтервалСверки, type РезультатСверкиСтрока } from "../collections/collections.service";
import { FinanceService } from "../finance/finance.service";
import { dayKey, daysBetween, type CashReconcilePeriod } from "../finance/finance.math";

/**
 * Реестр пробелов (срез К, задача 5).
 *
 * ЗАЧЕМ ЭТОТ МОДУЛЬ СУЩЕСТВУЕТ. Владелец: считать всё, что уже можно
 * посчитать; отклонения показывать сразу; а чего посчитать нельзя — не
 * молчать, а держать явный адресный список: что именно, за какой период,
 * каких данных не хватает.
 *
 * ГЛАВНОЕ ПРАВИЛО (R-K4): пробелы ВЫЧИСЛЯЮТСЯ на чтении, а не хранятся.
 * Хранимый список протух бы на следующий день. Если пробел закрылся данными —
 * он обязан исчезнуть сам, без чьего-либо действия: `list()` каждый раз
 * заново читает базу и заново решает, что показать.
 *
 * ПОЛЯ АНГЛИЙСКИЕ (R-K10) — модуль новый, соседей (вроде `collections` с
 * русскими ключами) у него нет, и они не образец.
 *
 * НЕ ДУБЛИРУЕТ ЧУЖУЮ ЛОГИКУ: сходимость по автоматам и касса против банка уже
 * посчитаны в `CollectionsService.reconcile` / `FinanceService.cashReconcile`
 * — здесь их результат только переводится в строки реестра. Цена ингредиента
 * — только через `resolveIngredientPrice` (см. ловушку у детектора цены ниже).
 */
export interface Gap {
  /** Что именно нельзя посчитать. */
  topic: string;
  /** За какой период — если пробел привязан ко времени. null — пробел не о конкретном окне. */
  period: { from: string; to: string } | null;
  /** Каких данных не хватает — человеческим языком. */
  missing: string;
  /** Сколько стоит пробел, если это выразимо деньгами или штуками. null — не выражается. */
  scale: string | null;
  /** Что сделать, чтобы закрылся. */
  action: string;
}

/** До первых реальных записей MYDON — «вся история» для reconcile/cashReconcile. */
const EPOCH_FROM = "2000-01-01";

/**
 * Порог тишины инкассаций, дней. Тот же порядок величины, что
 * `PRICE_ACTIVE_DAYS` в `raw.service.ts` (14): двух недель без единой записи
 * по всему парку достаточно, чтобы решить, что ввод остановился, а не что
 * просто выдался тихий день.
 */
const COLLECTION_SILENCE_DAYS = 14;

/**
 * Сумма в человеческом виде: «1 234 567 сум». Разделитель приводим к обычному
 * пробелу: ru-RU по умолчанию вставляет неразрывный (U+00A0), который не
 * виден глазом, но ломает поиск и сравнение (тот же приём, что в rules.ts).
 */
function formatSum(n: number): string {
  return `${Math.round(n).toLocaleString("ru-RU").replace(/\u00A0/g, " ")} сум`;
}

/* ── Детектор 1: инкассации — тишина ─────────────────────────────────────── */

/**
 * Последняя инкассация и сколько дней без новой записи. Считается от
 * `MAX(collectedAt)` по НЕотменённым инкассациям — если завтра появится
 * новая запись, порог пересчитается и пробел, если был, исчезнет сам.
 */
export function collectionSilenceGap(collectedAt: readonly (Date | string)[], today: string): Gap[] {
  if (collectedAt.length === 0) {
    return [
      {
        topic: "инкассации: тишина",
        period: null,
        missing: "в системе нет ни одной непогашенной (не отменённой) инкассации вовсе",
        scale: null,
        action: "проверить, ведётся ли физический сбор, и завести первую запись",
      },
    ];
  }
  const lastMs = Math.max(...collectedAt.map((d) => new Date(d).getTime()));
  const lastDay = dayKey(new Date(lastMs), TZ);
  const days = daysBetween(lastDay, today) ?? 0;
  if (days <= COLLECTION_SILENCE_DAYS) return [];
  return [
    {
      topic: "инкассации: тишина",
      period: { from: lastDay, to: today },
      missing: `последняя инкассация ${lastDay}, ${days} дней без единой новой записи`,
      scale: null,
      action: "проверить, собираются ли автоматы физически, и внести инкассации в систему",
    },
  ];
}

/* ── Детектор 2: касса — банк показал взнос, инкассации в системе нет ───── */

/** Границы календарного месяца `YYYY-MM` как `{from, to}` дат `YYYY-MM-DD`. */
function monthBounds(period: string): { from: string; to: string } {
  const [y, m] = period.split("-").map(Number);
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${period}-01`, to: `${period}-${String(lastDay).padStart(2, "0")}` };
}

/**
 * Периоды `FinanceService.cashReconcile` со статусом `noWithdrawn` (факт 9
 * плана среза К): банк показал взнос `0200`, а инкассаций в системе за тот
 * же месяц нет ни одной. Логика «что считать разрывом» уже решена в
 * `cashReconcile` — здесь только перевод в строку реестра.
 */
export function bankDepositsWithoutCollectionGaps(periods: readonly CashReconcilePeriod[]): Gap[] {
  return periods
    .filter((p) => p.status === "noWithdrawn")
    .map((p) => ({
      topic: "касса: банк показал взнос, инкассации в системе нет",
      period: monthBounds(p.period),
      missing: `банк показал взнос ${formatSum(p.deposited)} (${p.depositedCount} операций) за ${p.period}, инкассаций в системе за этот месяц нет ни одной`,
      scale: formatSum(p.deposited),
      action:
        "сверить соседние месяцы — лаг между сбором и взносом 2–7 дней сдвигает сумму на границу месяца; " +
        "если разрыв лагом не объясняется, внести недостающую инкассацию",
    }));
}

/* ── Детектор 3: инкассации — дыра в журнале ─────────────────────────────── */

interface RawJournalHole {
  machineId: string;
  from: string;
  to: string;
  expected: number;
  collected: number;
}

interface JournalHoleCluster {
  from: string;
  to: string;
  machines: Set<string>;
  expected: number;
  collected: number;
}

/**
 * Схлопывает пересекающиеся по времени «пробелы в журнале» разных автоматов
 * в одно окно — владельцу нужен один факт («N автоматов, окно X–Y»), а не
 * список из N строк на один и тот же провал ввода.
 */
function clusterJournalHoles(holes: readonly RawJournalHole[]): JournalHoleCluster[] {
  const sorted = [...holes].sort((a, b) => a.from.localeCompare(b.from));
  const clusters: JournalHoleCluster[] = [];
  for (const h of sorted) {
    const last = clusters[clusters.length - 1];
    if (last && h.from <= last.to) {
      if (h.to > last.to) last.to = h.to;
      last.machines.add(h.machineId);
      last.expected += h.expected;
      last.collected += h.collected;
    } else {
      clusters.push({ from: h.from, to: h.to, machines: new Set([h.machineId]), expected: h.expected, collected: h.collected });
    }
  }
  return clusters;
}

/**
 * Интервалы `CollectionsService.reconcile` со статусом «пробел в журнале»
 * (период между сборами длиннее удвоенной медианы автомата) — дисциплина
 * ввода, а не недостача. Здесь только группировка и перевод в реестр.
 */
export function journalHoleGaps(intervals: readonly ИнтервалСверки[]): Gap[] {
  const holes = intervals
    .filter((iv) => iv.статус === "пробел в журнале")
    // "пробел в журнале" и "ждёт приёма" взаимоисключающие статусы (см.
    // CollectionsService.reconcile) — изъято здесь никогда не null, `?? 0`
    // только защищает типы, а не реальный случай.
    .map((iv): RawJournalHole => ({ machineId: iv.machineId, from: iv.с.slice(0, 10), to: iv.по.slice(0, 10), expected: iv.ожидалось, collected: iv.изъято ?? 0 }));
  if (holes.length === 0) return [];
  return clusterJournalHoles(holes).map((c) => ({
    topic: "инкассации: дыра в журнале",
    period: { from: c.from, to: c.to },
    missing: `${c.machines.size} автоматов без инкассаций в этом окне: ожидалось ~${formatSum(c.expected)} наличной выручки против ${formatSum(c.collected)} записанных`,
    scale: formatSum(c.expected - c.collected),
    action: "закрывается выгрузкой исторических инкассаций из VendCash (Railway) — действие владельца",
  }));
}

/* ── Детектор 4: выручка есть, инкассаций нет вовсе ──────────────────────── */

/**
 * Строки `CollectionsService.reconcile` со статусом «инкассаций нет вовсе»
 * (снек и кофе-автоматы, что продают, но не инкассируются вовсе за всю
 * историю) — пробел ВВОДА, а не недостача (см. фикс задачи 3: такие строки
 * держатся вне итога сходимости).
 */
export function neverCollectedRevenueGaps(rows: readonly РезультатСверкиСтрока[]): Gap[] {
  return rows
    .filter((r) => r.статус === "инкассаций нет вовсе")
    .map((r) => ({
      topic: "инкассации: выручка есть, инкассаций нет вовсе",
      period: null,
      missing: `«${r.имя ?? r.machineId}»: наличная выручка ${formatSum(r.выручка)} за всю историю, ни одной инкассации по автомату не заведено`,
      scale: formatSum(r.выручка),
      action: "проверить схему сбора этой точки (не собирается ли она другим способом) либо завести инкассацию в систему",
    }));
}

/* ── Детектор 5: заливки без ингредиента ─────────────────────────────────── */

export function refillsWithoutIngredientGap(
  refills: readonly { ingredientId: string | null; filledWeight: number; enteredDate: string }[],
): Gap[] {
  const missing = refills.filter((r) => r.ingredientId === null);
  if (missing.length === 0) return [];
  const kg = Math.round((missing.reduce((s, r) => s + r.filledWeight, 0) / 1000) * 10) / 10;
  const dates = missing.map((r) => r.enteredDate).sort();
  return [
    {
      topic: "заливки без ингредиента",
      period: { from: dates[0], to: dates[dates.length - 1] },
      missing: `${missing.length} заливок бункера без указанного ингредиента, суммарно ${kg.toLocaleString("ru-RU")} кг`,
      scale: `${kg.toLocaleString("ru-RU")} кг`,
      action: "указать ингредиент по каждой заливке — обычно решается контекстом позиции (например, поз. 3: лимонный чай или матча)",
    },
  ];
}

/* ── Детекторы 6–7: партии — сроки годности и дата счёта ─────────────────── */

export function batchesWithoutExpiryGap(
  batches: readonly { receivedOn: string; expiryDate: string | null; manufactureDate: string | null }[],
): Gap[] {
  const missing = batches.filter((b) => b.expiryDate === null && b.manufactureDate === null);
  if (missing.length === 0) return [];
  const dates = missing.map((b) => b.receivedOn).sort();
  return [
    {
      topic: "сроки годности партий",
      period: { from: dates[0], to: dates[dates.length - 1] },
      missing: `${missing.length} из ${batches.length} партий без даты производства и срока годности — отчёт «Сроки годности» пуст не потому, что всё свежее, а потому что данные не введены`,
      scale: `${missing.length} партий`,
      action: "указывать срок годности или дату производства при приёме партии",
    },
  ];
}

export function batchesWithoutInvoiceDateGap(batches: readonly { receivedOn: string; invoiceDate: string | null }[]): Gap[] {
  const missing = batches.filter((b) => b.invoiceDate === null);
  if (missing.length === 0) return [];
  const dates = missing.map((b) => b.receivedOn).sort();
  return [
    {
      topic: "партии без даты счёта",
      period: { from: dates[0], to: dates[dates.length - 1] },
      missing: `${missing.length} из ${batches.length} партий без даты счёта-фактуры`,
      scale: `${missing.length} партий`,
      action: "указать дату счёта при вводе прихода",
    },
  ];
}

/* ── Детектор 8: закупки без даты прихода ────────────────────────────────── */

export function purchasesWithoutDateGap(purchases: readonly { dt: string | null }[]): Gap[] {
  const missing = purchases.filter((p) => p.dt === null);
  if (missing.length === 0) return [];
  return [
    {
      topic: "закупки без даты прихода",
      period: null,
      missing: `${missing.length} из ${purchases.length} строк реестра закупок без даты прихода`,
      scale: `${missing.length} строк`,
      action: "указать дату прихода в реестре закупок (mydon-stock) для этих строк",
    },
  ];
}

/* ── Детектор 9: ингредиенты без цены ────────────────────────────────────── */

/**
 * ЛОВУШКА (см. бриф задачи 5): `coffee_ingredient.purchase_price` пуст у ВСЕХ
 * живых ингредиентов, хотя цены есть и себестоимость считается — цена живёт в
 * карточке `entity(type='ingredient')`. Читать цену ТОЛЬКО через
 * `resolveIngredientPrice` (`@mydon/shared`), как и весь остальной код
 * (`bunkerConfig` в `coffee.service.ts`). Прямое чтение `purchasePrice` здесь
 * дало бы гарантированно ложные пробелы на здоровой системе.
 */
export function ingredientsWithoutPriceGap(
  ingredients: readonly { id: string; name: string; purchasePrice: string | null; cardAttrs: Record<string, unknown> | null }[],
): Gap[] {
  const missing = ingredients.filter((ing) => {
    const fallback = ing.purchasePrice != null ? Number(ing.purchasePrice) : null;
    return resolveIngredientPrice(ing.cardAttrs, fallback).pricePerGram === null;
  });
  if (missing.length === 0) return [];
  return [
    {
      topic: "ингредиенты без цены",
      period: null,
      missing: `${missing.length} из ${ingredients.length}: нет цены ни в карточке, ни в реестре — ${missing.map((m) => m.name).join(", ")}`,
      scale: `${missing.length} ингредиентов`,
      action: "указать «цена покупки» и «единица» в карточке (entity type='ingredient') каждого",
    },
  ];
}

/* ── Детектор 10: ингредиенты без веса упаковки ──────────────────────────── */

/**
 * ЛОВУШКА (см. бриф задачи 5): вес упаковки нужен НЕ ВСЕМ, а только тем, кого
 * реально заправляют пачками/стиками — остальные идут на вес, и требовать у
 * них вес упаковки значило бы плодить ложные пробелы (6 на живой системе).
 *
 * Признак «приход считается штуками» берём из фактических заливок: если хоть
 * раз техник указал `packageCount` для этого ингредиента (`coffee_refill`),
 * значит на практике его отгружают пачками, и вес упаковки нужен для перевода
 * в граммы (`stock_batch.prepareBatch`, тот же путь). Ингредиент без ни одной
 * такой заливки — на вес, и вес упаковки ему не нужен.
 */
export function ingredientsWithoutPackageWeightGap(
  ingredients: readonly { id: string; name: string; packageWeight: number | null; cardAttrs: Record<string, unknown> | null }[],
  refills: readonly { ingredientId: string | null; packageCount: number | null }[],
): Gap[] {
  const countedByPackage = new Set(
    refills.filter((r) => r.ingredientId !== null && r.packageCount != null).map((r) => r.ingredientId as string),
  );
  const missing = ingredients.filter((ing) => {
    if (!countedByPackage.has(ing.id)) return false; // приход не считается штуками — вес упаковки не нужен
    const fromCard = strictNumber(ing.cardAttrs?.["вес упаковки, г"]);
    const hasWeight = (fromCard != null && fromCard > 0) || (ing.packageWeight != null && ing.packageWeight > 0);
    return !hasWeight;
  });
  if (missing.length === 0) return [];
  return [
    {
      topic: "ингредиенты без веса упаковки",
      period: null,
      missing: `${missing.length}: приход считается пачками (заливки со счётом упаковок в журнале), а вес упаковки не указан — ${missing.map((m) => m.name).join(", ")}`,
      scale: `${missing.length} ингредиентов`,
      action: "указать «вес упаковки, г» в карточке (entity type='ingredient') или в реестре бункеров",
    },
  ];
}

/* ── Детектор 11: снек — канала оплаты нет ───────────────────────────────── */

/**
 * Пробел МОДЕЛИ, а не ввода (факт 9): в источнике снек-продаж нет колонки
 * платёжного канала вовсе, поэтому весь снек считается наличными. Закроется
 * не вводом данных, а изменением кода/коннектора — и это честно сказано в
 * `action`, а не спрятано.
 */
export function snackPaymentChannelGap(saleCount: number): Gap[] {
  if (saleCount <= 0) return [];
  return [
    {
      topic: "снек: канала оплаты нет",
      period: null,
      missing: `${saleCount} продаж снека считаются наличными целиком — в источнике нет колонки платёжного канала вовсе`,
      scale: `${saleCount} продаж`,
      action: "пробел модели, не ввода: закроется сам, когда источник (OurVend/mydon-stock) начнёт отдавать канал оплаты",
    },
  ];
}

/* ── Детектор 12: сверка купюр по автомату — односторонняя ───────────────── */

const BILL_REPORT_KEYWORDS = ["купюр", "банкнот", "banknote"];

/**
 * Разбивку по купюрам сегодня вводит только принимающий — отчёта САМОГО
 * автомата о принятых купюрах в системе нет (`raw_report_def` пуст для
 * `ourvend`, коннектор `ourvend.ts` такого отчёта не заводит). Владелец про
 * это знает («когда будет возможность сравнить») — значит пробел держим в
 * реестре явно. Появится отчёт с ролью купюр — гэп исчезнет сам.
 */
export function billReconciliationGap(reportDefs: readonly { sourceCode: string; code: string; title: string; ru: string }[]): Gap[] {
  const hasBillReport = reportDefs.some(
    (r) => r.sourceCode === "ourvend" && [r.code, r.title, r.ru].some((s) => BILL_REPORT_KEYWORDS.some((k) => s.toLowerCase().includes(k))),
  );
  if (hasBillReport) return [];
  return [
    {
      topic: "сверка купюр по автомату — односторонняя",
      period: null,
      missing:
        "разбивку по купюрам знает только принимающий; отчёта самого автомата о принятых купюрах в системе нет " +
        "(в raw_report_def нет такого отчёта для ourvend, коннектор его не отдаёт)",
      scale: null,
      action: "решение владельца: подключить отчёт автомата о принятых купюрах, когда появится техническая возможность — сверка включится сама",
    },
  ];
}

/* ── Детектор 13 (доп.): банковские записи без направления ───────────────── */

/**
 * ДОПОЛНИТЕЛЬНЫЙ ПРОБЕЛ, выявленный по ходу работы (не из брифа): импорт
 * банковской выписки (срез К, задача 4) кладёт запись без `domain`, если счёт
 * общий на всю компанию — и тогда наличные итоги по конкретному направлению
 * её не видят вовсе.
 *
 * ДВА ФИКСА (ревью среза К, 1.3):
 *  - `source==='bank'` — раньше выборка шла по ВСЕЙ `money_flow`, и ручные
 *    записи (`source='manual'`) с пустым `domain` (обычное дело — владелец
 *    решает привязку позже) попадали в этот пробел ИМПОРТА ВЫПИСКИ, хотя к
 *    импорту отношения не имеют. Пробел — только про импорт, отбор — только
 *    строки оттуда.
 *  - `direction` учитывается явно — раньше приход и расход складывались в
 *    ОДНО число, не равное ни приходу, ни расходу, ни сальдо (сложить кредит
 *    и дебет напрямую нельзя, это же правило у детектора 3
 *    `bankFlowsWithoutDomainGap`-соседа `journalHoleGaps`). Теперь считаются
 *    и показываются раздельно, а `scale` — честное сальдо (приход − расход).
 */
export function bankFlowsWithoutDomainGap(
  flows: readonly {
    domain: string | null;
    direction: "in" | "out";
    source: string;
    amount: string;
    currency: string;
    amountUzs: string | null;
    status: string;
  }[],
): Gap[] {
  const unassigned = flows.filter((f) => f.source === "bank" && f.domain === null && f.status !== "cancelled");
  if (unassigned.length === 0) return [];
  let inUzs = 0;
  let outUzs = 0;
  let unconverted = 0;
  for (const f of unassigned) {
    const amount = Number(f.amount);
    if (!Number.isFinite(amount)) continue;
    let uzs: number | null = null;
    if (f.currency === "UZS") {
      uzs = amount;
    } else {
      const amountUzs = f.amountUzs != null ? Number(f.amountUzs) : null;
      if (amountUzs !== null && Number.isFinite(amountUzs)) uzs = amountUzs;
    }
    if (uzs === null) {
      unconverted += 1;
      continue;
    }
    if (f.direction === "in") inUzs += uzs;
    else outUzs += uzs;
  }
  const netUzs = inUzs - outUzs;
  const note = unconverted > 0 ? ` (ещё ${unconverted} записей без курса, в сумму не вошли)` : "";
  return [
    {
      topic: "банковские записи без направления",
      period: null,
      missing: `${unassigned.length} записей банковской выписки без направления: приход ${formatSum(inUzs)}, расход ${formatSum(outUzs)} (сальдо ${formatSum(netUzs)}) — счёт общий, наличные итоги по направлению их не видят${note}`,
      scale: formatSum(netUzs),
      action: "привязать записи к направлению вручную (Панель → Финансы) либо сузить импорт выписки, если появятся отдельные счета по направлениям",
    },
  ];
}

/* ── Детектор 14 (доп.): здоровье — часовой пояс процесса ─────────────────── */

/**
 * ДОПОЛНИТЕЛЬНЫЙ ПРОБЕЛ: `/health` отдаёт `status: "ok"` даже при
 * `tzOk: false` — чинить нельзя без решения владельца, на это поле гейтится
 * автодеплой (`deploy/auto-deploy.sh`). Реестр не молчит о рассинхроне,
 * даже если health-эндпоинт его маскирует.
 */
export function healthTimezoneGap(actualTz: string, expectedTz: string): Gap[] {
  if (actualTz === expectedTz) return [];
  return [
    {
      topic: "здоровье: часовой пояс процесса",
      period: null,
      missing: `процесс сообщает часовой пояс «${actualTz}», ожидается «${expectedTz}» — /health при этом отдаёт status: "ok"`,
      scale: null,
      action: "чинить нельзя без решения владельца: на это поле гейтится автодеплой (deploy/auto-deploy.sh)",
    },
  ];
}

/* ── Детектор 15: заливки — замер «до досыпки» не делают ─────────────────── */

/**
 * Срез F, задача 4 (факт 7 плана): бот спрашивает вес бункера ДО досыпки
 * (`coffee-refill.ts::beforeStep`), но кнопка «пропустить» есть, и ей
 * пользуются буквально всегда — на проде 22.08.2026 `measured_before` пуст у
 * **0 из 1153** заливок. Без него расход между заливками виден только по
 * числу упаковок (`consumedSince()` в `coffee-calc.ts` — грубее, чем по весу).
 */
export function refillMeasuredBeforeMissingGap(refills: readonly { measuredBefore: number | null }[]): Gap[] {
  if (refills.length === 0) return [];
  const missing = refills.filter((r) => r.measuredBefore === null).length;
  if (missing === 0) return [];
  return [
    {
      topic: "заливки: замер «до досыпки» не делают",
      period: null,
      missing: `${missing} из ${refills.length} заливок без замера «до досыпки» — расход между заливками виден только по числу упаковок, не по весу`,
      scale: `${missing} из ${refills.length} заливок`,
      action:
        "весить бункер перед досыпкой и указывать «сколько было» в форме — шаг в боте уже есть, но с кнопкой «пропустить», которой пока пользуются всегда",
    },
  ];
}

/* ── Детекторы 16–17: тара позиций 4 и 3 не откалибрована ────────────────── */

/**
 * ЛОВУШКА (см. бриф задачи 4): проверка тары в `bunkerPeriod()` (срез F,
 * задача 2) идёт РАНЬШЕ проверки однозначности ингредиента — пара позиции 3
 * с «возврат тяжелее заливки» падает в корзину «тара не откалибрована», а не
 * «позиция неоднозначна», и настоящая причина (два ингредиента в одном
 * бункере) становится невидимой. Поэтому тару считаем ЗДЕСЬ отдельно и по
 * КАЖДОЙ позиции своей строкой — иначе владелец никогда не увидит, что у
 * позиции 3 та же болезнь, что и у позиции 4.
 *
 * Считается по СЫРОЙ заливке (без пары с возвратом): нетто = вес заливки
 * минус тара набора (`netWeight()`, тот же приём, что и в
 * `norm-fact.service.ts`). Заливки без известной тары (набор не откалиброван
 * вовсе) в знаменатель не входят — это другой, отдельный пробел, а не этот.
 *
 * ПРОВЕРЕНО НА ПРОДЕ 22.08.2026: позиция 4 (сахар) — 42 из 90 заливок с
 * известной тарой дают нетто ≤ 0, медиана нетто 14 г (факт 8 плана — совпало
 * день в день). Позиция 3 (лимонный чай/матча) — 13 из 58, медиана 370 г:
 * дефект того же рода, слабее выражен, но реален и не должен потеряться за
 * позицией 4.
 */
export function bunkerTareNetNonPositiveGap(
  position: number,
  refills: readonly { position: number; containerNumber: number | null; filledWeight: number }[],
  tareByKey: ReadonlyMap<string, number>,
): Gap[] {
  const nets: number[] = [];
  for (const r of refills) {
    if (r.position !== position || r.containerNumber === null) continue;
    const net = netWeight(r.filledWeight, tareByKey.get(`${r.containerNumber}:${position}`) ?? null);
    if (net !== null) nets.push(net);
  }
  if (nets.length === 0) return [];
  const nonPositive = nets.filter((n) => n <= 0).length;
  if (nonPositive === 0) return [];
  const sorted = [...nets].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
  return [
    {
      topic: `тара бункера: позиция ${position} не откалибрована`,
      period: null,
      missing: `${nonPositive} из ${nets.length} заливок позиции ${position} с известной тарой дают нетто ≤ 0 (медиана нетто ${Math.round(median)} г) — тара физического набора замерена неверно`,
      scale: `${nonPositive} заливок`,
      action: `перекалибровать тару контейнеров позиции ${position} в Настройках`,
    },
  ];
}

/* ── Детектор 18: бункеры — позиция не сконфигурирована ──────────────────── */

/**
 * Факт 9 плана (часть 2): позиция 8 встречается в реальных заливках, но ни
 * одного ингредиента для неё в `coffee_bunker_config` не заведено — расход
 * по ней восстановить нечем в принципе (не «ингредиент не указан в этой
 * заливке», а «системе неоткуда узнать, какой ингредиент там вообще может
 * быть»). Проверено на проде 22.08.2026: позиция 8 — 4 заливки, конфигурации
 * нет вовсе.
 */
export function unconfiguredBunkerPositionGap(
  usedPositions: readonly number[],
  configuredPositions: ReadonlySet<number>,
): Gap[] {
  const missing = [...new Set(usedPositions)].filter((p) => !configuredPositions.has(p)).sort((a, b) => a - b);
  if (missing.length === 0) return [];
  return [
    {
      topic: "бункеры: позиция не сконфигурирована",
      period: null,
      missing: `позици${missing.length === 1 ? "я" : "и"} ${missing.join(", ")} встреча${missing.length === 1 ? "ется" : "ются"} в заливках, но ни одного ингредиента для неё в coffee_bunker_config не задано`,
      scale: `${missing.length} позици${missing.length === 1 ? "я" : "и"}`,
      action: "добавить строку в «Настройки → Бункеры» для этой позиции: какой ингредиент в неё заливают",
    },
  ];
}

/* ── Детектор 19: бункеры — недолив не проверяется ───────────────────────── */

/** Число бункерных позиций на автомате — жёстко зашито схемой (`coffee_bunker_config_position_range`, 1..8). */
const BUNKER_POSITIONS = 8;

/**
 * Факт 10 плана: `target_fill_weight` не задан ни у одного из 8 бункеров —
 * `fillStatus()` (coffee-calc.ts) отдаёт «unknown» вместо «недолив», и
 * недостаточная заливка не ловится нигде. Проверено на проде 22.08.2026:
 * ни у одной из 7 сконфигурированных позиций эталон не задан, восьмая не
 * сконфигурирована вовсе (см. детектор 18) — итог тот же: 0 из 8.
 */
export function targetFillWeightMissingGap(configs: readonly { position: number; targetFillWeight: number | null }[]): Gap[] {
  const withTarget = new Set(configs.filter((c) => c.targetFillWeight !== null).map((c) => c.position)).size;
  const missing = BUNKER_POSITIONS - withTarget;
  if (missing <= 0) return [];
  return [
    {
      topic: "бункеры: недолив не проверяется",
      period: null,
      missing: `target_fill_weight (эталонный чистый вес заливки) не задан ни у ${missing} из ${BUNKER_POSITIONS} бункерных позиций — недолив заливки не ловится ни на одной`,
      scale: `${missing} из ${BUNKER_POSITIONS} позиций`,
      action: "указать «эталонный вес заливки, г» для каждой позиции в «Настройки → Бункеры»",
    },
  ];
}

/* ── Детектор 20: заливки — телеграм-импорт архива застыл ─────────────────── */

/** Метка `coffee_refill.created_by`, которой архивный импорт помечает свои строки (`approvals.service.ts::executeCoffeeImport`). */
const TELEGRAM_IMPORT_MARKER = "import:telegram-history";

/** Тот же порядок величины тишины, что и у инкассаций (`COLLECTION_SILENCE_DAYS`). */
const TELEGRAM_IMPORT_SILENCE_DAYS = 14;

/**
 * Факт 13 плана (часть 1): разбор телеграм-переписки (`tools/import-telegram-
 * coffee.mjs`, заявки `executeCoffeeImport`) обрывается на конкретной дате, а
 * живой ввод через бота продолжается — то есть источник «архив» замолчал, а
 * не система в целом. Проверено на проде 22.08.2026: последняя заливка с
 * пометкой `import:telegram-history` — 03.08.2026, последняя заливка вообще
 * (включая ручной ввод) — 17.08.2026 (совпало день в день с фактом плана).
 *
 * Нет ни одной строки с этой пометкой вовсе (система без архивного импорта) —
 * не гэп этого детектора: нечему стынуть.
 */
export function telegramImportStalledGap(
  refills: readonly { createdBy: string | null; enteredDate: string }[],
  today: string,
): Gap[] {
  const importDates = refills.filter((r) => r.createdBy === TELEGRAM_IMPORT_MARKER).map((r) => r.enteredDate);
  if (importDates.length === 0) return [];
  const lastImport = [...importDates].sort().at(-1)!;
  const days = daysBetween(lastImport, today) ?? 0;
  if (days <= TELEGRAM_IMPORT_SILENCE_DAYS) return [];
  const lastAny = [...refills.map((r) => r.enteredDate)].sort().at(-1) ?? lastImport;
  return [
    {
      topic: "заливки: телеграм-импорт архива застыл",
      period: { from: lastImport, to: today },
      missing: `последняя заливка из телеграм-архива — ${lastImport} (${days} дней без новых строк оттуда); живой ввод продолжается — последняя заливка вообще ${lastAny}`,
      scale: null,
      action: "разобрать очередной экспорт переписки tools/import-telegram-coffee.mjs, когда он появится — действие владельца",
    },
  ];
}

/* ── Детектор 21: закупки сырья — тишина ──────────────────────────────────── */

/**
 * Партии сырья закупаются реже, чем собираются инкассации (крупная партия
 * держит склад неделями) — порог тишины взят на порядок больше
 * `COLLECTION_SILENCE_DAYS`, чтобы не поднимать ложную тревогу на здоровой
 * системе между обычными закупками.
 */
const STOCK_INTAKE_SILENCE_DAYS = 45;

/**
 * Факт 13 плана (часть 2): приход сырья (`stock_movement.kind='intake'`)
 * обрывается на конкретной дате. Проверено на проде 22.08.2026: последний
 * приход — 08.01.2026 (Шоколад), 226+ дней тишины на день проверки —
 * совпало день в день с фактом плана (закупки по `purchase`, мирроr
 * mydon-stock со снеком, здесь ни при чём: сырьё кофе заводится отдельно
 * через `stock_movement`, см. `stock.service.ts`).
 */
export function stockIntakeSilenceGap(intakeDates: readonly string[], today: string): Gap[] {
  if (intakeDates.length === 0) return [];
  const lastDay = [...intakeDates].sort().at(-1)!;
  const days = daysBetween(lastDay, today) ?? 0;
  if (days <= STOCK_INTAKE_SILENCE_DAYS) return [];
  return [
    {
      topic: "закупки сырья: тишина",
      period: { from: lastDay, to: today },
      missing: `последний приход сырья на склад ${lastDay}, ${days} дней без новой закупки`,
      scale: null,
      action: "внести в mydon-stock/партии свежие закупки сырья, если они были, либо подтвердить, что расход пока идёт по старым остаткам",
    },
  ];
}

/* ── Детектор 22: закупки сырья — у ингредиента их нет вовсе ──────────────── */

/**
 * Факт 13 плана (часть 3): у сахара нет ни одной строки прихода вовсе, хотя
 * его заливают регулярно (позиция 4). Область — ТОЛЬКО ингредиенты, реально
 * заведённые в бункерах (`coffee_bunker_config`): «Стакан+крышка» — тоже
 * `entity type='ingredient'`, но не бункерный, а расходник со своим учётом
 * (`coffee_consumable*`), и требовать у него приход тем же путём дало бы
 * ложный пробел на здоровой системе. Проверено на проде 22.08.2026: из 8
 * бункерных ингредиентов приход есть у 7, нет только у сахара.
 */
export function ingredientsWithoutPurchaseGap(
  bunkerIngredients: readonly { id: string; name: string }[],
  intakeIngredientIds: ReadonlySet<string>,
): Gap[] {
  const missing = bunkerIngredients.filter((i) => !intakeIngredientIds.has(i.id));
  if (missing.length === 0) return [];
  return [
    {
      topic: "закупки сырья: у ингредиента нет ни одной закупки",
      period: null,
      missing: `${missing.length} из ${bunkerIngredients.length} бункерных ингредиентов ни разу не приходовались складом — ${missing.map((m) => m.name).join(", ")}`,
      scale: `${missing.length} ингредиентов`,
      action: "внести приход этого сырья в mydon-stock/партии, если закупки были, либо завести первую партию",
    },
  ];
}

/* ── Детектор 23: заливки — точка без размещения автомата ─────────────────── */

/**
 * Факт 14 плана: на точке заливают бункер, а автомат на ней никогда не
 * размещался (`machine_placement`) — продажи к ней не привязать (мост
 * «автомат → точка», задача 3), норма для неё всегда «нет данных», и разница
 * никогда не станет видимой, сколько бы ни ввели заливок.
 *
 * ЧИСЛА РАЗВЕДКИ УСТАРЕЛИ ЗА ЧАС РАБОТЫ ВЛАДЕЛЬЦА (см. бриф задачи 4: «Детек-
 * тор, который на сегодняшних данных даёт не то число, СЛОМАН»): план фикси-
 * ровал 4 точки на 36 кг (кардиология 1 корпус, Soliq Yashnobod, Parus F1,
 * Parus F4). Проверено на проде 22.08.2026: у Parus F4 уже есть размещение
 * (заведено 05.08.2026) — гэп для неё закрылся сам, как и задуман весь этот
 * реестр. Живых точек без размещения на сегодня — **3**, суммарно **52,3 кг**:
 * Soliq Yashnobod (25 354 г), Parus F1 (23 563 г), кардиология 1 корпус
 * (3 359 г).
 */
export function locationsWithoutMachinePlacementGap(
  refills: readonly { locationId: string; filledWeight: number }[],
  placedLocationIds: ReadonlySet<string>,
  locationNameById: ReadonlyMap<string, string>,
): Gap[] {
  const byLocation = new Map<string, number>();
  for (const r of refills) {
    if (placedLocationIds.has(r.locationId)) continue;
    byLocation.set(r.locationId, (byLocation.get(r.locationId) ?? 0) + r.filledWeight);
  }
  if (byLocation.size === 0) return [];
  const names = [...byLocation.keys()].map((id) => locationNameById.get(id) ?? id);
  const totalG = [...byLocation.values()].reduce((s, v) => s + v, 0);
  const kg = Math.round((totalG / 1000) * 10) / 10;
  return [
    {
      topic: "заливки: точка без размещения автомата",
      period: null,
      missing: `${byLocation.size} точек с заливками бункера, но без единого размещения автомата за всю историю — продажи к ним не привязать, норма всегда «нет данных»: ${names.join(", ")}, суммарно ${kg.toLocaleString("ru-RU")} кг`,
      scale: `${kg.toLocaleString("ru-RU")} кг`,
      action: "завести размещение автомата на этой точке (Панель → машина → точка) — тогда чашки станут видны и сверка нормы заработает",
    },
  ];
}

/* ── Детектор 24: карточка-рецепт без состава ─────────────────────────────── */

/**
 * Найдено при задаче 1 (срез F): `recipe.ts::parseRecipe` на пустом составе
 * тихо отдаёт `[]`, из-за чего `stock.service.ts` пишет «себестоимость 0 сум»
 * вместо «неизвестна», а `entities.service.ts::recipeOf` теряет разницу между
 * «рецепт стоит 0» и «рецепт не задан». Защита `noRecipe` в `stock.service.ts`
 * ловит только «карточка не того вида» (`productKind !== "рецепт"`) — карточку
 * ВИДА «рецепт» с пустым составом она пропускает молча.
 *
 * ПРОВЕРЕНО НА ПРОДЕ 22.08.2026: все 19 карточек вида «рецепт» состав имеют —
 * критерий сегодня **0 строк**. Дефект спит, но проснётся на первой карточке,
 * заведённой без состава (обычное промежуточное состояние ввода), и этот
 * детектор — единственное, что заметит момент пробуждения.
 */
export function recipeCardsWithoutCompositionGap(
  cards: readonly { id: string; name: string; type: string; attrs: Record<string, unknown> | null }[],
): Gap[] {
  const missing = cards.filter((c) => c.type === "product" && productKind(c.attrs) === "рецепт" && parseRecipe(c.attrs).length === 0);
  if (missing.length === 0) return [];
  return [
    {
      topic: "карточка-рецепт без состава",
      period: null,
      missing: `${missing.length} карточек товара с принципом «рецепт», но пустым составом — себестоимость по ним посчитается как «0 сум» вместо «неизвестна»: ${missing.map((m) => m.name).join(", ")}`,
      scale: `${missing.length} карточек`,
      action: "заполнить «состав» на карточке товара (редактор рецепта)",
    },
  ];
}

/* ── Сборка реестра ───────────────────────────────────────────────────────── */

@Injectable()
export class GapsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly collections: CollectionsService,
    private readonly finance: FinanceService,
  ) {}

  /**
   * Реестр пробелов целиком. Пустой массив — хорошая новость (Шаг 2): всё,
   * что можно посчитать, посчитано, отклонений нет, и это ДОЛЖНО выглядеть
   * как пустой список, а не как ошибка или заглушка.
   */
  async list(): Promise<Gap[]> {
    const today = dayKey(new Date(), TZ);

    const [
      collectedAtRows,
      reconcile,
      cash,
      refillRows,
      batchRows,
      purchaseRows,
      ingredientRows,
      moneyFlowRows,
      billReportRows,
      saleCountRows,
      tareRows,
      bunkerConfigRows,
      placementRows,
      intakeRows,
      productCardRows,
      locationRows,
    ] = await Promise.all([
      this.db.select({ collectedAt: collection.collectedAt }).from(collection).where(ne(collection.status, "cancelled")),
      this.collections.reconcile(EPOCH_FROM, today),
      this.finance.cashReconcile(EPOCH_FROM, today),
      this.db
        .select({
          ingredientId: coffeeRefill.ingredientId,
          filledWeight: coffeeRefill.filledWeight,
          enteredDate: coffeeRefill.enteredDate,
          packageCount: coffeeRefill.packageCount,
          position: coffeeRefill.position,
          containerNumber: coffeeRefill.containerNumber,
          locationId: coffeeRefill.locationId,
          measuredBefore: coffeeRefill.measuredBefore,
          createdBy: coffeeRefill.createdBy,
        })
        .from(coffeeRefill),
      this.db
        .select({ receivedOn: stockBatch.receivedOn, expiryDate: stockBatch.expiryDate, manufactureDate: stockBatch.manufactureDate, invoiceDate: stockBatch.invoiceDate })
        .from(stockBatch),
      this.db.select({ dt: purchase.dt }).from(purchase),
      this.db
        .select({
          id: coffeeIngredient.id,
          name: coffeeIngredient.name,
          entityId: coffeeIngredient.entityId,
          purchasePrice: coffeeIngredient.purchasePrice,
          packageWeight: coffeeIngredient.packageWeight,
          cardAttrs: entity.attrs,
        })
        .from(coffeeIngredient)
        .leftJoin(entity, eq(coffeeIngredient.entityId, entity.id)),
      this.db
        .select({
          domain: moneyFlow.domain,
          direction: moneyFlow.direction,
          source: moneyFlow.source,
          amount: moneyFlow.amount,
          currency: moneyFlow.currency,
          amountUzs: moneyFlow.amountUzs,
          status: moneyFlow.status,
        })
        .from(moneyFlow),
      this.db
        .select({ sourceCode: rawReportDef.sourceCode, code: rawReportDef.code, title: rawReportDef.title, ru: rawReportDef.ru })
        .from(rawReportDef)
        .where(eq(rawReportDef.sourceCode, "ourvend")),
      this.db.select({ n: sql<number>`count(*)` }).from(sale),
      this.db.select({ containerNumber: coffeeContainerTare.containerNumber, position: coffeeContainerTare.position, tareWeight: coffeeContainerTare.tareWeight }).from(coffeeContainerTare),
      this.db.select({ position: coffeeBunkerConfig.position, ingredientId: coffeeBunkerConfig.ingredientId, targetFillWeight: coffeeBunkerConfig.targetFillWeight }).from(coffeeBunkerConfig),
      this.db.select({ locationId: machinePlacement.locationId }).from(machinePlacement),
      this.db.select({ ingredientId: stockMovement.ingredientId, dt: stockMovement.dt }).from(stockMovement).where(eq(stockMovement.kind, "intake")),
      this.db.select({ id: entity.id, name: entity.name, type: entity.type, attrs: entity.attrs }).from(entity).where(eq(entity.type, "product")),
      this.db.select({ id: entity.id, name: entity.name }).from(entity).where(eq(entity.type, "location")),
    ]);

    const ingredients = ingredientRows.map((r) => ({ ...r, cardAttrs: (r.cardAttrs ?? null) as Record<string, unknown> | null }));

    const tareByKey = new Map<string, number>();
    for (const t of tareRows) if (t.tareWeight !== null) tareByKey.set(`${t.containerNumber}:${t.position}`, t.tareWeight);

    const configuredPositions = new Set(bunkerConfigRows.map((c) => c.position));
    const usedPositions = [...new Set(refillRows.map((r) => r.position))];

    const bunkerIngredientIds = new Set(bunkerConfigRows.map((c) => c.ingredientId));
    const bunkerIngredients = ingredients
      .filter((i) => bunkerIngredientIds.has(i.id) && i.entityId !== null)
      .map((i) => ({ id: i.entityId as string, name: i.name }));
    const intakeIngredientIds = new Set(intakeRows.map((r) => r.ingredientId));

    const placedLocationIds = new Set(placementRows.map((p) => p.locationId));
    const locationNames = new Map(locationRows.map((l) => [l.id, l.name]));

    const productCards = productCardRows.map((r) => ({ ...r, attrs: (r.attrs ?? null) as Record<string, unknown> | null }));

    return [
      ...collectionSilenceGap(
        collectedAtRows.map((r) => r.collectedAt),
        today,
      ),
      ...bankDepositsWithoutCollectionGaps(cash.periods),
      ...journalHoleGaps(reconcile.intervals),
      ...neverCollectedRevenueGaps(reconcile.rows),
      ...refillsWithoutIngredientGap(refillRows),
      ...batchesWithoutExpiryGap(batchRows),
      ...batchesWithoutInvoiceDateGap(batchRows),
      ...purchasesWithoutDateGap(purchaseRows),
      ...ingredientsWithoutPriceGap(ingredients),
      ...ingredientsWithoutPackageWeightGap(ingredients, refillRows),
      ...snackPaymentChannelGap(Number(saleCountRows[0]?.n ?? 0)),
      ...billReconciliationGap(billReportRows),
      ...bankFlowsWithoutDomainGap(moneyFlowRows),
      ...healthTimezoneGap(appConfig.tz, TZ),
      ...refillMeasuredBeforeMissingGap(refillRows),
      ...bunkerTareNetNonPositiveGap(4, refillRows, tareByKey),
      ...bunkerTareNetNonPositiveGap(3, refillRows, tareByKey),
      ...unconfiguredBunkerPositionGap(usedPositions, configuredPositions),
      ...targetFillWeightMissingGap(bunkerConfigRows),
      ...telegramImportStalledGap(refillRows, today),
      ...stockIntakeSilenceGap(intakeRows.map((r) => r.dt), today),
      ...ingredientsWithoutPurchaseGap(bunkerIngredients, intakeIngredientIds),
      ...locationsWithoutMachinePlacementGap(refillRows, placedLocationIds, locationNames),
      ...recipeCardsWithoutCompositionGap(productCards),
    ];
  }
}
