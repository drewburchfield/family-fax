ALTER TABLE temporary_numbers ADD COLUMN earliest_provider_release_at TEXT;

-- This deployment's existing SignalWire rentals were purchased while Trial Mode was active.
-- Use the 30-day trial hold as a conservative backfill for unknown or mixed account history:
-- funded-account rentals may be held longer, but no migrated rental can be released too early.
UPDATE temporary_numbers
SET earliest_provider_release_at = strftime(
  '%Y-%m-%dT%H:%M:%fZ',
  provisioned_at,
  '+30 days'
)
WHERE provider_name = 'signalwire'
  AND provisioned_at IS NOT NULL
  AND earliest_provider_release_at IS NULL;
