import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { parseRuntimeConfig } from "../domain/config";

describe("public production templates", () => {
  it("provides a complete SignalWire environment that passes runtime validation", () => {
    const values = parseDotenv(readFileSync(".env.production.example", "utf8"));

    const config = parseRuntimeConfig(values);

    expect(config.auth.mode).toBe("access");
    expect(config.provider).toBe("signalwire");
    expect(config.signalwire?.minimumNumberHoldDays).toBe(30);
    expect(config.maxEmailAttachmentBytes).toBe(18_000_000);
    expect(config.retention).toEqual({ mode: "forever" });
  });

  it("keeps the Wrangler template generic and includes every production binding", () => {
    const template = readFileSync(".wrangler.production.example.jsonc", "utf8");

    expect(template).toContain('"binding": "DB"');
    expect(template).toContain('"binding": "DOCUMENTS"');
    expect(template).toContain('"name": "EMAIL"');
    expect(template).toContain('"binding": "OUTBOUND_FAX_WORKFLOW"');
    expect(template).toContain('"binding": "NUMBER_LIFECYCLE_WORKFLOW"');
    expect(template).toContain('"directory": "./dist/client"');
    expect(template).toContain("fax.example.com");
    expect(template).toContain("00000000-0000-0000-0000-000000000000");
    expect(template).not.toMatch(/drewburchfield|nashburch|family@/i);
  });

  it("runs Wrangler's parser against the production template in the release gate", () => {
    const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
      scripts: Record<string, string>;
    };

    expect(packageJson.scripts["verify:production-template"]).toContain(
      "wrangler deploy --dry-run --config .wrangler.production.example.jsonc",
    );
    expect(packageJson.scripts.verify).toContain("npm run verify:production-template");
  });
});

function parseDotenv(source: string): Record<string, string> {
  return Object.fromEntries(
    source
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"))
      .map((line) => {
        const separator = line.indexOf("=");
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
}
