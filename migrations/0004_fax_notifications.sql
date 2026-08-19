CREATE TABLE IF NOT EXISTS fax_notifications (
  fax_job_id TEXT NOT NULL REFERENCES fax_jobs(id),
  kind TEXT NOT NULL CHECK (kind IN ('inbound_received', 'outbound_delivered')),
  state TEXT NOT NULL CHECK (state IN ('sending', 'delivered', 'failed', 'delivery_unknown')),
  destination_email TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  message_id TEXT,
  attached INTEGER,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  delivered_at TEXT,
  PRIMARY KEY (fax_job_id, kind)
);

CREATE INDEX IF NOT EXISTS fax_notifications_state
  ON fax_notifications(state, updated_at);
