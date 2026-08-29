-- collection.client_key (срез «правда о пробеле», R-I-2): ключ идемпотентности
-- у журнала инкассаций. Сегодня его нет вовсе — повторный перенос из VendCash
-- молча удвоил бы все 386 строк, а ретрай кнопки в боте после таймаута 10 с
-- уже сейчас даёт вторую инкассацию.
--
-- Индекс НЕ частичный: NULL в уникальном индексе Postgres различны, поэтому
-- строки без ключа (законное состояние — источника вне MYDON у них нет) друг
-- другу не мешают. Ровно так живут task_client_key, stock_movement_client_key,
-- maintenance_log_client_key.
--
-- IF NOT EXISTS — защитный паттерн 0067/0069/0071: автодеплой применяет
-- миграции без отката, и упавший оператор вешает выкатку молча и навсегда.

ALTER TABLE "collection" ADD COLUMN IF NOT EXISTS "client_key" text;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "collection_client_key" ON "collection" USING btree ("client_key");
