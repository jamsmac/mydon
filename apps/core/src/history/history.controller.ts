import { Controller, Get, Query } from "@nestjs/common";
import { HistoryService } from "./history.service";

/** История разговоров: помощник ищет здесь контекст прошлых решений. */
@Controller("history")
export class HistoryController {
  constructor(private readonly history: HistoryService) {}

  @Get("search")
  search(@Query("q") q?: string, @Query("limit") limit?: string) {
    const query = (q ?? "").trim();
    if (query.length < 2) return { configured: true, hits: [] };
    const n = Number(limit);
    return this.history.search(query, Number.isFinite(n) && n > 0 ? Math.min(n, 20) : 6);
  }

  /** Сколько разговоров в индексе — владельцу видно, что память подключена. */
  @Get("stats")
  stats() {
    return this.history.stats();
  }
}
