// @vitest-environment jsdom

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { FaxJob, TemporaryNumber } from "../../shared/contracts";
import { api, type NumberCandidate } from "../api/client";
import { LineSetup } from "./LineSetup";

const familyFax = vi.hoisted(() => ({
  bootstrap: {
    config: {
      defaultForwardEmail: "family@example.com",
      defaultRentalMonths: 1,
      rentalMonthPresets: [1, 2, 3],
      preferredAreaCodes: ["615", "629"],
      minimumNumberHoldDays: 14,
    },
  },
}));

vi.mock("./AppShell", () => ({ useFamilyFax: () => familyFax }));
vi.mock("../api/client", async (loadOriginal) => {
  const original = await loadOriginal<typeof import("../api/client")>();
  return {
    ...original,
    api: {
      ...original.api,
      createFax: vi.fn(),
      prepareFax: vi.fn(),
      searchNumbers: vi.fn(),
      startFax: vi.fn(),
      cancelFax: vi.fn(),
      getNumber: vi.fn(),
    },
  };
});

afterEach(() => vi.clearAllMocks());

describe("LineSetup", () => {
  it("opens a confirmed receive-only household line", async () => {
    const user = userEvent.setup();
    const onStarted = vi.fn();
    const selected = candidate();
    vi.mocked(api.createFax).mockResolvedValue(faxJob());
    vi.mocked(api.prepareFax).mockResolvedValue({ ...faxJob(), state: "prepared" });
    vi.mocked(api.searchNumbers).mockResolvedValue({ candidates: [selected] });
    vi.mocked(api.startFax).mockResolvedValue({ number: activeNumber() });

    render(<LineSetup purpose="household-line" onStarted={onStarted} />);

    await user.click(screen.getByRole("button", { name: /search preferred area codes/i }));
    await user.click(await screen.findByRole("button", { name: /629.*555-0199/i }));
    await user.click(screen.getByRole("checkbox", { name: /understand this can create a charge/i }));
    await user.click(screen.getByRole("button", { name: /confirm and open line/i }));

    expect(api.createFax).toHaveBeenCalledWith(expect.objectContaining({
      mode: "receive-only",
      toNumber: null,
      requestedRentalMonths: 1,
    }));
    expect(api.prepareFax).toHaveBeenCalledWith("setup-fax", null, null);
    expect(api.searchNumbers).toHaveBeenCalledWith(["615", "629"]);
    expect(api.startFax).toHaveBeenCalledWith("setup-fax", selected, "family@example.com");
    await waitFor(() => expect(onStarted).toHaveBeenCalledWith(
      expect.objectContaining({ releasePolicy: "scheduled", state: "active" }),
      "setup-fax",
    ));
  });
});

function candidate(): NumberCandidate {
  return {
    e164: "+16295550199",
    areaCode: "629",
    countryCode: "US",
    type: "LOCAL",
    capabilities: ["FAX"],
    setupPrice: null,
    monthlyPrice: { amount: "0.50", currency: "USD", intervalMonths: 1 },
    supportingDocumentationRequired: false,
  };
}

function faxJob(): FaxJob {
  return {
    id: "setup-fax",
    mode: "receive-only",
    direction: "none",
    state: "draft",
    toNumber: null,
    fromNumber: null,
    providerFaxId: null,
    providerProjectId: null,
    temporaryNumberId: null,
    correlationId: "correlation-setup",
    finalDocumentId: null,
    pageCount: null,
    estimatedCost: null,
    reportedCost: null,
    requestedTtlDays: null,
    requestedRentalMonths: 1,
    coverData: null,
    failureCode: null,
    failureMessage: null,
    createdAt: "2026-08-17T12:00:00.000Z",
    updatedAt: "2026-08-17T12:00:00.000Z",
    submittedAt: null,
    completedAt: null,
  };
}

function activeNumber(): TemporaryNumber {
  return {
    id: "family-line",
    faxJobId: "setup-fax",
    e164: "+16295550199",
    areaCode: "629",
    providerId: "provider-family-line",
    providerName: "signalwire",
    state: "active",
    mode: "receive-only",
    forwardingEmail: "family@example.com",
    setupPrice: null,
    monthlyPrice: { amount: "0.50", currency: "USD", intervalMonths: 1 },
    provisionedAt: "2026-08-17T12:00:00.000Z",
    earliestProviderReleaseAt: "2026-08-31T12:00:00.000Z",
    releasePolicy: "scheduled",
    rentalMonths: 1,
    nextBilledAt: "2026-09-17T12:00:00.000Z",
    releaseAt: "2026-09-17T11:00:00.000Z",
    expiresAt: "2026-09-17T11:00:00.000Z",
    releaseStartedAt: null,
    releasedAt: null,
    workflowId: "workflow-family-line",
    createdAt: "2026-08-17T12:00:00.000Z",
    updatedAt: "2026-08-17T12:00:00.000Z",
  };
}
