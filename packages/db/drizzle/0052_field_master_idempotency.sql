-- Идемпотентность полевых мастеров (аудит 18.08.2026, тема «тихие потери»).
--
-- Замена узла, чистка, осмотр и заявка о поломке писались без ключа
-- идемпотентности: таймаут клиента (10 с) при успехе на сервере + честный
-- ретрай сотрудника = вторая замена (со снятием только что поставленного
-- узла как «prev»), второй лог ТО или дубль-заявка. У заливок такой ключ
-- уже есть (vending_refill.client_key) — выравниваем остальные журналы.
--
-- NULL разрешён и не конфликтует (Postgres не считает NULL равными):
-- панель и импорт ключа не шлют, для них ничего не меняется.
ALTER TABLE "maintenance_log" ADD COLUMN "client_key" text;--> statement-breakpoint
ALTER TABLE "task" ADD COLUMN "client_key" text;--> statement-breakpoint
CREATE UNIQUE INDEX "maintenance_log_client_key" ON "maintenance_log" ("client_key");--> statement-breakpoint
CREATE UNIQUE INDEX "task_client_key" ON "task" ("client_key");
