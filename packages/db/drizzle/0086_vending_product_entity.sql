-- Мост прайса вендинга в реестр: vending_product.entity_id → entity (товар на перепродажу), спека vendhub-parts R-PU-10, У6.
-- Бэкфилл по имени (без учёта регистра) там, где карточка уже есть; остальное заводит POST /stock/vending-cards.
ALTER TABLE "vending_product" ADD COLUMN "entity_id" uuid;
--> statement-breakpoint
ALTER TABLE "vending_product" ADD CONSTRAINT "vending_product_entity_id_entity_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
-- Бэкфилл моста по имени: карточка реестра того же имени (без учёта регистра и пробелов по краям),
-- тип product, вид «перепродажа». Две карточки на одно имя — не выбираем (остаётся NULL).
UPDATE "vending_product" vp
SET "entity_id" = m.id
FROM (
  SELECT lower(trim(e.name)) AS key, min(e.id::text)::uuid AS id, count(*) AS n
  FROM "entity" e
  WHERE e.type = 'product' AND e.attrs->>'вид' = 'перепродажа'
  GROUP BY lower(trim(e.name))
) m
WHERE vp."entity_id" IS NULL AND m.n = 1 AND lower(trim(vp.name)) = m.key;
