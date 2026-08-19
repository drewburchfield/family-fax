import { describe, expect, it, vi } from "vitest";

import { FixedClock } from "../../domain/clock";
import type { FaxDocument, FaxJob, TemporaryNumber } from "../../shared/contracts";
import type { FaxEmailNotifier } from "../notifications/fax-email";
import { MemoryRepository } from "../repositories/memory-repository";
import { MemoryDocumentStore } from "../storage/document-store";
import { AuditService } from "./audit-service";
import { NotificationService } from "./notification-service";

describe("NotificationService", () => {
  it("claims concurrent outbound delivery requests and sends one email", async () => {
    const fixture = await createFixture(outboundFax());

    const results = await Promise.all([
      fixture.service.deliver("fax-1", "outbound_delivered"),
      fixture.service.deliver("fax-1", "outbound_delivered"),
    ]);

    expect(fixture.notifier.send).toHaveBeenCalledTimes(1);
    expect(results.some((item) => item.state === "delivered")).toBe(true);
    expect(await fixture.repository.getFaxNotification("fax-1", "outbound_delivered")).toMatchObject({
      state: "delivered",
      attempt: 1,
      messageId: "message-1",
    });
    expect((await fixture.repository.getFaxJob("fax-1"))?.state).toBe("delivered");
    const events = await fixture.repository.listEventsForFax("fax-1");
    expect(events.find((event) => event.type === "fax.email_sending")).toMatchObject({
      correlationId: "correlation-1",
      attempt: 1,
      resultingState: "sending",
      details: expect.objectContaining({
        kind: "outbound_delivered",
        destinationEmail: "family@example.com",
        attached: null,
        byteCount: expect.any(Number),
        finalState: null,
      }),
    });
    expect(events.find((event) => event.type === "fax.email_delivered")).toMatchObject({
      correlationId: "correlation-1",
      attempt: 1,
      resultingState: "delivered",
      durationMs: expect.any(Number),
      details: expect.objectContaining({ attached: true, finalState: "delivered" }),
    });
  });

  it("records email failure without changing a delivered inbound fax", async () => {
    const fixture = await createFixture(
      inboundFax(),
      vi.fn().mockRejectedValue(new Error("email unavailable")),
    );

    const notification = await fixture.service.deliver("fax-1", "inbound_received");

    expect(notification).toMatchObject({ state: "failed", lastError: "email unavailable" });
    expect((await fixture.repository.getFaxJob("fax-1"))?.state).toBe("delivered");
    expect(await fixture.repository.listEventsForFax("fax-1")).toEqual(
      expect.arrayContaining([expect.objectContaining({
        type: "fax.email_failed",
        correlationId: "correlation-1",
        attempt: 1,
        durationMs: expect.any(Number),
        details: expect.objectContaining({ attached: null, finalState: "failed" }),
      })]),
    );
  });

  it("retries a failed notification through one conditional state transition", async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporary outage"))
      .mockResolvedValueOnce({ messageId: "message-2", attached: true });
    const fixture = await createFixture(outboundFax(), send);
    await fixture.service.deliver("fax-1", "outbound_delivered");

    const retried = await fixture.service.retry("fax-1");

    expect(retried).toMatchObject({ state: "delivered", attempt: 2, messageId: "message-2" });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("marks stale uncertain sends without retrying them", async () => {
    const fixture = await createFixture(outboundFax());
    await fixture.repository.createFaxNotification({
      faxJobId: "fax-1",
      kind: "outbound_delivered",
      state: "sending",
      destinationEmail: "family@example.com",
      attempt: 1,
      messageId: null,
      attached: null,
      lastError: null,
      createdAt: "2026-08-18T02:00:00.000Z",
      updatedAt: "2026-08-18T02:00:00.000Z",
      deliveredAt: null,
    });

    expect(await fixture.service.markStaleSendingUnknown("2026-08-18T02:30:00.000Z")).toBe(1);
    expect(fixture.notifier.send).not.toHaveBeenCalled();
    expect(await fixture.repository.getFaxNotification("fax-1", "outbound_delivered")).toMatchObject({
      state: "delivery_unknown",
    });
  });

  it.each([
    ["outbound", outboundFax(), "outbound_delivered" as const],
    ["inbound", inboundFax(), "inbound_received" as const],
  ])("durably fails %s preparation after claiming so a manual retry can recover", async (_label, fax, kind) => {
    const fixture = await createFixture(fax);
    vi.spyOn(fixture.documents, "get").mockRejectedValueOnce(new Error("R2 read temporarily unavailable"));

    const failed = await fixture.service.deliver("fax-1", kind);
    const retried = await fixture.service.retry("fax-1");

    expect(failed).toMatchObject({ state: "failed", attempt: 1, lastError: "R2 read temporarily unavailable" });
    expect(retried).toMatchObject({ state: "delivered", attempt: 2 });
    expect(fixture.notifier.send).toHaveBeenCalledTimes(1);
  });

  it("marks a post-send persistence failure unknown without sending again", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fixture = await createFixture(outboundFax());
    const update = fixture.repository.updateFaxNotificationIfState.bind(fixture.repository);
    vi.spyOn(fixture.repository, "updateFaxNotificationIfState")
      .mockRejectedValueOnce(new Error("D1 acknowledgement unavailable"))
      .mockImplementation(update);

    const uncertain = await fixture.service.deliver("fax-1", "outbound_delivered");
    const marked = await fixture.service.markStaleSendingUnknown("2026-08-18T03:47:05.000Z");

    expect(uncertain.state).toBe("sending");
    expect(marked).toBe(1);
    expect(fixture.notifier.send).toHaveBeenCalledTimes(1);
    expect(await fixture.repository.getFaxNotification("fax-1", "outbound_delivered")).toMatchObject({
      state: "delivery_unknown",
      attempt: 1,
    });
    expect(JSON.parse(String(consoleError.mock.calls[0]?.[0]))).toMatchObject({
      event: "fax.email_delivery_persistence_failed",
      faxJobId: "fax-1",
      correlationId: "correlation-1",
      kind: "outbound_delivered",
      attempt: 1,
      attached: true,
      finalState: "sending",
    });
  });
});

