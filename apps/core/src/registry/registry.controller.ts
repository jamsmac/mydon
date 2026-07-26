import { BadRequestException, Controller, Get, Param, Query } from "@nestjs/common";
import { DOMAINS, type Domain } from "@mydon/shared";
import { RegistryService } from "./registry.service";

function asDomain(value: string): Domain {
  if (!(DOMAINS as readonly string[]).includes(value)) {
    throw new BadRequestException(`Неизвестное направление "${value}". Доступны: ${DOMAINS.join(", ")}`);
  }
  return value as Domain;
}

@Controller("registry")
export class RegistryController {
  constructor(private readonly registry: RegistryService) {}

  // ВАЖНО: специфичные маршруты объявляются ВЫШЕ параметрических,
  // иначе ":domain/:type" перехватит "obligations/:domain".

  /** Утренний брифинг 07:30 (FR-6). */
  @Get("briefing")
  briefing() {
    return this.registry.briefing();
  }

  /** Все обязательства направления — DoD Фазы 3. */
  @Get("obligations/:domain")
  obligations(@Param("domain") domain: string) {
    return this.registry.obligations(asDomain(domain));
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
