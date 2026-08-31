import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
} from "@nestjs/common";
import type { Request } from "express";
import { DB, type Db } from "../db/db.module";
import { isOwnerIdentityEnforced, ownerTokenValid } from "./owner-enforcement";

/**
 * Направление, которое ВЫБРАЛ клиент, — там, где оно вообще есть в запросе.
 *
 * Домен приходит тремя путями: маршрутным параметром (`finance/summary/:domain`,
 * `registry/:domain/:type`), query (`/entities?domain=`, `units`, `imports`,
 * `contracts`, `preorders`) и полем тела (`POST /finance/flows` c `domain`).
 *
 * ГРАНИЦА СРЕЗА (честно, без ложного чувства закрытости): гейт ловит ТОЛЬКО
 * запросы с явным селектором домена. Запросы БЕЗ него, отдающие personal-строки
 * заодно со всеми, этот guard не видит, и при включённом флаге они остаются
 * открытыми в tailnet. Вне этого среза, закрывается в R-P5-7 (аудит доступа к
 * personal):
 *  - кросс-доменные сводки: `registry/overview`, `registry/briefing`, список
 *    доменов — агрегат по personal;
 *  - домен-less прямые чтения реестра: `GET /entities` (find без `domain`
 *    отдаёт карточки всех org, включая personal), `GET /entities/:id` (byId
 *    без селектора), `GET /entities/pending`;
 *  - `GET /tasks` без `domain` (list отдаёт задачи всех доменов, включая
 *    personal).
 * Owner-token тут не спасает: селектора нет → `selectedDomain` вернёт undefined
 * → guard пропустит независимо от флага. Полное закрытие этих путей — follow-up
 * R-P5-7, а не молчаливо «уже закрыто».
 */
function selectedDomain(req: Request): string | undefined {
  const params = req.params as Record<string, unknown> | undefined;
  const fromParam = typeof params?.domain === "string" ? params.domain : undefined;
  const q = req.query?.domain;
  const fromQuery = typeof q === "string" ? q : undefined;
  const body = req.body as { domain?: unknown } | undefined;
  const fromBody = typeof body?.domain === "string" ? body.domain : undefined;
  return fromParam ?? fromQuery ?? fromBody;
}

/**
 * Личный контур за identity (R-P5-4) — глобально и за мастер-флагом (R-P5-6).
 *
 * Гейтит ТОЛЬКО запросы, где клиент выбрал домен `personal`. Прочие домены
 * (vendhub/globerent/mydon) не трогаются — их GET осознанно остаются открытыми
 * в tailnet. Пока флаг выключен (по умолчанию) — пропускает всё, и мерж среза не
 * меняет поведения. При включённом флаге personal без валидного
 * `OWNER_ACTION_TOKEN` получает честный 403 (а не пустой ответ, не выдающий
 * содержимого). Глобальный guard, а не декоратор на каждом контроллере: домен
 * personal может всплыть в семи контроллерах, и один пропущенный `@UseGuards`
 * был бы тихой дырой.
 */
@Injectable()
export class PersonalDomainGuard implements CanActivate {
  constructor(@Inject(DB) private readonly db: Db) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    if (selectedDomain(req) !== "personal") return true;
    if (!(await isOwnerIdentityEnforced(this.db))) return true;
    if (ownerTokenValid(req)) return true;
    throw new ForbiddenException("Личный контур доступен только владельцу");
  }
}
