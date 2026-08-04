import "server-only";
import type { AssistantCore } from "@mydon/assistant";
import { core } from "./core";

/**
 * Адаптер: приводит клиента панели к тому, что нужно помощнику.
 * Один «мозг» (@mydon/assistant) — два сурфейса (бот и панель).
 */
export const assistantCore: AssistantCore = {
  briefing: () => core.briefing(),
  pendingApprovals: () =>
    core.pendingApprovals().then((list) =>
      list.map((a) => ({ id: a.id, agent: a.agent, action: a.action, tier: a.tier })),
    ),
  obligations: (domain) =>
    core.obligations(domain).then((o) => ({ totals: o.totals, overdue: o.overdue })),
  searchEntities: ({ q, domain }) =>
    core.search(q, domain).then((list) => list.map((e) => ({ name: e.name, type: e.type }))),
  recent: (limit) =>
    core.audit(limit).then((list) =>
      list.map((e) => ({ actorKind: e.actorKind, action: e.action, actorRef: e.actorRef, ts: e.ts })),
    ),
  // Кофе-факты: вопросы «сколько кофе ушло?» получают цифры, а не выдумку.
  coffeeConsumption30d: async () => {
    const iso = (d: Date) => d.toLocaleDateString("en-CA", { timeZone: "Asia/Tashkent" });
    const fromDate = new Date();
    fromDate.setDate(fromDate.getDate() - 30);
    const rep = await core.coffeeContainerConsumption(iso(fromDate), iso(new Date()));
    return {
      totalGrams: rep.totalGrams,
      totalCost: rep.totalCost,
      topLocation: rep.locations[0]?.locationName ?? null,
    };
  },
};
