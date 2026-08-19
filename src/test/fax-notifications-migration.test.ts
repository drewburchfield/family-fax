import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

describe("fax notification migration", () => {
  it("creates durable idempotency claims and a stale-state index", () => {
    const migration = readFileSync(
      new URL("../../migrations/0004_fax_notifications.sql", import.meta.url),
      "utf8",
    );

    expect(migration).toContain("PRIMARY KEY (fax_job_id, kind)");
    expect(migration).toContain("delivery_unknown");
    expect(migration).toContain("CREATE INDEX IF NOT EXISTS fax_notifications_state");
  });
});
