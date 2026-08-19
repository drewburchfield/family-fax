import { describe, expect, it } from "vitest";

import type { TemporaryNumber } from "../../shared/contracts";
import {
  eligibleHouseholdLines,
  pendingHouseholdLine,
  selectHouseholdLine,
  visibleReceivingLine,
} from "./household-line";

describe("household fax line selection", () => {
  it("keeps only active retained numbers owned by the configured provider", () => {
    const numbers = [
      number({ id: "one-time", releasePolicy: "after-send" }),
      number({ id: "other-provider", providerName: "sinch" }),
      number({ id: "expiring", state: "expiring" }),
      number({ id: "family", releasePolicy: "manual" }),
    ];

    expect(eligibleHouseholdLines(numbers, "signalwire").map((item) => item.id)).toEqual([
      "family",
    ]);
  });

  it("honors the stored primary line and otherwise chooses the oldest eligible line", () => {
    const older = number({ id: "older", provisionedAt: "2026-08-01T12:00:00.000Z" });
    const newer = number({ id: "newer", provisionedAt: "2026-08-02T12:00:00.000Z" });

    expect(selectHouseholdLine([newer, older], "signalwire", "newer")?.id).toBe("newer");
    expect(selectHouseholdLine([newer, older], "signalwire", "missing")?.id).toBe("older");
  });

  it("keeps an expiring line visible for receiving without making it reusable for sending", () => {
    const expiring = number({ id: "expiring", state: "expiring" });

    expect(selectHouseholdLine([expiring], "signalwire", null)).toBeNull();
    expect(visibleReceivingLine([expiring], "signalwire", null)?.id).toBe("expiring");
  });

  it("surfaces the oldest retained line request while the provider is opening it", () => {
    const pending = number({
      id: "pending",
      state: "provisioning",
      e164: "+16295550199",
      provisionedAt: null,
    });

    expect(pendingHouseholdLine([pending], "signalwire")?.id).toBe("pending");
    expect(pendingHouseholdLine([{ ...pending, mode: "send-only" }], "signalwire")).toBeNull();
  });
});

function number(overrides: Partial<TemporaryNumber> = {}): TemporaryNumber {
  return {
    id: "number-1",
    faxJobId: "setup-fax",
    e164: "+16155550123",
    areaCode: "615",
    providerId: "provider-number-1",
    providerName: "signalwire",
    state: "active",
    mode: "receive-only",
    forwardingEmail: "family@example.com",
    setupPrice: null,
    monthlyPrice: { amount: "0.50", currency: "USD", intervalMonths: 1 },
    provisionedAt: "2026-08-01T12:00:00.000Z",
    earliestProviderReleaseAt: "2026-08-15T12:00:00.000Z",
    releasePolicy: "scheduled",
    rentalMonths: 1,
    nextBilledAt: "2026-09-01T12:00:00.000Z",
    releaseAt: "2026-09-01T11:00:00.000Z",
    expiresAt: "2026-09-01T11:00:00.000Z",
    releaseStartedAt: null,
    releasedAt: null,
    workflowId: "workflow-1",
    createdAt: "2026-08-01T12:00:00.000Z",
    updatedAt: "2026-08-01T12:00:00.000Z",
    ...overrides,
  };
}
