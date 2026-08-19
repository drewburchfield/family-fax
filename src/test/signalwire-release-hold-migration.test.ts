import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

describe("SignalWire release-hold migration", () => {
  it("conservatively gives existing SignalWire rentals the Trial Mode hold", () => {
    const migration = readFileSync(
      new URL("../../migrations/0003_signalwire_release_hold.sql", import.meta.url),
      "utf8",
    );

    expect(migration).toContain("provider_name = 'signalwire'");
    expect(migration).toContain("'+30 days'");
    expect(migration).toContain("earliest_provider_release_at IS NULL");
    expect(migration).toContain("funded-account rentals may be held longer");
    expect(migration).toContain("no migrated rental can be released too early");
  });
});
