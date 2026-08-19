-- Keep concurrent browser sessions from purchasing two retained household lines.
CREATE UNIQUE INDEX IF NOT EXISTS idx_temporary_numbers_one_pending_household_line
  ON temporary_numbers(provider_name)
  WHERE provider_name IS NOT NULL
    AND mode IN ('receive-only', 'send-and-receive')
    AND state IN ('requested', 'provisioning', 'activating', 'cleaning');
