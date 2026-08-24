import {
  dedupLotAgg,
  OurvendConnector,
  ourvendDate,
  type AccountingSaleRow,
  type RawLotRow,
} from "@mydon/connectors";
import type { OurvendSyncConfig } from "./ourvend-sync";

/**
 * ourvend:accounting — СОБСТВЕННЫЙ учётный съём кабинета OurVend
 * (П2 плана поглощения mydon-stock, docs/PLAN_STOCK_ABSORPTION.md).
 *
 * Перенос боевой логики донора app/ourvend.py:
 *  • суточный снапшот продаж по автоматам и дням с догоном пропусков до 14
 *    дней (день перезаписывается целиком на стороне Core);
 *  • утренний снимок остатков слотов из Lot management с НОД-дедупом
 *    повторяющихся строк;
 *  • одна машина не роняет съём остальных — итог partial.
 *
 * Пишет в Core (POST /ourvend/snapshot) — в теневые таблицы. Пока
 * OURVEND_ACCOUNTING_SOURCE=stock, эти данные участвуют только в паритете
 * (GET /ourvend/parity); переключение — после 7 зелёных дней.
 */

/** Узкий контракт Core-клиента (упрощает тесты). */
export interface AccountingCoreClient {
  ourvendSnapshotStatus(): Promise<{
    lastSaleDt: string | null;
    lastStockDt: string | null;
    perMachineSale: { machineSerial: string; last: string }[];
  }>;
  pushOurvendSnapshot(payload: {
    sales?: { dt: string; machineSerial: string; rows: { product: string; qty: number; amount: number }[] }[];
    stock?: { dt: string; machineSerial: string; rows: { product: string; qty: number }[] }[];
  }): Promise<{ saleDays: number; saleRows: number; stockDays: number; stockRows: number; quarantined: number }>;
}

/** Что коллектору нужно от коннектора (для тестов — фейк). */
export interface AccountingConnector {
  login(): Promise<void>;
  listMachines(groupId: string): Promise<{ serial: string; alias: string }[]>;
  getAccountingSales(machineApiId: string, from: Date, to: Date): Promise<AccountingSaleRow[]>;
  openStockSession(): Promise<void>;
  getLotRows(machineApiId: string): Promise<RawLotRow[]>;
}

/** Максимум дней догона за один прогон (правило донора). */
export const CATCHUP_DAYS = 14;

