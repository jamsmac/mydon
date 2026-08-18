import { BadRequestException, Controller, Get, Param, Query } from "@nestjs/common";
import { DOMAINS, type Domain } from "@mydon/shared";
import { ActionsService } from "./actions.service";
import { RegistryService } from "./registry.service";

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f-]{36}$/;

function asDomain(value: string): Domain {
  if (!(DOMAINS as readonly string[]).includes(value)) {
    throw new BadRequestException(`Неизвестное направление "${value}". Доступны: ${DOMAINS.join(", ")}`);
  }
  return value as Domain;
}

@Controller("registry")
export class RegistryController {
  constructor(
    private readonly registry: RegistryService,
    private readonly actionsFeed: ActionsService,
  ) {}

  // ВАЖНО: специфичные маршруты объявляются ВЫШЕ параметрических,
  // иначе ":domain/:type" перехватит "obligations/:domain".

  /** Утренний брифинг 07:30 (FR-6). */
  @Get("briefing")
  briefing() {
    return this.registry.briefing();
  }

  /**
   * Лента действий сотрудников: «кто что сделал» за период (даты YYYY-MM-DD
   * по Ташкенту, включительно). Обе даты не заданы — сегодня.
   */
  @Get("actions")
  actions(@Query("from") from?: string, @Query("to") to?: string, @Query("person") personId?: string) {
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Tashkent" });
    const f = from ?? today;
    const t = to ?? f;
    if (!ISO_DAY.test(f) || !ISO_DAY.test(t)) {
      throw new BadRequestException("from/to: даты в формате YYYY-MM-DD");
    }
    if (personId !== undefined && !UUID.test(personId)) {
      throw new BadRequestException("person: uuid сотрудника");
    }
    return this.actionsFeed.actions(f, t, personId);
  }

  /** Все обязательства направления — DoD Фазы 3. */
  @Get("obligations/:domain")
  obligations(@Param("domain") domain: string) {
    return this.registry.obligations(asDomain(domain));
  }

  /** Сводка по направлениям: важно объявить ДО маршрута :domain/:type. */
  @Get("overview")
  overview() {
    return this.registry.overview();
  }

  @Get()
  domains(@Query("only") only?: string) {
    return only ? [asDomain(only)] : DOMAINS;
  }

  /** Сущности направления по типу, например /registry/vendhub/machine — DoD Фазы 3. */
  @Get(":domain/:type")
  byType(@Param("domain") domain: string, @Param("type") type: string) {
    return this.registry.byType(asDomain(domain), type);
  }
}
