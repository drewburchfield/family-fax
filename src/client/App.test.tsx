// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "./App";
import { ConfirmCost } from "./components/ConfirmCost";
import { NumberCard } from "./components/NumberCard";
import { StatusBadge } from "./components/StatusBadge";

describe("Family Fax application", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "/");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("leads with the two household fax tasks", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(bootstrapPayload())));
    render(<App />);

    expect(await screen.findByRole("link", { name: /send a fax/i })).toBeTruthy();
    expect(screen.getByRole("link", { name: /receive a fax/i })).toBeTruthy();
    expect(screen.queryByRole("link", { name: /send and receive/i })).toBeNull();
  });

  it("links household line management from the main navigation", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(bootstrapPayload())));
    render(<App />);

    expect((await screen.findByRole("link", { name: "Fax line" })).getAttribute("href")).toBe(
      "/fax-line",
    );
  });

  it("offers a visible recovery action when startup fails", async () => {
    const user = userEvent.setup();
    const fetcher = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(Response.json(bootstrapPayload()));
    vi.stubGlobal("fetch", fetcher);
    render(<App />);

    expect(await screen.findByRole("alert")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /try again/i }));
    expect(await screen.findByRole("link", { name: /send a fax/i })).toBeTruthy();
  });

  it("keeps the usable app visible when a later refresh fails", async () => {
    const user = userEvent.setup();
    window.history.replaceState({}, "", "/fax-line");
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(Response.json(bootstrapPayload()))
      .mockResolvedValueOnce(Response.json({
        defaultForwardEmail: "fax@example.com",
        preferredAreaCodes: ["615", "629"],
        defaultTtlDays: 3,
        defaultRentalMonths: 1,
        householdLineId: null,
      }))
      .mockRejectedValueOnce(new Error("refresh offline"));
    vi.stubGlobal("fetch", fetcher);
    render(<App />);

    await user.click(await screen.findByRole("button", { name: /save line defaults/i }));

    expect(await screen.findByText(/latest status could not be loaded/i)).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Household fax line" })).toBeTruthy();
    expect(screen.queryByText(/family fax is not reachable/i)).toBeNull();
  });

  it("names SignalWire in the live provider status", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(bootstrapPayload({
      provider: "signalwire",
      isDemo: false,
    }))));
    render(<App />);

    expect(await screen.findByText("SignalWire connected")).toBeTruthy();
  });
});

