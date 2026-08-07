import { OurvendConnector, sumProductSales, type RawSlot, type VendingConnector } from "@mydon/connectors";

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
  }): Promise<{
    machines: number;
    slots: number;
    /** Пропущенные приёмом автоматы. Поле молодое — старый Core его не шлёт. */
    skipped?: { serial: string; slots: number; reason: string }[];
    /** Автоматы, у которых не удалась уборка зеркала. Снимок при этом записан. */
    pruneErrors?: { serial: string; error: string }[];
  }>;
  ingestVendingSales(payload: {
    capturedAt?: string;
    periodStart: string;
    periodEnd: string;
    productSales: { serial: string; product: string; quantity: number }[];
    machineSales: { serial: string; totalAmount: number; totalCount: number }[];
  }): Promise<{ productRows: number; machineRows: number }>;
  finishVendingSync(
    id: string,
    input: { status: "success" | "partial" | "failed"; machinesTotal: number; machinesOk: number; durationMs: number; error?: string },
  ): Promise<{ ok: boolean }>;
}

/** Окно сбора продаж, суток (по умолчанию 7 — под §5.6). */
const SALES_WINDOW_DAYS = 7;

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
  /** Сколько строк продаж по товарам собрано (0, если продажи не собирались). */
  productSales: number;
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
  // `||`, а не `??`: docker compose подставляет ПУСТУЮ СТРОКУ для незаданной
  // переменной (`${OURVEND_GROUP_ID:-}`), а `??` считает её заданным значением
  // и дефолт бы не применился. Раньше переменной в compose не было вовсе, и
  // в контейнер она приходила undefined — разница проявилась ровно в тот
  // момент, когда её туда добавили.
  const groupId = (env.OURVEND_GROUP_ID || "729db8bd-02f5-49b9-bccb-53477e396a08").trim();
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
    return finish({ status: "failed", machinesTotal: 0, machinesOk: 0, slots: 0, productSales: 0, error: errText(err) });
  }

  const nowDate = now();
  const capturedAt = nowDate.toISOString();
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
  const skippedNotes: string[] = [];
  if (collected.length > 0) {
    try {
      const res = await core.ingestVendingSlots({ capturedAt, machines: collected });
      slots = res.slots;
      // Автомат, пропущенный приёмом (например, неправдоподобное число
      // слотов), — не отказ сбора, но и не пустяк: его планограмма осталась
      // вчерашней. Дописываем в итог прогона, чтобы пропажа была видна.
      for (const s of res.skipped ?? []) {
        skippedNotes.push(`автомат ${s.serial} пропущен (${s.reason}, слотов ${s.slots})`);
      }
      // Уборка зеркала не удалась — снимок записан, но лишние слоты остались.
      // Не отказ сбора, но и не пустяк: планограмма показывает больше, чем есть.
      for (const e of res.pruneErrors ?? []) {
        skippedNotes.push(`уборка зеркала ${e.serial} не удалась: ${e.error}`);
      }
    } catch (err) {
      // Приём не удался — весь собранный проход считаем провалом.
      return finish({ status: "failed", machinesTotal: machines.length, machinesOk: 0, slots: 0, productSales: 0, error: errText(err) });
    }
  }

  // Продажи за окно (§5.6) — второстепенный артефакт: собираем «как получится»
  // по успешно снятым автоматам. Сбой продаж НЕ меняет статус (он про
  // планограмму) — лишь дописывается в текст ошибки.
  const saleErrors: string[] = [];
  let productSalesRows = 0;
  const collectedSerials = collected.map((c) => c.serial);
  if (collectedSerials.length > 0) {
    const from = new Date(nowDate.getTime() - SALES_WINDOW_DAYS * 86_400_000);
    const productSales: { serial: string; product: string; quantity: number }[] = [];
    for (const serial of collectedSerials) {
      try {
        const raw = await connector.getProductSales(serial, from, nowDate);
        for (const [product, quantity] of sumProductSales(raw)) productSales.push({ serial, product, quantity });
      } catch (err) {
        saleErrors.push(`продажи ${serial}: ${errText(err)}`);
      }
    }
    let machineSales: { serial: string; totalAmount: number; totalCount: number }[] = [];
    try {
      const raw = await connector.getMachineSales(config.groupId, from, nowDate);
      machineSales = raw.map((r) => ({ serial: r.serial, totalAmount: r.totalAmount, totalCount: r.totalCount }));
    } catch (err) {
      saleErrors.push(`продажи автоматов: ${errText(err)}`);
    }
    if (productSales.length > 0 || machineSales.length > 0) {
      try {
        const res = await core.ingestVendingSales({
          capturedAt,
          periodStart: from.toISOString(),
          periodEnd: capturedAt,
          productSales,
          machineSales,
        });
        productSalesRows = res.productRows;
      } catch (err) {
        saleErrors.push(`приём продаж: ${errText(err)}`);
      }
    }
  }

  const machinesOk = collected.length;
  const status: SyncResult["status"] =
    failures.length === 0 ? "success" : machinesOk > 0 ? "partial" : "failed";
  const errParts = [
    ...(failures.length ? [`Автоматы без слотов: ${failures.slice(0, 10).join("; ")}`] : []),
    ...(skippedNotes.length ? [skippedNotes.slice(0, 10).join("; ")] : []),
    ...(saleErrors.length ? [saleErrors.slice(0, 10).join("; ")] : []),
  ];
  const error = errParts.length ? errParts.join(" | ") : undefined;
  return finish({ status, machinesTotal: machines.length, machinesOk, slots, productSales: productSalesRows, ...(error ? { error } : {}) });
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
