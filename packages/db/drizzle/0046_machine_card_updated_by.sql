ALTER TABLE "machine_card" ADD COLUMN "updated_by" text;--> statement-breakpoint
-- Заполняем задним числом из журнала: кто последним ставил вид, там уже
-- записано. Без этого 29 существующих карточек навсегда остались бы с пустым
-- автором, хотя правки владельца в аудите есть.
--
-- DISTINCT ON берёт самую свежую запись по каждому объекту — именно она
-- объясняет ТЕКУЩИЙ вид. Промежуточные правки остаются в журнале.
--
-- На пустой базе (CI прогоняет цепочку с нуля) обновит ноль строк и пройдёт.
UPDATE "machine_card" mc
SET "updated_by" = a.actor_ref
FROM (
  SELECT DISTINCT ON (target) target, actor_ref
  FROM "audit_log"
  WHERE action IN ('machine.kind_set', 'machine.kind_changed')
    AND target IS NOT NULL
  ORDER BY target, ts DESC
) a
WHERE a.target = mc.entity_id::text
  AND a.actor_ref IS NOT NULL;
