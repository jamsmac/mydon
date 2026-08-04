import { core, CoreUnavailable } from "../lib/core";
import { CoreDown } from "./core-down";
import { CoffeeClient } from "../app/coffee/coffee-client";

function isoDate(d: Date): string {
  return d.toLocaleDateString("en-CA", { timeZone: "Asia/Tashkent" });
}

/**
 * Кофе-бункеры (ручные кофемашины на точках владельца, Ourvend их не видит) —
 * вкладка «Кофе-бункеры» рабочего места VendHub. Модель — «Кофе-вендинг» в
 * schema.ts + coffee.service.ts.
 */
export async function CoffeePanel({ defaultOwnerRef }: { defaultOwnerRef: string | null }) {
  try {
    const to = isoDate(new Date());
    const fromDate = new Date();
    fromDate.setDate(fromDate.getDate() - 30);
    const from = isoDate(fromDate);

    const [
      locations,
      bunkerConfig,
      tareGrid,
      recentRefills,
      summary,
      consumables,
      stockLevels,
      fillStatus,
      reconcile,
      washScheduleStatus,
      washSchedules,
      machineCandidates,
      refillJournal,
      containerReturns,
      placements,
      containerConsumption,
    ] = await Promise.all([
      core.coffeeLocations(),
      core.coffeeBunkerConfig(),
      core.coffeeTareGrid(),
      core.recentCoffeeRefills(30),
      core.coffeeLocationSummary(),
      core.coffeeConsumablesSummary(),
      core.coffeeStockLevels(),
      core.coffeeFillStatus(),
      core.coffeeReconcileAll(from, to),
      core.coffeeWashScheduleStatus(),
      core.coffeeWashSchedules(),
      core.coffeeMachineCandidates(),
      // Журнал: история заливок и возвратов (включая импортированную из Telegram).
      core.recentCoffeeRefills(300),
      core.coffeeContainerReturns(300),
      core.coffeePlacements(),
      core.coffeeContainerConsumption(from, to),
    ]);
    return (
      <CoffeeClient
        locations={locations}
        bunkerConfig={bunkerConfig}
        tareGrid={tareGrid}
        recentRefills={recentRefills}
        summary={summary}
        consumables={consumables}
        stockLevels={stockLevels}
        fillStatus={fillStatus}
        reconcile={reconcile}
        reconcileFrom={from}
        reconcileTo={to}
        washScheduleStatus={washScheduleStatus}
        washSchedules={washSchedules}
        machineCandidates={machineCandidates}
        refillJournal={refillJournal}
        containerReturns={containerReturns}
        placements={placements}
        containerConsumption={containerConsumption}
        defaultOwnerRef={defaultOwnerRef}
      />
    );
  } catch (err) {
    return <CoreDown detail={err instanceof CoreUnavailable ? err.detail : String(err)} />;
  }
}
