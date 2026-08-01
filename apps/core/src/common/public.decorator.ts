import { SetMetadata } from "@nestjs/common";

/** Маршрут со своей защитой (или намеренно открытый) — вне service-token guard. */
export const IS_PUBLIC = "mydon:public";

/**
 * Пометить маршрут открытым для service-token guard. Ставится на то, у чего своя
 * дверь (приём событий с INGEST_KEY) или что осознанно открыто (health).
 */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC, true);
