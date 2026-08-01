import { timingSafeEqual } from "node:crypto";
import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Request } from "express";
import { appConfig } from "../config";
import { IS_PUBLIC } from "./public.decorator";

/** Методы только для чтения — их пропускаем: секрет нужен на изменение данных. */
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Сравнение в постоянное время: иначе токен подбирается по времени ответа. */
function secretEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Граница доступа Core: мутации требуют внутренний токен.
 *
 * Раньше любой, кто дотянулся до сети Core, мог менять данные — защита держалась
 * лишь на Docker/Tailscale. Теперь POST/PATCH/PUT/DELETE требуют `x-service-token`
 * (или `Authorization: Bearer`). Чтения (GET) открыты: панель и бот читают много,
 * а вреда от чтения в закрытой сети нет.
 *
 * Если SERVICE_TOKEN не задан — guard пропускает всё (Core об этом предупреждает
 * на старте). Так включение токена не ломает уже работающий контур: сначала
 * выкатывается токен всем клиентам, потом задаётся в Core.
 */
@Injectable()
export class ServiceTokenGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    if (SAFE_METHODS.has(req.method)) return true;

    // Маршруты со своей дверью (ingest с INGEST_KEY, health) — мимо.
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const expected = appConfig.serviceToken;
    if (!expected) return true; // токен не задан — предупреждение на старте, не блок

    const header = req.headers["x-service-token"];
    const bearer = req.headers.authorization;
    const provided =
      typeof header === "string" && header.length > 0
        ? header
        : typeof bearer === "string" && bearer.startsWith("Bearer ")
          ? bearer.slice("Bearer ".length)
          : "";

    if (provided.length === 0 || !secretEquals(provided, expected)) {
      throw new UnauthorizedException("Нужен внутренний токен доступа к Core");
    }
    return true;
  }
}
