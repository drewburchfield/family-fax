import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("pending household line migration", () => {
  it("prevents two retained line purchases from being pending for one provider", async () => {
    const sql = await readFile(
      new URL("../../migrations/0005_pending_household_line_guard.sql", import.meta.url),
      "utf8",
    );

    expect(sql).toMatch(/CREATE UNIQUE INDEX/i);
    expect(sql).toMatch(/ON temporary_numbers\(provider_name\)/i);
    expect(sql).toMatch(/mode IN \('receive-only', 'send-and-receive'\)/i);
    expect(sql).toMatch(/state IN \('requested', 'provisioning', 'activating', 'cleaning'\)/i);
  });
});
