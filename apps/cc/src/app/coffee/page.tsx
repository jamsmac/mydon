import { core, CoreUnavailable } from "../../lib/core";
import { CoreDown } from "../../components/core-down";
import { CoffeeClient } from "./coffee-client";

export const dynamic = "force-dynamic";

/**
 * Кофе-бункеры (ручные кофемашины на точках владельца, Ourvend их не видит).
 * Модель — «Кофе-вендинг» в schema.ts + coffee.service.ts.
 */
export default async function CoffeePage() {
  try {
    const [locations, bunkerConfig, tareGrid, recentRefills, summary, consumables, stockLevels] = await Promise.all([
      core.coffeeLocations(),
      core.coffeeBunkerConfig(),
      core.coffeeTareGrid(),
      core.recentCoffeeRefills(30),
      core.coffeeLocationSummary(),
      core.coffeeConsumablesSummary(),
      core.coffeeStockLevels(),
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
      />
    );
  } catch (err) {
    return <CoreDown detail={err instanceof CoreUnavailable ? err.detail : String(err)} />;
  }
}
