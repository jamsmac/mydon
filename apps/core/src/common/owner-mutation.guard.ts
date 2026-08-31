import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import type { Request } from "express";
import { DB, type Db } from "../db/db.module";
import { isOwnerIdentityEnforced, ownerTokenValid } from "./owner-enforcement";

/**
 * Второй пояс для owner-действий (R-P5-5), спрятанный за мастер-флагом (R-P5-6).
 *
 * Навешивается на approvals-решения, приглашение/отзыв доступа, смену ролей и
 * смену автономии агента. Пока ужесточение выключено (по умолчанию) — guard
 * пропускает: эти пути уже закрыты общим `ServiceTokenGuard`, и СЕГОДНЯ их
 * штатно инициирует владелец через бота (согласование/добавление сотрудника в
 * Telegram) и панель под общим `SERVICE_TOKEN`. Поэтому мерж среза не меняет
 * поведения прода. Когда владелец включит флаг — Core дополнительно требует
 * отдельный `OWNER_ACTION_TOKEN`, которого нет у Bot/Agents.
 *
 * `OwnerActionGuard` из `tasks` намеренно оставлен всегда-строгим (снятие
 * LLM replay-блока необратимо) — этот guard отдельный, потому что его охват
 * должен уметь откатываться флагом без нового деплоя.
 */
@Injectable()
export class OwnerMutationGuard implements CanActivate {
  constructor(@Inject(DB) private readonly db: Db) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (!(await isOwnerIdentityEnforced(this.db))) return true;
    const req = context.switchToHttp().getRequest<Request>();
    if (ownerTokenValid(req)) return true;
    throw new UnauthorizedException(
      "Действие владельца: нужен отдельный токен действия (x-owner-action-token)",
    );
  }
}
