PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS fax_jobs (
  id TEXT PRIMARY KEY,
  mode TEXT NOT NULL CHECK (mode IN ('send-only', 'receive-only', 'send-and-receive')),
  direction TEXT NOT NULL CHECK (direction IN ('outbound', 'inbound', 'none')),
  state TEXT NOT NULL,
  to_number TEXT,
  from_number TEXT,
  provider_fax_id TEXT,
  provider_project_id TEXT,
  temporary_number_id TEXT,
  correlation_id TEXT NOT NULL,
  final_document_id TEXT,
  page_count INTEGER,
  estimated_cost_json TEXT,
  reported_cost_json TEXT,
  requested_ttl_days INTEGER,
  cover_data_json TEXT,
  failure_code TEXT,
  failure_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  submitted_at TEXT,
  completed_at TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS fax_jobs_provider_fax_id
  ON fax_jobs(provider_fax_id) WHERE provider_fax_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS fax_jobs_created_at ON fax_jobs(created_at DESC);
CREATE INDEX IF NOT EXISTS fax_jobs_state ON fax_jobs(state, updated_at);
CREATE INDEX IF NOT EXISTS fax_jobs_numbers ON fax_jobs(to_number, from_number);

CREATE TABLE IF NOT EXISTS temporary_numbers (
  id TEXT PRIMARY KEY,
  fax_job_id TEXT REFERENCES fax_jobs(id),
  e164 TEXT,
  area_code TEXT NOT NULL,
  provider_id TEXT,
  state TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('send-only', 'receive-only', 'send-and-receive')),
  forwarding_email TEXT NOT NULL,
  setup_price_json TEXT,
  monthly_price_json TEXT,
  provisioned_at TEXT,
  expires_at TEXT,
  release_started_at TEXT,
  released_at TEXT,
  workflow_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS temporary_numbers_e164_active
  ON temporary_numbers(e164) WHERE e164 IS NOT NULL AND state != 'released';
CREATE INDEX IF NOT EXISTS temporary_numbers_expiration
  ON temporary_numbers(state, expires_at);

CREATE TABLE IF NOT EXISTS fax_documents (
  id TEXT PRIMARY KEY,
  fax_job_id TEXT REFERENCES fax_jobs(id),
  temporary_number_id TEXT REFERENCES temporary_numbers(id),
  kind TEXT NOT NULL CHECK (kind IN ('original', 'cover', 'final-packet', 'inbound')),
  object_key TEXT NOT NULL UNIQUE,
  mime_type TEXT NOT NULL,
  byte_count INTEGER NOT NULL,
  page_count INTEGER,
  sha256 TEXT NOT NULL,
  display_name TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS fax_documents_job ON fax_documents(fax_job_id, created_at);
CREATE INDEX IF NOT EXISTS fax_documents_number ON fax_documents(temporary_number_id, created_at);

CREATE TABLE IF NOT EXISTS fax_events (
  id TEXT PRIMARY KEY,
  correlation_id TEXT NOT NULL,
  fax_job_id TEXT REFERENCES fax_jobs(id),
  temporary_number_id TEXT REFERENCES temporary_numbers(id),
  source TEXT NOT NULL,
  type TEXT NOT NULL,
  resulting_state TEXT,
  attempt INTEGER,
  duration_ms INTEGER,
  details_json TEXT NOT NULL,
  raw_payload_key TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS fax_events_job ON fax_events(fax_job_id, created_at);
CREATE INDEX IF NOT EXISTS fax_events_number ON fax_events(temporary_number_id, created_at);
CREATE INDEX IF NOT EXISTS fax_events_correlation ON fax_events(correlation_id, created_at);

CREATE TABLE IF NOT EXISTS webhook_receipts (
  provider TEXT NOT NULL,
  event_key TEXT NOT NULL,
  received_at TEXT NOT NULL,
  PRIMARY KEY (provider, event_key)
);

CREATE TABLE IF NOT EXISTS provider_content_tokens (
  token_hash TEXT PRIMARY KEY,
  fax_job_id TEXT NOT NULL REFERENCES fax_jobs(id),
  document_id TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS provider_content_tokens_job
  ON provider_content_tokens(fax_job_id, revoked_at, expires_at);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cover_templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  data_json TEXT NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS cover_templates_one_default
  ON cover_templates(is_default) WHERE is_default = 1;
