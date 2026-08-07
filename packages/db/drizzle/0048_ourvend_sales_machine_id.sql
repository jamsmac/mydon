ALTER TABLE "machine_sale" ADD COLUMN "machine_id" uuid;--> statement-breakpoint
ALTER TABLE "product_sale" ADD COLUMN "machine_id" uuid;--> statement-breakpoint
ALTER TABLE "machine_sale" ADD CONSTRAINT "machine_sale_machine_id_entity_id_fk" FOREIGN KEY ("machine_id") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_sale" ADD CONSTRAINT "product_sale_machine_id_entity_id_fk" FOREIGN KEY ("machine_id") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Заполняем задним числом по КАНОНУ серийника, а не по написанию.
--
-- Реестр хранит снековые серийники с приставкой «c» (наследие mydon-stock),
-- Ourvend отдаёт их без неё. То же правило, что уже применяется в sale и
-- machine_stock: `^c` + ровно 10 цифр срезается, коды кофемашин (12 символов,
-- шестнадцатеричные) под него не подпадают — среди них есть живой c7a6181f0000.
--
-- На пустой базе (CI прогоняет цепочку с нуля) обновит ноль строк.
UPDATE "product_sale" ps
SET "machine_id" = e.id
FROM "entity" e
WHERE ps."machine_id" IS NULL
  AND e.type = 'machine'
  AND coalesce(e.external_ref, '') <> ''
  AND regexp_replace(lower(coalesce(e.external_ref, '')), '^c([0-9]{10})$', '\1')
    = regexp_replace(lower(coalesce(ps."machine_serial", '')), '^c([0-9]{10})$', '\1');--> statement-breakpoint
UPDATE "machine_sale" ms
SET "machine_id" = e.id
FROM "entity" e
WHERE ms."machine_id" IS NULL
  AND e.type = 'machine'
  AND coalesce(e.external_ref, '') <> ''
  AND regexp_replace(lower(coalesce(e.external_ref, '')), '^c([0-9]{10})$', '\1')
    = regexp_replace(lower(coalesce(ms."machine_serial", '')), '^c([0-9]{10})$', '\1');
