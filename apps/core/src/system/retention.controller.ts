import { Body, Controller, Post } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { IsBoolean, IsOptional } from "class-validator";
import { RetentionService, type RetentionResult } from "../vending/retention.service";

/** Тело `POST /system/retention/run`: единственный выбор — писать или примерять. */
export class RetentionRunDto {
  /**
   * `true` — примерка: те же запросы с тем же предикатом, но `count(*)` вместо
   * DELETE и без событий. Умолчание `false` — настоящая чистка, ровно та же,
   * что делает крон воскресным утром.
   */
  @IsOptional() @IsBoolean()
  dryRun?: boolean;
}

/** Ответ ручного прогона: что и по какой цели произошло, плюс режим. */
export interface RetentionRunResult {
  dryRun: boolean;
  tables: RetentionResult[];
}

/**
 * Ручной прогон ретенции (R-FW-S2).
 *
 * ЗАЧЕМ РОУТ. Тот же метод, что дёргает крон в воскресенье 04:10, — и роут
 * нужен по той же паре причин, по которой рядом заведён
 * `POST /vending/shrinkage/alerts`: без него весь SQL ретенции не исполнялся
 * бы против живого Postgres НИ РАЗУ (заглушка юнит-теста запросы не выполняет,
 * а проверяет РЕНДЕР), и владелец не мог бы почистить историю по месту, не
 * дожидаясь воскресенья. Отдельно важна пятая цель: она сравнивает
 * `date`-колонку с голыми сутками-строкой, и ошибка в типизации параметра
 * («operator does not exist: date < text») падала бы каждое воскресенье в
 * 04:10 — молча для всех, кроме журнала событий.
 *
 * Путь `system/*`, а не `vending/*`: ретенция чистит и снимки, и продажи, и
 * журнал прогонов — это операция системы, а не вендинга. Сервис живёт в
 * `VendingModule` и оттуда экспортирован; `SystemModule` уже импортирует
 * вендинг ради `AnalyticsService` — второй такой зависимости здесь не заводится.
 *
 * Мутация закрыта общим `ServiceTokenGuard` (POST). Лимит СВОЙ и жёсткий: это
 * не чтение, а цикл DELETE с бюджетом в минуту, и два таких прогона подряд
 * незачем — `protect: true` у крона держит ту же границу с другой стороны.
 */
@Controller("system/retention")
export class RetentionController {
  constructor(private readonly retention: RetentionService) {}

  @Throttle({ burst: { limit: 2, ttl: 60_000 } })
  @Post("run")
  async run(@Body() dto: RetentionRunDto): Promise<RetentionRunResult> {
    const dryRun = dto.dryRun ?? false;
    // `includeEmpty`: ручной прогон отвечает по ВСЕМ пяти целям, включая
    // «удалено 0». Крон о нулях молчит намеренно (52 записи ни о чём в году),
    // но пустой ответ на ручной вызов читался бы как «ничего не сработало».
    const tables = await this.retention.sweep(new Date(), { dryRun, includeEmpty: true });
    return { dryRun, tables };
  }
}
