-- Индекс ПО `dt` под ретенцию истории склада (срез «Хвосты», R-H-8).
--
-- Зачем. `RetentionService` чистит пачками по 5000:
--   delete from vending_stock_count where id in (
--     select id from vending_stock_count where dt < cutoff order by dt limit 5000)
-- Существующий `vending_stock_count_product_dt_idx (product_name, dt)` под это
-- условие не годится: ведущая колонка — имя товара, то есть нужен seq scan
-- плюс сортировка НА КАЖДУЮ ПАЧКУ.
--
-- Почему НЕ `CREATE INDEX CONCURRENTLY`. Мигратор drizzle применяет файл в
-- транзакции, а CONCURRENTLY в транзакции запрещён — оператор упал бы и
-- ПОВЕСИЛ БЫ автодеплой молча и навсегда. 460 строк — блокировка доли секунды.
--
-- IF NOT EXISTS — защитный паттерн 0067/0069/0070: автодеплой применяет
-- миграции без отката, и каждый оператор обязан быть безопасен на повторе.

CREATE INDEX IF NOT EXISTS "vending_stock_count_dt_idx" ON "vending_stock_count" USING btree ("dt");
