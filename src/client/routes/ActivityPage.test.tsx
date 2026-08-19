// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { FaxJob, FaxNotification } from "../../shared/contracts";
import { api, type BootstrapResponse } from "../api/client";
import { AppShell } from "../components/AppShell";

afterEach(() => vi.restoreAllMocks());

describe("fax email confirmation status", () => {
  it("shows outbound email failure separately and retries it", async () => {
    const user = userEvent.setup();
    const fax = deliveredFax();
    const failed = notification({ state: "failed", lastError: "email unavailable" });
    vi.spyOn(api, "bootstrap").mockResolvedValue(bootstrap());
    vi.spyOn(api, "getFax")
      .mockResolvedValueOnce({ fax, documents: [], events: [], notifications: [failed] })
      .mockResolvedValueOnce({ fax, documents: [], events: [], notifications: [notification()] });
    const retry = vi.spyOn(api, "retryEmail").mockResolvedValue(notification());
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<MemoryRouter initialEntries={["/activity/fax-1"]}><AppShell /></MemoryRouter>);

    expect(await screen.findByText("Email confirmation failed.")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Retry email delivery" }));

    expect(retry).toHaveBeenCalledWith("fax-1");
    expect(await screen.findByText(/sent to the forwarding email/i)).toBeTruthy();
  });

  it("warns about duplicates when delivery is uncertain", async () => {
    const user = userEvent.setup();
    vi.spyOn(api, "bootstrap").mockResolvedValue(bootstrap());
    vi.spyOn(api, "getFax").mockResolvedValue({
      fax: deliveredFax(),
      documents: [],
      events: [],
      notifications: [notification({ state: "delivery_unknown" })],
    });
    vi.spyOn(api, "retryEmail").mockResolvedValue(notification());
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<MemoryRouter initialEntries={["/activity/fax-1"]}><AppShell /></MemoryRouter>);

    expect(await screen.findByText(/may already have been accepted/i)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Retry email delivery" }));

    expect(confirm).toHaveBeenCalledWith(expect.stringMatching(/duplicate message/i));
    expect(api.retryEmail).not.toHaveBeenCalled();
  });
});

function bootstrap(): BootstrapResponse {
  return {
    config: {
      appName: "Family Fax",
      provider: "demo",
      isDemo: true,
      defaultPhoneCountry: "US",
      defaultForwardEmail: "family@example.com",
      preferredAreaCodes: ["615"],
      defaultTtlDays: 3,
      ttlPresets: [1, 3, 7],
      maxTtlDays: 365,
      defaultRentalMonths: 1,
      householdLineId: null,
      rentalMonthPresets: [1, 2, 3],
      maxRentalMonths: 12,
      minimumNumberHoldDays: 0,
      retention: { mode: "forever" },
      logDetail: "full",
      limits: { maxUploadBytes: 26_214_400, maxFaxPages: 100 },
    },
    identity: { email: "local", subject: "development" },
    activeNumbers: [],
    recentFaxes: [],
    templates: [],
  };
}

function deliveredFax(): FaxJob {
  return {
    id: "fax-1",
    mode: "send-only",
    direction: "outbound",
    state: "delivered",
    toNumber: "+16155550123",
    fromNumber: "+16155550199",
    providerFaxId: "provider-fax-1",
    providerProjectId: null,
    temporaryNumberId: "number-1",
    correlationId: "correlation-1",
    finalDocumentId: "document-1",
    pageCount: 2,
    estimatedCost: null,
    reportedCost: null,
    requestedTtlDays: null,
    requestedRentalMonths: null,
    coverData: null,
    failureCode: null,
    failureMessage: null,
    createdAt: "2026-08-18T03:40:00.000Z",
    updatedAt: "2026-08-18T03:47:05.000Z",
    submittedAt: "2026-08-18T03:41:00.000Z",
    completedAt: "2026-08-18T03:47:05.000Z",
  };
}

function notification(overrides: Partial<FaxNotification> = {}): FaxNotification {
  return {
    faxJobId: "fax-1",
    kind: "outbound_delivered",
    state: "delivered",
    destinationEmail: "family@example.com",
    attempt: 1,
    messageId: "message-1",
    attached: true,
    lastError: null,
    createdAt: "2026-08-18T03:47:05.000Z",
    updatedAt: "2026-08-18T03:47:05.000Z",
    deliveredAt: "2026-08-18T03:47:05.000Z",
    ...overrides,
  };
}
