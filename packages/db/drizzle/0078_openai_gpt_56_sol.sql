-- GPT-5.6 Sol promotional API tariff verified on 2026-08-30:
-- $4 / MTok input, $0.40 / MTok cached input, $20 / MTok output,
-- cache writes at 1.25x input. The flat ledger cannot represent the separate
-- >272K-input tier yet, so Core rejects those reservations before provider IO.
-- OpenAI guarantees this promotional rate only through 2026-11-21. Expire it
-- after that UTC day so an unreviewed price change fails closed instead of
-- under-reserving. A later price must be installed by a new dated migration.
-- Keep an already-installed active owner price: migrations must not silently
-- replace a tariff that was deliberately corrected ahead of this release.
INSERT INTO "llm_model_price" (
	"provider", "model", "billing_kind", "settlement_kind",
	"input_usd_per_mtok", "output_usd_per_mtok",
	"cache_read_usd_per_mtok", "cache_write_5m_usd_per_mtok", "cache_write_1h_usd_per_mtok",
	"valid_from", "valid_to"
)
SELECT
	'openai', 'gpt-5.6-sol', 'metered', 'tokens',
	4, 20, 0.4, 5, 5,
	'2026-08-30T00:00:00+05:00', '2026-11-22T00:00:00+00:00'
WHERE NOT EXISTS (
	SELECT 1
	FROM "llm_model_price"
	WHERE "provider" = 'openai'
		AND "model" = 'gpt-5.6-sol'
		AND "valid_from" <= '2026-08-30T00:00:00+05:00'
		AND ("valid_to" IS NULL OR "valid_to" > '2026-08-30T00:00:00+05:00')
);
