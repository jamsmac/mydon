-- Maintenance monitor belongs to the VendHub operating direction.
--
-- The HTTP DTO accepted `domain`, but its controller did not forward the
-- field, so all historical monitor tasks landed in the unassigned direction.
-- This data-only repair is deliberately narrower than `source like 'maint:%'`:
-- the row must carry the monitor actor, canonical source identity, human owner,
-- existing plan/entity relation and a registry object that actually belongs to
-- VendHub. User-created and unrelated domain-less tasks remain untouched.
UPDATE "task" AS t
   SET "domain" = 'vendhub'
  FROM "maintenance_plan" AS mp
  JOIN "entity" AS e ON e."id" = mp."entity_id"
  JOIN "org" AS o ON o."id" = e."org_id"
 WHERE t."domain" IS NULL
   AND t."created_by" = 'agent:maintenance-monitor'
   AND t."owner_kind" = 'human'
   AND t."entity_id" = mp."entity_id"
   AND split_part(t."source", ':', 2) = mp."id"::text
   AND t."source" ~ '^maint:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9]{4}-[0-9]{2}-[0-9]{2}$'
   AND o."code" = 'vendhub';
