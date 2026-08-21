import { Inject, Injectable } from "@nestjs/common";
import {
  coffeeIngredient,
  coffeeRefill,
  collection,
  entity,
  moneyFlow,
  purchase,
  rawReportDef,
  sale,
  stockBatch,
} from "@mydon/db";
import { resolveIngredientPrice, strictNumber, TZ } from "@mydon/shared";
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
    .map((iv): RawJournalHole => ({ machineId: iv.machineId, from: iv.с.slice(0, 10), to: iv.по.slice(0, 10), expected: iv.ожидалось, collected: iv.изъято }));
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
 */
export function bankFlowsWithoutDomainGap(
  flows: readonly { domain: string | null; amount: string; currency: string; amountUzs: string | null; status: string }[],
): Gap[] {
  const unassigned = flows.filter((f) => f.domain === null && f.status !== "cancelled");
  if (unassigned.length === 0) return [];
  let sumUzs = 0;
  let unconverted = 0;
  for (const f of unassigned) {
    const amount = Number(f.amount);
    if (!Number.isFinite(amount)) continue;
    if (f.currency === "UZS") {
      sumUzs += amount;
      continue;
    }
    const amountUzs = f.amountUzs != null ? Number(f.amountUzs) : null;
    if (amountUzs !== null && Number.isFinite(amountUzs)) {
      sumUzs += amountUzs;
      continue;
    }
    unconverted += 1;
  }
  const note = unconverted > 0 ? ` (ещё ${unconverted} записей без курса, в сумму не вошли)` : "";
  return [
    {
      topic: "банковские записи без направления",
      period: null,
      missing: `${unassigned.length} записей банковской выписки на ${formatSum(sumUzs)} не привязаны ни к одному направлению — счёт общий, наличные итоги по направлению их не видят${note}`,
      scale: formatSum(sumUzs),
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

    const [collectedAtRows, reconcile, cash, refillRows, batchRows, purchaseRows, ingredientRows, moneyFlowRows, billReportRows, saleCountRows] =
      await Promise.all([
        this.db.select({ collectedAt: collection.collectedAt }).from(collection).where(ne(collection.status, "cancelled")),
        this.collections.reconcile(EPOCH_FROM, today),
        this.finance.cashReconcile(EPOCH_FROM, today),
        this.db
          .select({ ingredientId: coffeeRefill.ingredientId, filledWeight: coffeeRefill.filledWeight, enteredDate: coffeeRefill.enteredDate, packageCount: coffeeRefill.packageCount })
          .from(coffeeRefill),
        this.db
          .select({ receivedOn: stockBatch.receivedOn, expiryDate: stockBatch.expiryDate, manufactureDate: stockBatch.manufactureDate, invoiceDate: stockBatch.invoiceDate })
          .from(stockBatch),
        this.db.select({ dt: purchase.dt }).from(purchase),
        this.db
          .select({ id: coffeeIngredient.id, name: coffeeIngredient.name, purchasePrice: coffeeIngredient.purchasePrice, packageWeight: coffeeIngredient.packageWeight, cardAttrs: entity.attrs })
          .from(coffeeIngredient)
          .leftJoin(entity, eq(coffeeIngredient.entityId, entity.id)),
        this.db.select({ domain: moneyFlow.domain, amount: moneyFlow.amount, currency: moneyFlow.currency, amountUzs: moneyFlow.amountUzs, status: moneyFlow.status }).from(moneyFlow),
        this.db
          .select({ sourceCode: rawReportDef.sourceCode, code: rawReportDef.code, title: rawReportDef.title, ru: rawReportDef.ru })
          .from(rawReportDef)
          .where(eq(rawReportDef.sourceCode, "ourvend")),
        this.db.select({ n: sql<number>`count(*)` }).from(sale),
      ]);

    const ingredients = ingredientRows.map((r) => ({ ...r, cardAttrs: (r.cardAttrs ?? null) as Record<string, unknown> | null }));

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
    ];
  }
}
