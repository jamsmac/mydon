CREATE TABLE "geo_point" (
	"entity_id" uuid PRIMARY KEY NOT NULL,
	"lat" numeric(9, 6) NOT NULL,
	"lng" numeric(9, 6) NOT NULL,
	"address" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "geo_point_lat_range" CHECK ("geo_point"."lat" >= -90 and "geo_point"."lat" <= 90),
	CONSTRAINT "geo_point_lng_range" CHECK ("geo_point"."lng" >= -180 and "geo_point"."lng" <= 180)
);
--> statement-breakpoint
ALTER TABLE "geo_point" ADD CONSTRAINT "geo_point_entity_id_entity_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entity"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
-- Перенос уже введённых координат из attrs. Берём только парсимые числа в
-- мировом диапазоне: битые значения не тащим, они и так не были точкой.
INSERT INTO "geo_point" ("entity_id", "lat", "lng", "address")
SELECT
  e.id,
  (e.attrs->>'широта')::numeric,
  (e.attrs->>'долгота')::numeric,
  COALESCE(NULLIF(btrim(e.attrs->>'точка'), ''), NULLIF(btrim(e.attrs->>'адрес'), ''), NULLIF(btrim(e.attrs->>'локация'), ''))
FROM "entity" e
WHERE e.attrs ? 'широта' AND e.attrs ? 'долгота'
  AND btrim(e.attrs->>'широта') ~ '^-?[0-9]+(\.[0-9]+)?$'
  AND btrim(e.attrs->>'долгота') ~ '^-?[0-9]+(\.[0-9]+)?$'
  AND (e.attrs->>'широта')::numeric BETWEEN -90 AND 90
  AND (e.attrs->>'долгота')::numeric BETWEEN -180 AND 180
ON CONFLICT ("entity_id") DO NOTHING;