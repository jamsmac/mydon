import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from "@nestjs/common";
import type { Request } from "express";
import { appConfig } from "../config";
import { ownerTokenValid } from "./owner-enforcement";

/**
 * Второй пояс для owner-админ-поверхности `PUT /system/config[/llm-profile]`,
 * привязанный к НАЛИЧИЮ `OWNER_ACTION_TOKEN`, а НЕ к флагу `OWNER_IDENTITY_ENFORCED`.
 *
 * Почему НЕ за флагом (в отличие от `OwnerMutationGuard`): сам мастер-флаг
 * `OWNER_IDENTITY_ENFORCED` пишется через этот же `PUT /system/config`. Если бы
 * охват guard'а зависел от `isOwnerIdentityEnforced`, любой в tailnet с общим
 * `SERVICE_TOKEN` сперва выключил бы enforcement — и guard тут же исчез бы
 * («кто охраняет охрану»). Поэтому охват определяется присутствием ОТДЕЛЬНОГО
 * токена, который знает только владелец:
 *   • `OWNER_ACTION_TOKEN` НЕ задан (дефолт прода) — поверхность закрыта лишь
 *     общим `ServiceTokenGuard`, как сегодня; мерж среза поведение прода НЕ меняет;
 *   • `OWNER_ACTION_TOKEN` задан — оба PUT ВСЕГДА требуют `x-owner-action-token`,
 *     независимо от значения флага enforcement (вкл или выкл — guard одинаков).
 *
 * Проверку токена не дублируем — используем единый `ownerTokenValid` (тот же
 * инвариант: токен обязан отличаться от общего `SERVICE_TOKEN`). Вырожденный
 * случай `OWNER_ACTION_TOKEN === SERVICE_TOKEN` — это «нет отдельного токена»,
 * поэтому ведём себя как без токена (иначе владелец заперся бы снаружи панели).
 */
@Injectable()
export class SystemOwnerGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const expected = appConfig.ownerActionToken;
    const shared = appConfig.serviceToken;
    // Отдельного токена нет (или он вырожден в общий) → guard не активен, путь
    // закрыт только общим ServiceTokenGuard, как сегодня. Merge-safe для прода.
    if (!expected || expected === shared) return true;
    const req = context.switchToHttp().getRequest<Request>();
    if (ownerTokenValid(req)) return true;
    throw new UnauthorizedException(
      "Настройки системы — действие владельца: нужен отдельный токен (x-owner-action-token)",
    );
  }
}
