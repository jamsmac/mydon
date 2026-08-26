-- Индексы ПО ВРЕМЕНИ под еженедельную ретенцию (П8b fix wave, Task 4 minor 1).
--
-- Зачем. `RetentionService` чистит пачками по 5000:
--   delete from T where id in (select id from T where <время> < cutoff
--                              order by <время> limit 5000)
-- У slot_snapshot / product_sale / machine_sale индекс составной и ведущая
-- колонка — machine_serial, то есть под это условие он не годится: нужен seq
-- scan плюс сортировка НА КАЖДУЮ ПАЧКУ. У vending_sync_run индекса не было
-- вовсе, хотя по started_at ходят ещё двое — «последний успешный прогон» и
-- «статус последнего», обе на каждой странице здоровья сбора.
--
-- Почему это не «преждевременно». Сегодня таблицы маленькие (slot_snapshot
-- ~37 тыс. строк) и Postgres берёт составной индекс как есть. Но прирост
-- ~1680 строк/сут, первая непустая чистка придётся на 180 суток истории, а
-- опущенный однажды SNAPSHOT_RETENTION_DAYS даёт разовую чистку в десятки
-- пачек полного скана. Индекс дешевле ровно сейчас, пока таблицы малы.
--
-- Почему НЕ `CREATE INDEX CONCURRENTLY`. Мигратор drizzle применяет файл в
-- транзакции, а CONCURRENTLY в транзакции запрещён — оператор упал бы и
-- ПОВЕСИЛ БЫ автодеплой молча и навсегда. При текущих объёмах обычный CREATE
-- INDEX держит блокировку доли секунды.
--
-- IF NOT EXISTS — защитный паттерн 0067/0069: автодеплой применяет миграции без
-- отката, и каждый оператор обязан быть безопасен на повторном прогоне.
-- Снапшот 0070 снят генератором с текущей schema.ts, так что следующий
-- db:generate снова честен.

CREATE INDEX IF NOT EXISTS "slot_snapshot_captured_idx" ON "slot_snapshot" USING btree ("captured_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "product_sale_captured_idx" ON "product_sale" USING btree ("captured_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "machine_sale_captured_idx" ON "machine_sale" USING btree ("captured_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "vending_sync_run_started_idx" ON "vending_sync_run" USING btree ("started_at");