describe("critical status and price language", () => {
  it("requires a direct confirmation of the provider billing unit", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(
      <ConfirmCost
        number="+1 615 555 0100"
        setupPrice={null}
        monthlyPrice={{ amount: "1.00", currency: "USD", intervalMonths: 1 }}
        onConfirm={onConfirm}
        onCancel={() => undefined}
      />,
    );

    expect(screen.getAllByText(/monthly rental/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/may not prorate the current month/i)).toBeTruthy();
    await user.click(screen.getByRole("checkbox", { name: /understand this can create a charge/i }));
    await user.click(screen.getByRole("button", { name: /provision this number/i }));
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it("discloses SignalWire's minimum number hold before purchase", () => {
    render(
      <ConfirmCost
        number="+1 615 555 0100"
        setupPrice={null}
        monthlyPrice={{ amount: "0.50", currency: "USD", intervalMonths: 1 }}
        minimumNumberHoldDays={30}
        onConfirm={() => undefined}
        onCancel={() => undefined}
      />,
    );

    expect(screen.getByText(/cannot release this number for 30 days/i)).toBeTruthy();
  });

  it("blocks provisioning when no configured monthly estimate is available", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(
      <ConfirmCost
        number="+1 615 555 0100"
        setupPrice={null}
        monthlyPrice={null}
        onConfirm={onConfirm}
        onCancel={() => undefined}
      />,
    );

    expect(screen.getByText(/no monthly rental estimate is configured/i)).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: /understand this can create a charge/i }).hasAttribute("disabled")).toBe(true);
    await user.click(screen.getByRole("button", { name: /provision this number/i }));
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("requires confirmation again when the selected quote changes", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    const { rerender } = render(
      <ConfirmCost
        number="+1 615 555 0100"
        setupPrice={null}
        monthlyPrice={{ amount: "1.00", currency: "USD", intervalMonths: 1 }}
        onConfirm={onConfirm}
        onCancel={() => undefined}
      />,
    );
    await user.click(screen.getByRole("checkbox", { name: /understand this can create a charge/i }));

    rerender(
      <ConfirmCost
        number="+1 629 555 0100"
        setupPrice={null}
        monthlyPrice={{ amount: "0.50", currency: "USD", intervalMonths: 1 }}
        onConfirm={onConfirm}
        onCancel={() => undefined}
      />,
    );

    expect((screen.getByRole("checkbox", { name: /understand this can create a charge/i }) as HTMLInputElement).checked).toBe(false);
    expect((screen.getByRole("button", { name: /provision this number/i }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows an active number with its scheduled release", () => {
    render(
      <NumberCard
        number={{
          id: "number-1",
          faxJobId: "fax-1",
          e164: "+16155550100",
          areaCode: "615",
          providerId: "+16155550100",
          releasePolicy: "scheduled",
          state: "active",
          mode: "receive-only",
          forwardingEmail: "fax@example.com",
          setupPrice: null,
          monthlyPrice: { amount: "1.00", currency: "USD", intervalMonths: 1 },
          provisionedAt: "2026-08-16T12:00:00.000Z",
          earliestProviderReleaseAt: null,
          releaseAt: "2026-08-19T12:00:00.000Z",
          expiresAt: "2026-08-19T12:00:00.000Z",
          releaseStartedAt: null,
          releasedAt: null,
          workflowId: "workflow-1",
          createdAt: "2026-08-16T12:00:00.000Z",
          updatedAt: "2026-08-16T12:00:00.000Z",
        }}
        now={new Date("2026-08-17T12:00:00.000Z")}
      />,
    );

    expect(screen.getByText("+1 (615) 555-0100")).toBeTruthy();
    expect(screen.getByText(/scheduled release/i)).toBeTruthy();
  });

  it("shows the next billing date for a manually retained number", () => {
    const number = {
      id: "number-hours",
      faxJobId: "fax-hours",
      e164: "+16155550100",
      areaCode: "615",
      providerId: "+16155550100",
      releasePolicy: "manual" as const,
      state: "active" as const,
      mode: "receive-only" as const,
      forwardingEmail: "fax@example.com",
      setupPrice: null,
      monthlyPrice: null,
      provisionedAt: "2026-08-16T12:00:00.000Z",
      earliestProviderReleaseAt: null,
      nextBilledAt: "2026-09-16T17:00:00.000Z",
      releaseAt: null,
      expiresAt: null,
      releaseStartedAt: null,
      releasedAt: null,
      workflowId: "workflow-hours",
      createdAt: "2026-08-16T12:00:00.000Z",
      updatedAt: "2026-08-16T12:00:00.000Z",
    };

    render(<NumberCard number={number} now={new Date("2026-08-16T12:00:00.000Z")} />);

    expect(screen.getByText(/kept until you release it/i)).toBeTruthy();
  });

  it("shows the earliest provider release date for a one-time sending number", () => {
    render(
      <NumberCard
        number={{
          id: "number-send-only",
          faxJobId: "fax-send-only",
          e164: "+16155550100",
          areaCode: "615",
          providerId: "provider-send-only",
          providerName: "signalwire",
          releasePolicy: "after-send",
          state: "expiring",
          mode: "send-only",
          forwardingEmail: "fax@example.com",
          setupPrice: null,
          monthlyPrice: { amount: "0.50", currency: "USD", intervalMonths: 1 },
          provisionedAt: "2026-08-16T12:00:00.000Z",
          earliestProviderReleaseAt: "2026-09-15T12:00:00.000Z",
          nextBilledAt: "2026-09-16T12:00:00.000Z",
          releaseAt: "2026-09-15T12:00:00.000Z",
          expiresAt: "2026-09-15T12:00:00.000Z",
          releaseStartedAt: null,
          releasedAt: null,
          workflowId: "number-workflow",
          createdAt: "2026-08-16T12:00:00.000Z",
          updatedAt: "2026-08-16T12:00:00.000Z",
        }}
        now={new Date("2026-08-17T12:00:00.000Z")}
      />,
    );

    expect(screen.getByText(/no earlier than/i)).toBeTruthy();
  });

  it("translates provider state into household language", () => {
    render(<StatusBadge state="status_unknown" />);
    expect(screen.getByText("Needs review")).toBeTruthy();
  });
});

function bootstrapPayload(overrides: { provider?: "demo" | "sinch" | "signalwire"; isDemo?: boolean } = {}) {
  return {
    config: {
      appName: "Family Fax",
      provider: overrides.provider ?? "demo",
      isDemo: overrides.isDemo ?? true,
      defaultPhoneCountry: "US",
      defaultForwardEmail: "fax@example.com",
      preferredAreaCodes: ["615", "629"],
      defaultTtlDays: 3,
      ttlPresets: [1, 3, 7, 14],
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
    identity: { email: "local-family-user", subject: "development" },
    activeNumbers: [],
    recentFaxes: [],
    templates: [],
  };
}
