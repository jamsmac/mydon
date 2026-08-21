-- Мост coffee_ingredient → entity(type='ingredient').
-- Бэкфилл по ТОЧНОМУ имени: на 21.08.2026 все 8 бункерных ингредиентов
-- совпадают с карточками посимвольно (проверено на проде). Миграция
-- сознательно НЕ падает на несовпадении: колонка nullable, старый путь
-- работает, а сирота видна на экране. Падающая миграция остановила бы
-- автодеплой без отката.
--
-- Файл написан руками (как 0049–0056): автогенерация diff'ится бы от
-- предыдущего снапшота и не даёт ни IF NOT EXISTS, ни бэкфилл. Снапшот 0059
-- при этом СВЕЖИЙ — снят с текущей schema.ts, так что следующий db:generate
-- снова честен.
ALTER TABLE "coffee_ingredient" ADD COLUMN IF NOT EXISTS "entity_id" uuid;--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "coffee_ingredient"
    ADD CONSTRAINT "coffee_ingredient_entity_id_entity_id_fk"
    FOREIGN KEY ("entity_id") REFERENCES "entity"("id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

-- Одна карточка — не больше одной строки бункерного реестра.
CREATE UNIQUE INDEX IF NOT EXISTS "ux_coffee_ingredient_entity"
  ON "coffee_ingredient" ("entity_id") WHERE "entity_id" IS NOT NULL;--> statement-breakpoint

-- У `entity` нет колонки мягкого удаления: сверено по schema.ts (id, org_id,
-- type, name, external_ref, attrs, approved_at, approved_by, created_from,
-- created_at, updated_at) — soft delete в этой таблице не заведён. Условие
-- `deleted_at IS NULL` из черновика ТЗ снято: строка на несуществующей
-- колонке уронила бы миграцию, а не подстраховала бы её.
UPDATE "coffee_ingredient" ci
   SET "entity_id" = e."id"
  FROM "entity" e
 WHERE e."type" = 'ingredient'
   AND e."name" = ci."name"
   AND ci."entity_id" IS NULL;
