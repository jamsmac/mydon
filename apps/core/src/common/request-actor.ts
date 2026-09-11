import { AsyncLocalStorage } from "node:async_hooks";
import { Injectable, type CallHandler, type ExecutionContext, type NestInterceptor } from "@nestjs/common";
import { ACTOR_HEADER, isActorRef } from "@mydon/shared";
import { Observable } from "rxjs";

/**
 * Актор запроса — кто на самом деле совершает действие (R-H-8, R-H-9).
 *
 * ЗАЧЕМ. Контроллеры Core подставляют `?? "owner"`, когда поле актора не
 * прислали, а панель присылала его явно лишь в ~40 вызовах из ~110 записывающих.
 * Остальные ложились в журнал владельцем молча — и правка, сделанная агентом
 * через панель, выглядела правкой владельца. Чинить каждый вызов по отдельности
 * — 70 правок с разными именами полей (`actor`, `actorRef`, `createdBy`,
 * `author`, `manager`…), а у части DTO поля актора нет вовсе.
 *
 * Поэтому актор едет ЗАГОЛОВКОМ на каждой записи панели, а умолчания Core
 * спрашивают его здесь: `dto.actor ?? requestActor("owner")`.
 *
 * ПОРЯДОК: явное поле тела → заголовок → прежнее умолчание. Кто заголовок не
 * шлёт (бот, агенты, кроны), получает ровно то, что получал раньше, — изменение
 * видят только запросы панели.
 *
 * ДОВЕРИЕ. Заголовок — атрибуция, а не право: записи в Core и так закрыты
 * `SERVICE_TOKEN`, а действия владельца — отдельным `OWNER_ACTION_TOKEN`, и
 * ни одно решение о доступе этот заголовок не читает.
 *
 * ПОЧЕМУ ПЕРЕХВАТЧИК, А НЕ EXPRESS-MIDDLEWARE. AsyncLocalStorage не переживает
 * колбэки потоков, а body-parser продолжает цепочку из события `end` сокета:
 * middleware, поставленный раньше парсера, терял бы контекст молча. Перехватчик
 * оборачивает сам обработчик, когда тело уже разобрано.
 */
export { ACTOR_HEADER };

/**
 * Формат ссылки — общий с панелью (`isActorRef` в `@mydon/shared`). Всё прочее
 * отбрасывается: мусорный заголовок не должен становиться автором.
 */
export function parseActorHeader(raw: string | string[] | undefined): string | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined) return null;
  const trimmed = value.trim();
  return isActorRef(trimmed) ? trimmed : null;
}

const store = new AsyncLocalStorage<{ actor: string | null }>();

/** Актор текущего запроса; вне запроса или без заголовка — `fallback`. */
export function requestActor(fallback: string): string {
  return store.getStore()?.actor ?? fallback;
}

/** Выполнить `fn` от имени актора — для тестов и перехватчика. */
export function runWithActor<T>(actor: string | null, fn: () => T): T {
  return store.run({ actor }, fn);
}

@Injectable()
export class RequestActorInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<{ headers?: Record<string, string | string[] | undefined> }>();
    const actor = parseActorHeader(request.headers?.[ACTOR_HEADER]);
    // Подписка на handle() происходит ПОЗЖЕ intercept — поэтому run оборачивает
    // именно подписку, иначе обработчик выполнился бы уже вне контекста.
    return new Observable((subscriber) => runWithActor(actor, () => next.handle().subscribe(subscriber)));
  }
}
