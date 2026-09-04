-- kb_pages агента: страницы знаний в контексте модели (спека 2026-09-04-llm-skill-executor-design, R-LS-10).
-- Раньше жили только в config.yaml и рантаймом не читались; агент из панели оставался без KB.
ALTER TABLE "agent" ADD COLUMN "kb_pages" jsonb DEFAULT '[]'::jsonb NOT NULL;
