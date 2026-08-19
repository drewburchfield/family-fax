import { describe, expect, it } from "vitest";

import { canTransitionNumber, transitionNumber } from "./number-state";

describe("temporary number state transitions", () => {
  it("supports provision, expiration, and release", () => {
    expect(canTransitionNumber("requested", "provisioning")).toBe(true);
    expect(canTransitionNumber("provisioning", "activating")).toBe(true);
    expect(canTransitionNumber("activating", "active")).toBe(true);
    expect(canTransitionNumber("active", "expiring")).toBe(true);
    expect(canTransitionNumber("expiring", "releasing")).toBe(true);
    expect(canTransitionNumber("releasing", "released")).toBe(true);
  });

  it("supports extension while expiring", () => {
    expect(canTransitionNumber("expiring", "active")).toBe(true);
  });

  it("supports retrying a failed release", () => {
    expect(canTransitionNumber("releasing", "release_failed")).toBe(true);
    expect(canTransitionNumber("release_failed", "releasing")).toBe(true);
  });

  it("can surface a requested number whose cleanup failed", () => {
    expect(canTransitionNumber("requested", "release_failed")).toBe(true);
    expect(canTransitionNumber("provisioning", "release_failed")).toBe(true);
    expect(canTransitionNumber("provisioning", "cleaning")).toBe(true);
    expect(canTransitionNumber("cleaning", "provision_failed")).toBe(true);
  });

  it("keeps a released number terminal", () => {
    expect(canTransitionNumber("released", "active")).toBe(false);
    expect(() => transitionNumber("released", "active")).toThrow(
      "Invalid number transition: released -> active",
    );
  });
});
