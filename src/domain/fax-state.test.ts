import { describe, expect, it } from "vitest";

import { canTransitionFax, transitionFax } from "./fax-state";

describe("fax state transitions", () => {
  it("supports the normal outbound lifecycle", () => {
    const path = [
      ["draft", "preparing"],
      ["preparing", "prepared"],
      ["prepared", "provisioning"],
      ["provisioning", "submitting"],
      ["submitting", "submitted"],
      ["submitted", "sending"],
      ["sending", "delivered"],
    ] as const;

    for (const [from, to] of path) {
      expect(canTransitionFax(from, to)).toBe(true);
    }
  });

  it("supports receive-only activation and completion", () => {
    expect(canTransitionFax("provisioning", "active")).toBe(true);
    expect(canTransitionFax("active", "completed")).toBe(true);
  });

  it("allows reconciliation from an ambiguous submission", () => {
    expect(canTransitionFax("submitting", "status_unknown")).toBe(true);
    expect(canTransitionFax("status_unknown", "submitted")).toBe(true);
    expect(canTransitionFax("status_unknown", "delivered")).toBe(true);
    expect(canTransitionFax("status_unknown", "failed")).toBe(true);
  });

  it("rejects replay and terminal-state transitions", () => {
    expect(canTransitionFax("status_unknown", "submitting")).toBe(false);
    expect(canTransitionFax("delivered", "submitting")).toBe(false);
    expect(() => transitionFax("delivered", "sending")).toThrow(
      "Invalid fax transition: delivered -> sending",
    );
  });
});
