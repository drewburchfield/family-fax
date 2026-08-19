// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { FaxJob, TemporaryNumber } from "../../shared/contracts";
import { api, type BootstrapResponse } from "../api/client";
import { AppShell } from "../components/AppShell";

afterEach(() => vi.restoreAllMocks());

describe("ReceivePage", () => {
  it("shows household line facts and only that line's recent inbound activity", async () => {
    const line = number();
    vi.spyOn(api, "bootstrap").mockResolvedValue(bootstrap(
      [line],
      [
        fax({ id: "inbound-family", direction: "inbound", temporaryNumberId: line.id, fromNumber: "+12025550123" }),
        fax({ id: "outbound-family", direction: "outbound", temporaryNumberId: line.id, toNumber: "+13105550111" }),
        fax({ id: "inbound-other", direction: "inbound", temporaryNumberId: "other-line", fromNumber: "+14045550111" }),
      ],
    ));
    render(<MemoryRouter initialEntries={["/receive"]}><AppShell /></MemoryRouter>);

    expect(await screen.findByRole("heading", { name: "Receive a fax" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "+1 (615) 555-0199" })).toBeTruthy();
    expect(screen.getByText("family@example.com")).toBeTruthy();
    expect(screen.getByText(/scheduled for/i)).toBeTruthy();
    expect(screen.getByText("+1 (202) 555-0123")).toBeTruthy();
    expect(screen.queryByText("+1 (404) 555-0111")).toBeNull();
    expect(screen.queryByText("+1 (310) 555-0111")).toBeNull();
  });

  it("keeps an expiring receiving line visible with a release warning", async () => {
    const expiring = number({ state: "expiring" });
    vi.spyOn(api, "bootstrap").mockResolvedValue(bootstrap([expiring], []));
    render(<MemoryRouter initialEntries={["/receive"]}><AppShell /></MemoryRouter>);

    expect((await screen.findByRole("alert")).textContent).toMatch(/scheduled for release/i);
    expect(screen.getByRole("heading", { name: "+1 (615) 555-0199" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /search preferred area codes/i })).toBeNull();
  });

  it("resumes an in-progress household line instead of offering another rental", async () => {
    const pending = number({
      state: "provisioning",
      e164: "+16295550199",
      provisionedAt: null,
    });
    vi.spyOn(api, "bootstrap").mockResolvedValue(bootstrap([pending], []));
    vi.spyOn(api, "getNumber").mockResolvedValue(pending);
    render(<MemoryRouter initialEntries={["/receive"]}><AppShell /></MemoryRouter>);

    expect(await screen.findByRole("heading", { name: "Opening the fax line" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /search preferred area codes/i })).toBeNull();
  });
});

function bootstrap(activeNumbers: TemporaryNumber[], recentFaxes: FaxJob[]): BootstrapResponse {
  return {
    config: {
      appName: "Family Fax",
      provider: "signalwire",
      isDemo: false,
      defaultPhoneCountry: "US",
      defaultForwardEmail: "family@example.com",
      preferredAreaCodes: ["615", "629"],
      defaultTtlDays: 3,
      ttlPresets: [1, 3, 7],
      maxTtlDays: 365,
      defaultRentalMonths: 1,
      householdLineId: "household-line",
      rentalMonthPresets: [1, 2, 3],
      maxRentalMonths: 12,
      minimumNumberHoldDays: 14,
      retention: { mode: "forever" },
      logDetail: "full",
      limits: { maxUploadBytes: 26_214_400, maxFaxPages: 100 },
    },
    identity: { email: "family@example.com", subject: "family" },
    activeNumbers,
    recentFaxes,
    templates: [],
  };
}

function number(overrides: Partial<TemporaryNumber> = {}): TemporaryNumber {
  return {
    id: "household-line",
    faxJobId: "setup-fax",
    e164: "+16155550199",
    areaCode: "615",
    providerId: "provider-household-line",
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
    workflowId: "line-workflow",
    createdAt: "2026-08-01T12:00:00.000Z",
    updatedAt: "2026-08-01T12:00:00.000Z",
    ...overrides,
  };
}

function fax(overrides: Partial<FaxJob> = {}): FaxJob {
  return {
    id: "fax",
    mode: "receive-only",
    direction: "inbound",
    state: "delivered",
    toNumber: "+16155550199",
    fromNumber: "+12025550123",
    providerFaxId: "provider-fax",
    providerProjectId: null,
    temporaryNumberId: "household-line",
    correlationId: "correlation-fax",
    finalDocumentId: "document-fax",
    pageCount: 1,
    estimatedCost: null,
    reportedCost: null,
    requestedTtlDays: null,
    requestedRentalMonths: null,
    coverData: null,
    failureCode: null,
    failureMessage: null,
    createdAt: "2026-08-17T12:00:00.000Z",
    updatedAt: "2026-08-17T12:00:00.000Z",
    submittedAt: null,
    completedAt: "2026-08-17T12:00:00.000Z",
    ...overrides,
  };
}
