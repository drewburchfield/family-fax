// @vitest-environment jsdom

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { TemporaryNumber } from "../../shared/contracts";
import { api, type BootstrapResponse } from "../api/client";
import { AppShell } from "../components/AppShell";

afterEach(() => vi.restoreAllMocks());

describe("FaxLinePage", () => {
  it("shows the primary line first and saves a different primary line", async () => {
    const user = userEvent.setup();
    const primary = number({ id: "primary", e164: "+16155550199", areaCode: "615" });
    const secondary = number({
      id: "secondary",
      e164: "+16295550188",
      areaCode: "629",
      provisionedAt: "2026-08-02T12:00:00.000Z",
    });
    const payload = bootstrap([secondary, primary], primary.id);
    vi.spyOn(api, "bootstrap").mockResolvedValue(payload);
    const save = vi.spyOn(api, "saveSettings").mockResolvedValue({
      defaultForwardEmail: payload.config.defaultForwardEmail,
      preferredAreaCodes: payload.config.preferredAreaCodes,
      defaultTtlDays: payload.config.defaultTtlDays,
      defaultRentalMonths: payload.config.defaultRentalMonths,
      householdLineId: secondary.id,
    });
    render(<MemoryRouter initialEntries={["/fax-line"]}><AppShell /></MemoryRouter>);

    expect(await screen.findByRole("heading", { name: "Household fax line" })).toBeTruthy();
    expect(screen.getByText("Primary household line")).toBeTruthy();
    expect(screen.getByText("+1 (615) 555-0199")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /make primary.*629.*555-0188/i }));

    await waitFor(() => expect(save).toHaveBeenCalledWith(expect.objectContaining({
      householdLineId: secondary.id,
      defaultForwardEmail: "family@example.com",
    })));
  });

  it("owns forwarding, area-code, and default-term preferences", async () => {
    const user = userEvent.setup();
    const payload = bootstrap([number()], "line");
    vi.spyOn(api, "bootstrap").mockResolvedValue(payload);
    const updateForwarding = vi.spyOn(api, "updateNumberForwardingEmail").mockResolvedValue({
      ...payload.activeNumbers[0]!,
      forwardingEmail: "new-family@example.com",
    });
    const save = vi.spyOn(api, "saveSettings").mockResolvedValue({
      defaultForwardEmail: "new-family@example.com",
      preferredAreaCodes: ["629", "615"],
      defaultTtlDays: 3,
      defaultRentalMonths: 2,
      householdLineId: "line",
    });
    render(<MemoryRouter initialEntries={["/fax-line"]}><AppShell /></MemoryRouter>);

    const forwardingInput = await screen.findByLabelText(/Forward incoming faxes to/);
    await user.clear(forwardingInput);
    expect((forwardingInput as HTMLInputElement).value).toBe("");
    await user.type(forwardingInput, "new-family@example.com");
    await user.clear(screen.getByLabelText(/Preferred area codes/));
    await user.type(screen.getByLabelText(/Preferred area codes/), "629, 615");
    await user.clear(screen.getByLabelText(/Default number term/));
    await user.type(screen.getByLabelText(/Default number term/), "2");
    await user.click(screen.getByRole("button", { name: "Save line defaults" }));

    await waitFor(() => expect(updateForwarding).toHaveBeenCalledWith(
      "line",
      "new-family@example.com",
    ));
    await waitFor(() => expect(save).toHaveBeenCalledWith(expect.objectContaining({
      defaultForwardEmail: "new-family@example.com",
      preferredAreaCodes: ["629", "615"],
      defaultRentalMonths: 2,
      householdLineId: "line",
    })));
  });

  it("uses the primary line's current route when the saved default is stale", async () => {
    const user = userEvent.setup();
    const payload = bootstrap([number({ forwardingEmail: "actual-route@example.com" })], "line");
    vi.spyOn(api, "bootstrap").mockResolvedValue(payload);
    const updateForwarding = vi.spyOn(api, "updateNumberForwardingEmail");
    const save = vi.spyOn(api, "saveSettings").mockResolvedValue({
      defaultForwardEmail: "actual-route@example.com",
      preferredAreaCodes: ["629", "615"],
      defaultTtlDays: 3,
      defaultRentalMonths: 1,
      householdLineId: "line",
    });
    render(<MemoryRouter initialEntries={["/fax-line"]}><AppShell /></MemoryRouter>);

    expect((await screen.findByLabelText(/Forward incoming faxes to/) as HTMLInputElement).value).toBe(
      "actual-route@example.com",
    );
    await user.clear(screen.getByLabelText(/Preferred area codes/));
    await user.type(screen.getByLabelText(/Preferred area codes/), "629, 615");
    await user.click(screen.getByRole("button", { name: "Save line defaults" }));

    await waitFor(() => expect(save).toHaveBeenCalled());
    expect(updateForwarding).not.toHaveBeenCalled();
  });

  it("resumes an in-progress household line after a reload", async () => {
    const pending = number({
      id: "pending-line",
      state: "provisioning",
      e164: "+16295550199",
      provisionedAt: null,
    });
    const payload = bootstrap([pending], null);
    vi.spyOn(api, "bootstrap").mockResolvedValue(payload);
    vi.spyOn(api, "getNumber").mockResolvedValue(pending);
    render(<MemoryRouter initialEntries={["/fax-line"]}><AppShell /></MemoryRouter>);

    expect(await screen.findByRole("heading", { name: "Opening the fax line" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /search preferred area codes/i })).toBeNull();
  });
});

function bootstrap(activeNumbers: TemporaryNumber[], householdLineId: string | null): BootstrapResponse {
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
      householdLineId,
      rentalMonthPresets: [1, 2, 3],
      maxRentalMonths: 12,
      minimumNumberHoldDays: 14,
      retention: { mode: "forever" },
      logDetail: "full",
      limits: { maxUploadBytes: 26_214_400, maxFaxPages: 100 },
    },
    identity: { email: "family@example.com", subject: "family" },
    activeNumbers,
    recentFaxes: [],
    templates: [],
  };
}

function number(overrides: Partial<TemporaryNumber> = {}): TemporaryNumber {
  return {
    id: "line",
    faxJobId: "setup-fax",
    e164: "+16155550199",
    areaCode: "615",
    providerId: "provider-line",
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
