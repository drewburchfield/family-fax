// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PDFDocument } from "pdf-lib";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { FaxJob, TemporaryNumber } from "../../shared/contracts";
import { api, type BootstrapResponse } from "../api/client";
import { AppShell } from "../components/AppShell";

afterEach(() => vi.restoreAllMocks());

describe("household line send flow", () => {
  it("defaults to +1 and sends from the sole active family line without inventory search", async () => {
    const user = userEvent.setup();
    setupApi([activeNumber()]);
    const search = vi.spyOn(api, "searchNumbers");
    const start = vi.spyOn(api, "startFaxWithExistingNumber").mockResolvedValue({
      fax: { ...fax(), state: "submitting" },
      workflowId: "workflow-1",
    });
    render(<MemoryRouter initialEntries={["/send"]}><AppShell /></MemoryRouter>);

    expect(await screen.findByText("+1")).toBeTruthy();
    await buildPacket("6155550123");

    expect(await screen.findByText("Send from")).toBeTruthy();
    expect(screen.getByText("+1 (615) 555-0199")).toBeTruthy();
    expect(search).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Send fax" }));

    expect(start).toHaveBeenCalledWith("fax-1", "number-existing");
    expect(await screen.findByRole("heading", { name: /fax is on its way/i })).toBeTruthy();
  });

  it("keeps packet-defining controls locked after preview", async () => {
    setupApi([activeNumber()]);
    render(<MemoryRouter initialEntries={["/send"]}><AppShell /></MemoryRouter>);

    await buildPacket("6155550123");
    await screen.findByRole("button", { name: "Send fax" });

    expect((screen.getByLabelText("Fax number") as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText("Country") as unknown as HTMLSelectElement).disabled).toBe(true);
    expect((screen.getByLabelText("Recipient") as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText("Add PDF or photos") as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Remove records.pdf" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("offers a small chooser when several retained lines are active", async () => {
    setupApi([
      activeNumber(),
      activeNumber({ id: "number-secondary", e164: "+16295550123", provisionedAt: "2026-08-02T12:00:00.000Z" }),
    ]);
    render(<MemoryRouter initialEntries={["/send"]}><AppShell /></MemoryRouter>);

    await buildPacket("6155550123");

    const selector = await screen.findByLabelText("Sending line");
    expect(within(selector).getAllByRole("option")).toHaveLength(2);
  });

  it("preserves the prepared fax and opens line setup when no active line exists", async () => {
    setupApi([]);
    const search = vi.spyOn(api, "searchNumbers");
    render(<MemoryRouter initialEntries={["/send"]}><AppShell /></MemoryRouter>);

    await buildPacket("6155550123");

    expect(await screen.findByRole("heading", { name: "Open a line, then send" })).toBeTruthy();
    expect(search).not.toHaveBeenCalled();
  });
});

function setupApi(activeNumbers: TemporaryNumber[]) {
  vi.spyOn(api, "bootstrap").mockResolvedValue(bootstrap(activeNumbers));
  vi.spyOn(api, "createFax").mockResolvedValue(fax());
  vi.spyOn(api, "uploadDocument").mockImplementation(async (_faxId, documentId) => ({ id: documentId }));
  vi.spyOn(api, "prepareFax").mockResolvedValue({ ...fax(), state: "prepared" });
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:fax-preview");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
}

async function buildPacket(destination: string) {
  fireEvent.change(await screen.findByLabelText("Fax number"), { target: { value: destination } });
  const document = await PDFDocument.create();
  document.addPage();
  const saved = await document.save();
  const fileBuffer = new ArrayBuffer(saved.byteLength);
  new Uint8Array(fileBuffer).set(saved);
  fireEvent.change(screen.getByLabelText("Add PDF or photos"), {
    target: { files: [new File([fileBuffer], "records.pdf", { type: "application/pdf" })] },
  });
  await waitFor(() => expect((screen.getByRole("button", { name: "Prepare and preview" }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole("button", { name: "Prepare and preview" }));
  await waitFor(() => expect(api.prepareFax).toHaveBeenCalledOnce());
}

function bootstrap(activeNumbers: TemporaryNumber[]): BootstrapResponse {
  return {
    config: {
      appName: "Family Fax",
      provider: "demo",
      isDemo: true,
      defaultPhoneCountry: "US",
      defaultForwardEmail: "fax@example.com",
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
    activeNumbers,
    recentFaxes: [],
    templates: [],
  };
}

function activeNumber(overrides: Partial<TemporaryNumber> = {}): TemporaryNumber {
  return {
    id: "number-existing",
    faxJobId: "receive-job",
    e164: "+16155550199",
    areaCode: "615",
    providerId: "provider-number-existing",
    providerName: "demo",
    state: "active",
    mode: "receive-only",
    forwardingEmail: "fax@example.com",
    setupPrice: null,
    monthlyPrice: { amount: "0.50", currency: "USD", intervalMonths: 1 },
    provisionedAt: "2026-08-01T12:00:00.000Z",
    earliestProviderReleaseAt: null,
    releasePolicy: "scheduled",
    rentalMonths: 1,
    nextBilledAt: "2026-09-01T12:00:00.000Z",
    releaseAt: "2026-09-01T11:00:00.000Z",
    expiresAt: "2026-09-01T11:00:00.000Z",
    releaseStartedAt: null,
    releasedAt: null,
    workflowId: "number-workflow",
    createdAt: "2026-08-01T12:00:00.000Z",
    updatedAt: "2026-08-01T12:00:00.000Z",
    ...overrides,
  };
}

function fax(): FaxJob {
  return {
    id: "fax-1",
    mode: "send-only",
    direction: "outbound",
    state: "draft",
    toNumber: "+16155550123",
    fromNumber: null,
    providerFaxId: null,
    providerProjectId: null,
    temporaryNumberId: null,
    correlationId: "correlation-1",
    finalDocumentId: null,
    pageCount: null,
    estimatedCost: null,
    reportedCost: null,
    requestedTtlDays: null,
    requestedRentalMonths: null,
    coverData: null,
    failureCode: null,
    failureMessage: null,
    createdAt: "2026-08-16T12:00:00.000Z",
    updatedAt: "2026-08-16T12:00:00.000Z",
    submittedAt: null,
    completedAt: null,
  };
}
