import { timingSafeEqual } from "node:crypto";
import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from "@nestjs/common";
import type { Request } from "express";
import { appConfig } from "../config";

function secretEquals(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Вторая дверь для необратимых owner-only операций.
 *
 * SERVICE_TOKEN намеренно недостаточен: он есть у Bot/Agents/CC. В частности,
 * worker не должен сам снять `execution_unknown` и разрешить повторную оплату.
 */
@Injectable()
export class OwnerActionGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const expected = appConfig.ownerActionToken;
    const shared = appConfig.serviceToken;
    const header = request.headers["x-owner-action-token"];
    const provided = typeof header === "string" ? header : "";
    if (!expected || expected === shared || !provided || !secretEquals(provided, expected)) {
      throw new UnauthorizedException("Нужен отдельный токен действия владельца");
    }
    return true;
  }
}
