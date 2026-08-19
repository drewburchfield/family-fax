import { defineConfig, devices } from "@playwright/test";

const e2ePersistPath = `.wrangler/e2e-${process.pid}`;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  retries: 1,
  reporter: "html",
  use: {
    baseURL: "http://127.0.0.1:5173",
    trace: "retain-on-failure",
  },
  webServer: {
    command: `npx wrangler d1 migrations apply DB --local --config e2e/wrangler.jsonc --persist-to ${e2ePersistPath} && npm run dev -- --host 127.0.0.1`,
    env: {
      FAMILY_FAX_PERSIST_PATH: e2ePersistPath,
      FAMILY_FAX_WRANGLER_CONFIG_PATH: "e2e/wrangler.jsonc",
    },
    url: "http://127.0.0.1:5173",
    reuseExistingServer: false,
    timeout: 120_000,
  },
  projects: [
    { name: "desktop-chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile-chromium", use: { ...devices["Pixel 7"] } },
  ],
});
