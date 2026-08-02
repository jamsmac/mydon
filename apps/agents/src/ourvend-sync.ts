import { OurvendConnector, type RawSlot, type VendingConnector } from "@mydon/connectors";

/**
 * ourvend:sync — коллектор вендинга (ТЗ Фаза 1, планировщик сбора).
 *
 * Дергает коннектор Ourvend (логин → список автоматов → слоты каждого) и кладёт
 * планограмму в Core через `POST /vending/ingest`, а факт запуска — в журнал
 * `vending_sync_run` (start/finish). Так экран «Автоматы и дефицит» оживает
 * реальными данными, а «когда собирали и удачно ли» видно из панели.
 *
 * Устойчивость к частичным сбоям: если слоты одного автомата не пришли, сбор
 * НЕ падает целиком — остальные автоматы всё равно попадают в базу, а итог
 * помечается `partial`. Полный провал (логин/список) → `failed`.
 *
 * Продажи (productSale/machineSale) здесь пока не собираются — они нужны для
 * прогноза расхода (Фаза 2), не для дефицита; добавятся отдельным проходом.
 *
 * Секреты (учётка/пароль) — только из окружения, никогда из кода или базы
 * (правило ТЗ; пароль Ourvend считается скомпрометированным до смены — Фаза 0).
 */

/** Узкий контракт Core-клиента, который нужен коллектору (упрощает тесты). */
export interface SyncCoreClient {
  startVendingSync(): Promise<{ id: string }>;
  ingestVendingSlots(payload: {
    capturedAt?: string;
    machines: { serial: string; alias?: string; slots: { coilId: string; product: string; capacity: number; quantity: number }[] }[];
  }): Promise<{ machines: number; slots: number }>;
  finishVendingSync(
    id: string,
    input: { status: "success" | "partial" | "failed"; machinesTotal: number; machinesOk: number; durationMs: number; error?: string },
  ): Promise<{ ok: boolean }>;
}

export interface OurvendSyncConfig {
  account: string;
  password: string;
  /** MachineGroup GUID (OURVEND_GROUP_ID). */
  groupId: string;
}

export interface SyncResult {
  status: "success" | "partial" | "failed";
  machinesTotal: number;
  machinesOk: number;
  slots: number;
  durationMs: number;
  error?: string;
}

export interface RunOptions {
  /** Готовый коннектор (для тестов); по умолчанию — боевой OurvendConnector. */
  connector?: VendingConnector;
  /** Источник времени (для тестов). */
  now?: () => Date;
}

/**
 * Конфиг сбора из окружения. Нет учётки или пароля → null: сбор выключен
 * (панель покажет пустой экран с подсказкой задать OURVEND_*). Группа по
 * умолчанию — из ТЗ Приложение (можно переопределить OURVEND_GROUP_ID).
 */
export function ourvendConfigFromEnv(env: NodeJS.ProcessEnv = process.env): OurvendSyncConfig | null {
  const account = (env.OURVEND_ACCOUNT ?? "").trim();
  const password = env.OURVEND_PASSWORD ?? "";
  if (!account || !password) return null;
  const groupId = (env.OURVEND_GROUP_ID ?? "729db8bd-02f5-49b9-bccb-53477e396a08").trim();
  return { account, password, groupId };
}

/** Сырые слоты вендора → форма приёма Core (пустое имя товара оставляем как есть — Core сам решит). */
function toIngestSlots(slots: RawSlot[]): { coilId: string; product: string; capacity: number; quantity: number }[] {
  return slots.map((s) => ({ coilId: s.coilId, product: s.product, capacity: s.capacity, quantity: s.quantity }));
}

/**
 * Один цикл сбора. Открывает запись сбора в Core, собирает слоты, кладёт их
 * и закрывает запись итогом. Никогда не бросает по «ожидаемым» причинам —
 * возвращает итог (в т.ч. failed), чтобы cron не падал.
 */
export async function runOurvendSync(core: SyncCoreClient, config: OurvendSyncConfig, opts: RunOptions = {}): Promise<SyncResult> {
  const now = opts.now ?? (() => new Date());
  const startedAtMs = now().getTime();
  const connector = opts.connector ?? new OurvendConnector({ account: config.account, password: config.password });

  const { id } = await core.startVendingSync();

  const finish = async (result: Omit<SyncResult, "durationMs">): Promise<SyncResult> => {
    const durationMs = now().getTime() - startedAtMs;
    const full: SyncResult = { ...result, durationMs };
    try {
      await core.finishVendingSync(id, {
        status: full.status,
        machinesTotal: full.machinesTotal,
        machinesOk: full.machinesOk,
        durationMs,
        ...(full.error ? { error: full.error } : {}),
      });
    } catch {
      // Не удалось закрыть журнал — не роняем сбор; запись останется «running».
    }
    return full;
  };

  let machines: { serial: string; alias: string }[];
  try {
    await connector.login();
    machines = await connector.listMachines(config.groupId);
  } catch (err) {
    return finish({ status: "failed", machinesTotal: 0, machinesOk: 0, slots: 0, error: errText(err) });
  }

  const capturedAt = now().toISOString();
  const collected: { serial: string; alias?: string; slots: { coilId: string; product: string; capacity: number; quantity: number }[] }[] = [];
  const failures: string[] = [];
  for (const m of machines) {
    try {
      const slots = await connector.getSlots(m.serial);
      collected.push({ serial: m.serial, alias: m.alias, slots: toIngestSlots(slots) });
    } catch (err) {
      failures.push(`${m.serial}: ${errText(err)}`);
    }
  }

  let slots = 0;
  if (collected.length > 0) {
    try {
      const res = await core.ingestVendingSlots({ capturedAt, machines: collected });
      slots = res.slots;
    } catch (err) {
      // Приём не удался — весь собранный проход считаем провалом.
      return finish({ status: "failed", machinesTotal: machines.length, machinesOk: 0, slots: 0, error: errText(err) });
    }
  }

  const machinesOk = collected.length;
  const status: SyncResult["status"] =
    failures.length === 0 ? "success" : machinesOk > 0 ? "partial" : "failed";
  const error = failures.length ? `Автоматы без слотов: ${failures.slice(0, 10).join("; ")}` : undefined;
  return finish({ status, machinesTotal: machines.length, machinesOk, slots, ...(error ? { error } : {}) });
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