async function createFixture(fax: FaxJob, send = vi.fn().mockResolvedValue({
  messageId: "message-1",
  attached: true,
})) {
  const clock = new FixedClock(new Date("2026-08-18T03:47:05.000Z"));
  const repository = new MemoryRepository();
  const documents = new MemoryDocumentStore();
  const audit = new AuditService(repository, documents, clock, () => crypto.randomUUID());
  const notifier: FaxEmailNotifier = { send };
  const number = householdNumber();
  const document = faxDocument(fax.direction === "inbound" ? "inbound" : "final-packet");
  await repository.createFaxJob(fax);
  await repository.createTemporaryNumber(number);
  await repository.createDocument(document);
  await documents.put(document.objectKey, "%PDF-1.7 fax packet", {
    contentType: "application/pdf",
    sha256: "digest",
    uploadedAt: clock.now().toISOString(),
  });
  return {
    repository,
    documents,
    notifier: { send },
    service: new NotificationService({
      repository,
      documents,
      audit,
      notifier,
      providerName: "signalwire",
      defaultDestinationEmail: "family@example.com",
      clock,
    }),
  };
}

function outboundFax(): FaxJob {
  return fax({
    direction: "outbound",
    mode: "send-only",
    fromNumber: "+16155550199",
    toNumber: "+16155550123",
  });
}

function inboundFax(): FaxJob {
  return fax({
    direction: "inbound",
    mode: "receive-only",
    fromNumber: "+12025550123",
    toNumber: "+16155550199",
  });
}

function fax(overrides: Partial<FaxJob>): FaxJob {
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

function householdNumber(): TemporaryNumber {
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
  };
}

function faxDocument(kind: FaxDocument["kind"]): FaxDocument {
  return {
    id: "document-1",
    faxJobId: "fax-1",
    temporaryNumberId: "number-1",
    kind,
    objectKey: "faxes/fax-1/document-1.pdf",
    mimeType: "application/pdf",
    byteCount: 20,
    pageCount: 2,
    sha256: "digest",
    displayName: kind === "inbound" ? "fax-from-+12025550123.pdf" : "fax-packet.pdf",
    createdAt: "2026-08-18T03:40:00.000Z",
  };
}
