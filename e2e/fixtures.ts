import { expect, test as base } from "@playwright/test";

import { assertDemoBootstrap } from "../src/test/e2e-demo-safety";

type DemoSafetyFixture = {
  demoSafety: void;
};

export const test = base.extend<DemoSafetyFixture>({
  demoSafety: [
    async ({ request }, use) => {
      const response = await request.get("/api/bootstrap");
      if (!response.ok()) {
        throw new Error(`E2E safety check failed: /api/bootstrap returned HTTP ${response.status()}.`);
      }
      assertDemoBootstrap(await response.json());
      await use();
    },
    { auto: true },
  ],
});

export { expect };
