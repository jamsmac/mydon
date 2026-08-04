/**
 * globerent-monitor — инварианты конвейера GLOBERENT (наследник
 * pipeline-monitor донора PROMACH, по образцу coffee-monitor).
 *
 * Монитор ничего не решает и не чинит сам (T0, чистое наблюдение):
 * читает уже посчитанное Core и эмитит событие на каждое нарушение —
 * дальше сигнал живёт в шине событий и ленте Command Center.
 *
 * Инварианты донора:
 *  • единица в статусе ИМ-74/ИМ-40 без номера ГТД — таможенный документ
 *    обязан быть заполнен, иначе статус поставлен «на глаз»;
 *  • договор действует и оплачен полностью, а не закрыт — оплаченная
 *    сделка обязана двигаться к актам и передаче, не висеть.
 *
 * Частичный сбой одного источника не прячет сигналы другого — оба
 * читаются независимо (правило coffee-monitor).
 */

/** Узкий контракт Core-клиента, который нужен монитору (упрощает тесты). */
export interface GloberentMonitorCoreClient {
  globerentUnits(): Promise<MonitorUnitRow[]>;
  globerentContracts(): Promise<MonitorContractRow[]>;
  recordEvent(input: {
    source: string;
    type: string;
    payload?: Record<string, unknown>;
  }): Promise<unknown>;
}

export interface MonitorUnitRow {
  code: string;
  name: string;
  status: string;
  declarationNumber: string | null;
}

export interface MonitorContractRow {
  id: string;
  contractNo: string;
  status: string;
  totalWithVat: string;
  paidUzs: number;
  /** Провенанс: у карточек из выгрузки Didox заполнен. */
  createdFrom?: string | null;
}

/** Статусы, в которых номер ГТД обязателен (словарь unit-status shared). */
const GTD_REQUIRED: readonly string[] = ["IM74", "IM40"];

export interface GloberentMonitorResult {
  unitsNoGtd: number;
  contractsPaidUnclosed: number;
  /** Что не удалось прочитать — второй источник всё равно проверяется. */
  errors: string[];
}

/** Один проход: по событию на каждое нарушение инварианта. */
export async function runGloberentMonitor(
  core: GloberentMonitorCoreClient,
): Promise<GloberentMonitorResult> {
  const errors: string[] = [];

  let unitsNoGtd = 0;
  try {
    const units = await core.globerentUnits();
    for (const u of units) {
      if (!GTD_REQUIRED.includes(u.status)) continue;
      if (u.declarationNumber !== null && u.declarationNumber.trim() !== "") continue;
      await core.recordEvent({
        source: "globerent-monitor",
        type: "globerent.unit_no_gtd",
        payload: { code: u.code, name: u.name, status: u.status },
      });
      unitsNoGtd += 1;
    }
  } catch (err) {
    errors.push(`единицы: ${errText(err)}`);
  }

  let contractsPaidUnclosed = 0;
  try {
    const contracts = await core.globerentContracts();
    for (const c of contracts) {
      if (c.status !== "active") continue;
      // Историческая карточка из выгрузки: денег по ней в системе нет,
      // «оплачен, но не закрыт» на таких данных не проверяется.
      if ((c.createdFrom ?? "").trim()) continue;
      const total = Number(c.totalWithVat);
      // Сумма договора кривая или нулевая — инвариант не про неё; не выдумываем.
      if (!Number.isFinite(total) || total <= 0) continue;
      if (c.paidUzs < total) continue;
      await core.recordEvent({
        source: "globerent-monitor",
        type: "globerent.contract_paid_unclosed",
        payload: {
          contractId: c.id,
          contractNo: c.contractNo,
          totalWithVat: total,
          paidUzs: c.paidUzs,
        },
      });
      contractsPaidUnclosed += 1;
    }
  } catch (err) {
    errors.push(`договоры: ${errText(err)}`);
  }

  return { unitsNoGtd, contractsPaidUnclosed, errors };
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
