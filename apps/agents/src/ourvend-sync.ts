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
  /** Детектор заливок по снимкам (П4, R-P4-2) — дергается сразу после ingestVendingSlots. */
  detectRefillEvents(days?: number): Promise<{
    machines: number;
    events: number;
    matched: number;
    skipped: { serial: string; reason: string }[];
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
/** Окно детектора заливок — `DETECT_DAYS_DEFAULT` Core. Здесь копия числа: у агентов зависимости на core нет. */
const DETECT_DAYS = 2;
/**
 * Потолок текста ошибки прогона: `SyncFinishDto.error` в Core — `@MaxLength(2000)`.
 * Более длинный текст (десять строк OurVend с сообщениями драйвера) уходит в
 * 400, а `finish()` ошибку глотает — и запись сбора остаётся «running» навсегда.
 */
const MAX_ERROR_CHARS = 2000;

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
  /**
   * Итог детектора заливок после успешного приёма слотов. Нет ключа — детектор
   * не запускался (слоты не собирались вовсе). Ошибка детектора никогда не
   * роняет сбор — только помечается "failed" и уходит в лог.
   */
  detect?: { events: number; matched: number } | "failed";
  /**
   * Журнал прогона НЕ закрылся (finishVendingSync упал даже после повтора):
   * текст последнего отказа. Есть ключ → запись сбора осталась в статусе
   * «running» навсегда, а сторож застоя её из фонового успеха не увидит.
   * Данные при этом собраны — сам сбор не проваливаем, но вызыватель обязан
   * отразить это в логе, а НЕ рапортовать чистый успех.
   */
  journalError?: string;
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
    // Обрезка здесь, а не у каждого вызова: путей к `finish` пять, и забытый
    // на одном из них длинный текст стоит открытой навсегда записи сбора
    // (см. `MAX_ERROR_CHARS`).
    const full: SyncResult = {
      ...result,
      durationMs,
      ...(result.error ? { error: result.error.slice(0, MAX_ERROR_CHARS) } : {}),
    };
    const finishInput = {
      status: full.status,
      machinesTotal: full.machinesTotal,
      machinesOk: full.machinesOk,
      durationMs,
      ...(full.error ? { error: full.error } : {}),
    };
    try {
      await core.finishVendingSync(id, finishInput);
    } catch {
      // Первая попытка закрыть журнал не прошла — короткий повтор. Сеть/Core
      // мигнули → второй заход обычно проходит, и запись не зависает «running».
      try {
        await core.finishVendingSync(id, finishInput);
      } catch (err2) {
        // Журнал не закрылся дважды: запись сбора остаётся «running» НАВСЕГДА,
        // а сторож застоя её из фонового «успеха» не увидит. Данные уже собраны
        // — сам сбор не роняем, но делаем застревание ВИДИМЫМ: error-лог с id
        // прогона и текстом отказа + флаг наверх, чтобы cron не рапортовал
        // чистый успех (см. `SyncResult.journalError` и вызыватель в index.ts).
        const journalError = errText(err2);
        console.error(
          `[ourvend:sync] журнал прогона ${id} НЕ закрыт (останется «running»): ${journalError}`,
        );
        return { ...full, journalError };
      }
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
  let detect: SyncResult["detect"];
  const skippedNotes: string[] = [];
  if (collected.length > 0) {
    // Длительность приёма — в лог отдельной строкой И в текст отказа.
    // 24.08.2026 сбор падал «This operation was aborted», и по журналу нельзя
    // было отличить «Core не ответил» от «Core отвечал дольше таймаута»: числа,
    // сколько шёл приём, не было ни одной. Замер живёт ВНЕ try — иначе он
    // остался бы виден только на удачном исходе, то есть ровно там, где
    // и без него всё понятно.
    const t0Слоты = Date.now();
    try {
      const res = await core.ingestVendingSlots({ capturedAt, machines: collected });
      console.log(
        `[ourvend:sync] приём слотов ${Date.now() - t0Слоты} мс — автоматов ${collected.length}, слотов ${res.slots}`,
      );
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
      // Приём не удался — весь собранный проход считаем провалом. Время в
      // тексте отказа: `vending_sync_run.error` читают из панели, и «оборвался
      // на 10 001-й миллисекунде» — это другой диагноз, чем «Core ответил 500».
      const мс = Date.now() - t0Слоты;
      return finish({
        status: "failed",
        machinesTotal: machines.length,
        machinesOk: 0,
        slots: 0,
        productSales: 0,
        error: `приём слотов (${мс} мс): ${errText(err)}`,
      });
    }

    // Детектор заливок (П4, R-P4-2): гонится сразу после того, как свежий
    // снимок слотов лёг в базу — заливка отражается в журнале в тот же цикл
    // сбора, а не только когда её вручную прогонят из панели. Сбой детектора
    // не отказ сбора (снимок уже записан) — только лог и пометка в итоге.
    const t0Детектор = Date.now();
    try {
      // Окно — `DETECT_DAYS_DEFAULT` Core (2 суток), а не одни. Детектор
      // идемпотентен по (автомат, конец окна), так что перекрытие не плодит
      // строк, зато после простоя сбора длиннее суток (24.08 было девять
      // `failed` подряд) заливки из провала подберутся сами, а не ручным POST.
      const d = await core.detectRefillEvents(DETECT_DAYS);
      console.log(`[ourvend:sync] детектор заливок ${Date.now() - t0Детектор} мс — заливок ${d.events}`);
      detect = { events: d.events, matched: d.matched };
    } catch (err) {
      console.warn(`[ourvend:sync] детектор заливок не отработал за ${Date.now() - t0Детектор} мс: ${errText(err)}`);
      detect = "failed";
    }
  }

  // Продажи за окно (§5.6) — второстепенный артефакт: собираем «как получится»
  // по успешно снятым автоматам. Полный провал продаж (ничего не дошло до
  // Core) честно опускает статус до partial — планограмма при этом цела;
  // частичный сбой продаж статус не меняет, лишь дописывается в текст ошибки.
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
      const t0Продажи = Date.now();
      try {
        const res = await core.ingestVendingSales({
          capturedAt,
          periodStart: from.toISOString(),
          periodEnd: capturedAt,
          productSales,
          machineSales,
        });
        console.log(
          `[ourvend:sync] приём продаж ${Date.now() - t0Продажи} мс — строк по товарам ${res.productRows}, по автоматам ${res.machineRows}`,
        );
        productSalesRows = res.productRows;
      } catch (err) {
        saleErrors.push(`приём продаж (${Date.now() - t0Продажи} мс): ${errText(err)}`);
      }
    }
  }

  const machinesOk = collected.length;
  // Продажи «упали» целиком — были ошибки, и ни строки не дошло до Core
  // (частичный сбой, где что-то всё же собралось, статус не трогает —
  // он остаётся тем же, что дают одни слоты).
  const salesFailed = saleErrors.length > 0 && productSalesRows === 0;

  let status: SyncResult["status"];
  let error: string | undefined;
  if (machines.length === 0 || machinesOk === 0) {
    // НОЛЬ АВТОМАТОВ — ЭТО ОТКАЗ, А НЕ УСПЕХ. Логин и список прошли, список
    // приехал ПУСТЫМ (сменилась группа, у учётки отобрали права, кабинет отдал
    // пустой ответ) — и `failures.length === 0` давало `success`: журнал сбора
    // зелен, `failedStreak` обнулён, сторож застоя молчит навсегда. При этом не
    // собрано НИЧЕГО. Тот же приговор и когда список непустой, а собрать не
    // удалось ни один автомат: «успех без данных» — состояние, которого у
    // прогона сбора быть не может.
    status = "failed";
    const причина =
      machines.length === 0
        ? "кабинет вернул пустой список автоматов — собирать было нечего"
        : `ни одного автомата из ${machines.length} не собрано`;
    error = [
      причина,
      ...(failures.length ? [`Автоматы без слотов: ${failures.slice(0, 10).join("; ")}`] : []),
      ...(skippedNotes.length ? [skippedNotes.slice(0, 10).join("; ")] : []),
      ...(saleErrors.length ? [saleErrors.slice(0, 10).join("; ")] : []),
    ].join(" | ");
  } else if (slots === 0) {
    // СНЯТО — ЕЩЁ НЕ ПРИНЯТО. `machinesOk` меряет съём коннектором, а не
    // судьбу данных в Core: когда приём пропустил ВСЕ собранные автоматы
    // (поехал формат вендора — у каждого «слишком много слотов») или каждый
    // отдал пустой список слотов, `failures` пусты и прогон закрывался
    // зелёным, хотя планограмма не обновилась ни строкой. Тот же «успех без
    // данных», что и в ветви выше, — и приговор тот же: failed, streak растёт,
    // сторож застоя видит. `collected.length > 0` здесь гарантировано ветвью
    // выше, значит приём звался и вернул ноль принятых слотов.
    status = "failed";
    error = [
      `приём не принял ни одного слота с ${machinesOk} собранных автоматов — планограмма не обновлена`,
      ...(skippedNotes.length ? [skippedNotes.slice(0, 10).join("; ")] : []),
      ...(failures.length ? [`Автоматы без слотов: ${failures.slice(0, 10).join("; ")}`] : []),
      ...(saleErrors.length ? [saleErrors.slice(0, 10).join("; ")] : []),
    ].join(" | ");
  } else if (failures.length === 0 && salesFailed) {
    // Слоты собраны без потерь, а продажи не дошли ни строкой — статус
    // больше не врёт «success»: владелец должен видеть, что окно продаж
    // не обновилось, а не догадываться об этом по пустому графику.
    //
    // ПРИЧИНА ПАДЕНИЯ СТАТУСА — ПЕРВОЙ. Заметки о пропущенных автоматах
    // побочные, и, стоя впереди, они прятали «продажи: » в середину строки:
    // читающий видел статус `partial` и объяснение не про то.
    status = "partial";
    error = [`продажи: ${saleErrors.slice(0, 10).join("; ")}`, ...skippedNotes.slice(0, 10)].join(" · ");
  } else {
    // `machinesOk > 0` здесь уже гарантировано ветвью выше, поэтому прежняя
    // третья развилка (`machinesOk > 0 ? "partial" : "failed"`) стала мёртвой:
    // «ни одного собранного» до этой строки не доходит.
    status = failures.length === 0 ? "success" : "partial";
    const errParts = [
      ...(failures.length ? [`Автоматы без слотов: ${failures.slice(0, 10).join("; ")}`] : []),
      ...(skippedNotes.length ? [skippedNotes.slice(0, 10).join("; ")] : []),
      ...(saleErrors.length ? [saleErrors.slice(0, 10).join("; ")] : []),
    ];
    error = errParts.length ? errParts.join(" | ") : undefined;
  }
  return finish({
    status,
    machinesTotal: machines.length,
    machinesOk,
    slots,
    productSales: productSalesRows,
    ...(error ? { error } : {}),
    ...(detect !== undefined ? { detect } : {}),
  });
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
