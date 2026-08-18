-- Идемпотентность движений склада от клиента (аудит видимости 18.08).
--
-- Тот же принцип, что vending_refill/maintenance_log: таймаут при успехе +
-- честный повтор не должны давать второй приход или корректировку.
-- NULL не конфликтует: панель и синк ключа не шлют.
ALTER TABLE "stock_movement" ADD COLUMN "client_key" text;--> statement-breakpoint
CREATE UNIQUE INDEX "stock_movement_client_key" ON "stock_movement" ("client_key");
