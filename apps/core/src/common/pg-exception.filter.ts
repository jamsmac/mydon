import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from "@nestjs/common";
import type { Response } from "express";

/**
 * Ошибки Postgres класса 22 (некорректные данные) — это вина запроса, а не сервера.
 *
 * Без этого нулевой байт в строке или мусор в JSON давали голый 500
 * «Internal server error»: клиент не понимал, что именно не так, а в логи
 * сыпались ошибки уровня БД, неотличимые от настоящего сбоя.
 */
@Catch()
export class PgExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger("PgExceptionFilter");

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      res.status(status).json(exception.getResponse());
      return;
    }

    const code = findPgCode(exception);

    // Класс 22 — data exception: некорректный формат, нулевой байт, выход за диапазон.
    // Класс 23 — нарушение ограничений целостности.
    if (code?.startsWith("22") || code?.startsWith("23")) {
      this.logger.warn(`Некорректные данные в запросе (SQLSTATE ${code})`);
      res.status(400).json({
        statusCode: 400,
        message: "Некорректные данные в запросе",
        detail: `СУБД отклонила значение (код ${code})`,
      });
      return;
    }

    // Всё остальное — настоящий сбой: наружу без подробностей, детали в лог.
    this.logger.error("Необработанная ошибка", exception instanceof Error ? exception.stack : exception);
    res.status(500).json({ statusCode: 500, message: "Internal server error" });
  }
}

/** Код SQLSTATE может лежать в самой ошибке или в её cause (Drizzle оборачивает). */
function findPgCode(err: unknown, depth = 0): string | undefined {
  if (!err || typeof err !== "object" || depth > 5) return undefined;
  const candidate = (err as { code?: unknown }).code;
  if (typeof candidate === "string" && /^\d{2}\w{3}$/.test(candidate)) return candidate;
  return findPgCode((err as { cause?: unknown }).cause, depth + 1);
}
