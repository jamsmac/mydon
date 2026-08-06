ALTER TABLE "attachment" ADD COLUMN "stage" text;--> statement-breakpoint
ALTER TABLE "task" ADD COLUMN "entity_id" uuid;--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_entity_id_entity_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "task_entity_idx" ON "task" USING btree ("entity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "task_source_key" ON "task" USING btree ("source") WHERE source ~ ':[0-9]{4}-[0-9]{2}-[0-9]{2}$';