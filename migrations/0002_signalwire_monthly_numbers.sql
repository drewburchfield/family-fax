ALTER TABLE fax_jobs ADD COLUMN requested_rental_months INTEGER;

ALTER TABLE temporary_numbers ADD COLUMN provider_name TEXT;
ALTER TABLE temporary_numbers ADD COLUMN release_policy TEXT NOT NULL DEFAULT 'scheduled';
ALTER TABLE temporary_numbers ADD COLUMN rental_months INTEGER;
ALTER TABLE temporary_numbers ADD COLUMN next_billed_at TEXT;
ALTER TABLE temporary_numbers ADD COLUMN release_at TEXT;

UPDATE temporary_numbers
SET release_at = expires_at
WHERE release_at IS NULL AND expires_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS temporary_numbers_release
  ON temporary_numbers(state, release_at);
