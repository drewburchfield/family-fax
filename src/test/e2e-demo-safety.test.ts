import { describe, expect, it } from "vitest";

import { assertDemoBootstrap } from "./e2e-demo-safety";

describe("assertDemoBootstrap", () => {
  it("accepts only a consistent demo bootstrap", () => {
    expect(() => assertDemoBootstrap({ config: { provider: "demo", isDemo: true } })).not.toThrow();
    expect(() => assertDemoBootstrap({ config: { provider: "signalwire", isDemo: false } })).toThrow(
      /refusing mutations for provider=signalwire/i,
    );
    expect(() => assertDemoBootstrap({ config: { provider: "demo", isDemo: false } })).toThrow(
      /provider=demo isDemo=false/i,
    );
  });
});
