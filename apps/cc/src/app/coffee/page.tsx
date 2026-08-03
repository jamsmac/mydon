import { core, CoreUnavailable } from "../../lib/core";
import { CoreDown } from "../../components/core-down";
import { CoffeeClient } from "./coffee-client";

export const dynamic = "force-dynamic";

function isoDate(d: Date): string {
  return d.toLocaleDateString("en-CA", { timeZone: "Asia/Tashkent" });
}

/**
 * Кофе-бункеры (ручные кофемашины на точках владельца, Ourvend их не видит).
 * Модель — «Кофе-вендинг» в schema.ts + coffee.service.ts.
 */
export default async function CoffeePage() {
  try {
    const to = isoDate(new Date());
    const fromDate = new Date();
    fromDate.setDate(fromDate.getDate() - 30);
    const from = isoDate(fromDate);

    const [locations, bunkerConfig, tareGrid, recentRefills, summary, consumables, stockLevels, fillStatus, reconcile] =
      await Promise.all([
        core.coffeeLocations(),
        core.coffeeBunkerConfig(),
        core.coffeeTareGrid(),
        core.recentCoffeeRefills(30),
        core.coffeeLocationSummary(),
        core.coffeeConsumablesSummary(),
        core.coffeeStockLevels(),
        core.coffeeFillStatus(),
        core.coffeeReconcileAll(from, to),
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
      />
    );
  } catch (err) {
    return <CoreDown detail={err instanceof CoreUnavailable ? err.detail : String(err)} />;
  }
}
