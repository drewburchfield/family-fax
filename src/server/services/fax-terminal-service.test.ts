import { describe, expect, it, vi } from "vitest";

import { FixedClock } from "../../domain/clock";
import type { FaxDocument, FaxJob, TemporaryNumber } from "../../shared/contracts";
import type { FaxEmailNotifier } from "../notifications/fax-email";
import { MemoryRepository } from "../repositories/memory-repository";
import { MemoryDocumentStore } from "../storage/document-store";
import { AuditService } from "./audit-service";
import type { NotificationService } from "./notification-service";
import type { NumberService } from "./number-service";
import { NotificationService as RealNotificationService } from "./notification-service";
import { FaxTerminalService } from "./fax-terminal-service";

describe("FaxTerminalService", () => {
  it("requests a delivered notification and preserves a retained household line", async () => {
    const fixture = await createFixture(fax(), number());

    const result = await fixture.service.complete("fax-1");

    expect(result).toMatchObject({ notification: { state: "delivered" }, numberState: "active" });
    expect(fixture.notifications.deliver).toHaveBeenCalledWith("fax-1", "outbound_delivered");
    expect(fixture.numbers.releaseNumber).not.toHaveBeenCalled();
  });

  it("releases a one-time number after any terminal outbound result", async () => {
    const fixture = await createFixture(
      fax({ state: "failed" }),
      number({ mode: "send-only", releasePolicy: "after-send" }),
    );

    const result = await fixture.service.complete("fax-1");

    expect(result.numberState).toBe("released");
    expect(fixture.notifications.deliver).not.toHaveBeenCalled();
    expect(fixture.numbers.releaseNumber).toHaveBeenCalledWith("number-1");
  });

  it("does not let notification failure change terminal fax truth", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fixture = await createFixture(fax(), number());
    fixture.notifications.deliver.mockRejectedValueOnce(new Error("notification storage unavailable"));

    await expect(fixture.service.complete("fax-1")).rejects.toThrow("notification storage unavailable");
    expect((await fixture.repository.getFaxJob("fax-1"))?.state).toBe("delivered");
  });

  it("converges concurrent terminal completions on one real email claim", async () => {
    const fixture = await createRealFixture();

    const results = await Promise.all([
      fixture.service.complete("fax-1"),
      fixture.service.complete("fax-1"),
      fixture.service.complete("fax-1"),
    ]);

    expect(results).toHaveLength(3);
    expect(fixture.send).toHaveBeenCalledTimes(1);
    expect(await fixture.repository.getFaxNotification("fax-1", "outbound_delivered")).toMatchObject({
      state: "delivered",
      attempt: 1,
    });
    const events = await fixture.repository.listEventsForFax("fax-1");
    expect(events.filter((event) => event.type === "fax.email_delivered")).toHaveLength(1);
  });
});

async function createRealFixture() {
  const repository = new MemoryRepository();
  const documents = new MemoryDocumentStore();
  const clock = new FixedClock(new Date("2026-08-18T03:47:05.000Z"));
  const audit = new AuditService(repository, documents, clock, () => crypto.randomUUID());
  const send = vi.fn().mockResolvedValue({ messageId: "message-1", attached: true });
  const notifier: FaxEmailNotifier = { send };
  const faxJob = fax();
  const temporaryNumber = number();
  const document: FaxDocument = {
    id: "document-1",
    faxJobId: faxJob.id,
    temporaryNumberId: temporaryNumber.id,
    kind: "final-packet",
    objectKey: "faxes/fax-1/document-1.pdf",
    mimeType: "application/pdf",
    byteCount: 18,
    pageCount: 2,
    sha256: "digest",
    displayName: "fax-packet.pdf",
    createdAt: faxJob.createdAt,
  };
  await repository.createFaxJob(faxJob);
  await repository.createTemporaryNumber(temporaryNumber);
  await repository.createDocument(document);
  await documents.put(document.objectKey, "%PDF-1.7 packet", {
    contentType: document.mimeType,
    sha256: document.sha256,
    uploadedAt: faxJob.createdAt,
  });
  const notifications = new RealNotificationService({
    repository,
    documents,
    audit,
    notifier,
    providerName: "signalwire",
    defaultDestinationEmail: "family@example.com",
    clock,
  });
  const numbers = { releaseNumber: vi.fn<NumberService["releaseNumber"]>() };
  return {
    repository,
    send,
    service: new FaxTerminalService({
      repository,
      notifications,
      numbers,
    }),
  };
}

async function createFixture(faxJob: FaxJob, temporaryNumber: TemporaryNumber) {
  const repository = new MemoryRepository();
  await repository.createFaxJob(faxJob);
  await repository.createTemporaryNumber(temporaryNumber);
  const notifications = {
    deliver: vi.fn<NotificationService["deliver"]>().mockResolvedValue({
      faxJobId: faxJob.id,
      kind: "outbound_delivered",
      state: "delivered",
      destinationEmail: "family@example.com",
      attempt: 1,
      messageId: "message-1",
      attached: true,
      lastError: null,
      createdAt: faxJob.createdAt,
      updatedAt: faxJob.updatedAt,
      deliveredAt: faxJob.completedAt,
    }),
  };
  const numbers = {
    releaseNumber: vi.fn<NumberService["releaseNumber"]>().mockImplementation(async () => {
      await repository.updateTemporaryNumber(temporaryNumber.id, { state: "released" });
      return { ...temporaryNumber, state: "released" as const };
    }),
  };
  return {
    repository,
    notifications,
    numbers,
    service: new FaxTerminalService({
      repository,
      notifications,
      numbers,
    }),
  };
}

function fax(overrides: Partial<FaxJob> = {}): FaxJob {
  return {
    id: "fax-1",
    mode: "send-only",
    direction: "outbound",
    state: "delivered",
    toNumber: "+16155550123",
    fromNumber: "+16155550199",
    providerFaxId: "provider-fax-1",
    providerProjectId: "project-1",
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
    ...overrides,
  };
}

function number(overrides: Partial<TemporaryNumber> = {}): TemporaryNumber {
  return {
    id: "number-1",
    faxJobId: "line-setup",
    e164: "+16155550199",
    areaCode: "629",
    providerId: "provider-number-1",
    providerName: "signalwire",
    state: "active",
    mode: "receive-only",
    forwardingEmail: "family@example.com",
    setupPrice: null,
    monthlyPrice: { amount: "0.50", currency: "USD", intervalMonths: 1 },
    provisionedAt: "2026-08-17T00:00:00.000Z",
    earliestProviderReleaseAt: "2026-08-31T00:00:00.000Z",
    releasePolicy: "manual",
    rentalMonths: null,
    nextBilledAt: "2026-09-17T00:00:00.000Z",
    releaseAt: null,
    expiresAt: null,
    releaseStartedAt: null,
    releasedAt: null,
    workflowId: "workflow-1",
    createdAt: "2026-08-17T00:00:00.000Z",
    updatedAt: "2026-08-17T00:00:00.000Z",
    ...overrides,
  };
}