/** YYYY-MM-DD ± n дней (строки дат — ташкентские сутки). */
export function addDays(dt: string, n: number): string {
  const d = new Date(`${dt}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * Окно съёма продаж: от дня после последнего снятого до вчера, не глубже
 * CATCHUP_DAYS. Снапшот уже дотянулся до вчера → пересъём одного вчера
 * (поздние продажи дообновляются, перезапись дня идемпотентна).
 * exported для тестов.
 */
export function salesWindow(lastSaleDt: string | null, yesterday: string): { from: string; to: string } {
  const floor = addDays(yesterday, -(CATCHUP_DAYS - 1));
  let from = lastSaleDt ? addDays(lastSaleDt, 1) : floor;
  if (from < floor) from = floor;
  if (from > yesterday) from = yesterday;
  return { from, to: yesterday };
}

/** Список дат окна включительно. */
export function windowDays(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

export interface AccountingResult {
  status: "success" | "partial" | "failed";
  machinesTotal: number;
  machinesOk: number;
  saleDays: number;
  saleRows: number;
  stockRows: number;
  durationMs: number;
  error?: string;
}

export interface AccountingRunOptions {
  connector?: AccountingConnector;
  now?: () => Date;
}

const CHUNK_DAY_ENTRIES = 20;

export async function runOurvendAccounting(
  core: AccountingCoreClient,
  config: OurvendSyncConfig,
  opts: AccountingRunOptions = {},
): Promise<AccountingResult> {
  const now = opts.now ?? (() => new Date());
  const startedMs = now().getTime();
  const connector =
    opts.connector ?? new OurvendConnector({ account: config.account, password: config.password });
  const done = (r: Omit<AccountingResult, "durationMs">): AccountingResult => ({
    ...r,
    durationMs: now().getTime() - startedMs,
  });

  let machines: { serial: string; alias: string }[];
  const watermarks = new Map<string, string>();
  try {
    const status = await core.ourvendSnapshotStatus();
    // Вотермарки ПОМАШИННЫЕ: сбой одной машины не двигает её окно догона
    // вслед за здоровыми — следующий прогон дотянет именно её дни.
    for (const p of status.perMachineSale) watermarks.set(p.machineSerial, p.last);
    await connector.login();
    machines = await connector.listMachines(config.groupId);
  } catch (err) {
    return done({
      status: "failed",
      machinesTotal: 0,
      machinesOk: 0,
      saleDays: 0,
      saleRows: 0,
      stockRows: 0,
      error: errText(err),
    });
  }

  const today = ourvendDate(now());
  const yesterday = addDays(today, -1);
  const toDate = (s: string) => new Date(`${s}T12:00:00+05:00`);

  const failures: string[] = [];
  const saleEntries: { dt: string; machineSerial: string; rows: { product: string; qty: number; amount: number }[] }[] = [];
  const salesOkSerials = new Set<string>();
  for (const m of machines) {
    // В таблице снапшота серийник хранится каноном (нижний регистр, без «c»).
    const lastDt = watermarks.get(m.serial.trim().toLowerCase()) ?? null;
    const { from, to } = salesWindow(lastDt, yesterday);
    const days = windowDays(from, to);
    try {
      // Проба за весь период: к дням ходим только там, где продажи были вообще.
      const probe = await connector.getAccountingSales(m.serial, toDate(from), toDate(to));
      salesOkSerials.add(m.serial);
      if (probe.length === 0) continue;
      if (days.length === 1) {
        saleEntries.push({ dt: from, machineSerial: m.serial, rows: probe });
        continue;
      }
      for (const d of days) {
        const rows = await connector.getAccountingSales(m.serial, toDate(d), toDate(d));
        // Пустой день тоже отправляется: перезапись дня стирает исчезнувшие
        // у вендора строки — иначе они зависли бы навсегда.
        saleEntries.push({ dt: d, machineSerial: m.serial, rows });
      }
    } catch (err) {
      failures.push(`продажи ${m.serial}: ${errText(err)}`);
    }
  }

  const stockEntries: { dt: string; machineSerial: string; rows: { product: string; qty: number }[] }[] = [];
  const stockOkSerials = new Set<string>();
  try {
    await connector.openStockSession();
    for (const m of machines) {
      try {
        const agg = dedupLotAgg(await connector.getLotRows(m.serial));
        stockOkSerials.add(m.serial);
        stockEntries.push({
          dt: today,
          machineSerial: m.serial,
          rows: [...agg.entries()].map(([product, qty]) => ({ product, qty })),
        });
      } catch (err) {
        failures.push(`остатки ${m.serial}: ${errText(err)}`);
      }
    }
  } catch (err) {
    failures.push(`Lot-сессия: ${errText(err)}`);
  }

  let saleRows = 0;
  let stockRows = 0;
  let saleDays = 0;
  try {
    for (let i = 0; i < saleEntries.length; i += CHUNK_DAY_ENTRIES) {
      const res = await core.pushOurvendSnapshot({ sales: saleEntries.slice(i, i + CHUNK_DAY_ENTRIES) });
      saleRows += res.saleRows;
      saleDays += res.saleDays;
    }
    for (let i = 0; i < stockEntries.length; i += CHUNK_DAY_ENTRIES) {
      const res = await core.pushOurvendSnapshot({ stock: stockEntries.slice(i, i + CHUNK_DAY_ENTRIES) });
      stockRows += res.stockRows;
    }
  } catch (err) {
    // Приём не удался — данные не сохранены, честный провал всего прогона.
    return done({
      status: "failed",
      machinesTotal: machines.length,
      machinesOk: 0,
      saleDays,
      saleRows,
      stockRows,
      error: `приём снапшота: ${errText(err)}`,
    });
  }

  const machinesOk = machines.filter((m) => salesOkSerials.has(m.serial) && stockOkSerials.has(m.serial)).length;
  // partial, если собралась ХОТЬ КАКАЯ-ТО фаза: упавшая Lot-сессия не должна
  // объявлять провалом успешно снятые и доставленные продажи.
  const anyOk = salesOkSerials.size > 0 || stockOkSerials.size > 0;
  const status: AccountingResult["status"] =
    failures.length === 0 ? "success" : anyOk ? "partial" : "failed";
  const error = failures.length ? failures.slice(0, 10).join("; ") : undefined;
  return done({
    status,
    machinesTotal: machines.length,
    machinesOk,
    saleDays,
    saleRows,
    stockRows,
    ...(error ? { error } : {}),
  });
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
