import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

describe("production Cloudflare command guard", () => {
  it("refuses to deploy without an explicit production config and secrets file", () => {
    const env = { ...process.env };
    delete env.FAMILY_FAX_WRANGLER_CONFIG_PATH;
    delete env.FAMILY_FAX_SECRETS_FILE;

    const result = spawnSync(process.execPath, ["scripts/cloudflare-production.mjs", "deploy"], {
      cwd: process.cwd(),
      env,
      encoding: "utf8",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/FAMILY_FAX_WRANGLER_CONFIG_PATH/);
  });
});
