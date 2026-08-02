-- Дедупликация ДО создания unique-индексов: продакшн мог уже накопить дубли
-- по (машина, товар, capturedAt) — это же тот баг, ради которого добавляется
-- constraint. Без этой чистки CREATE UNIQUE INDEX упал бы на существующих
-- дублях (найдено внешним ревью). Оставляем одну строку на группу (ctid —
-- физический адрес строки, устойчивый порядок сравнения внутри запроса);
-- какую именно из дублей оставить не важно — редоставка одного батча несёт
-- одни и те же значения.
DELETE FROM "product_sale" a USING "product_sale" b
WHERE a.ctid < b.ctid
  AND a.machine_serial = b.machine_serial
  AND a.product_name = b.product_name
  AND a.captured_at = b.captured_at;--> statement-breakpoint
DELETE FROM "machine_sale" a USING "machine_sale" b
WHERE a.ctid < b.ctid
  AND a.machine_serial = b.machine_serial
  AND a.captured_at = b.captured_at;--> statement-breakpoint
DROP INDEX "machine_sale_machine_captured_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "machine_sale_batch_key" ON "machine_sale" USING btree ("machine_serial","captured_at");--> statement-breakpoint
CREATE UNIQUE INDEX "product_sale_batch_key" ON "product_sale" USING btree ("machine_serial","product_name","captured_at");
