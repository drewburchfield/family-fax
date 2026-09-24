import { describe, expect, it, vi } from "vitest";

import { FixedClock } from "../../domain/clock";
import { DemoFaxProvider } from "../../providers/demo-fax-provider";
import type { FaxWebhookEvent } from "../../providers/webhook";
import type { FaxJob, TemporaryNumber } from "../../shared/contracts";
import type { FaxEmailNotifier } from "../notifications/fax-email";
import { MemoryRepository } from "../repositories/memory-repository";
import { MemoryDocumentStore } from "../storage/document-store";
import { AuditService } from "./audit-service";
import type { FaxTerminalService } from "./fax-terminal-service";
import { FaxService } from "./fax-service";
import { NotificationService } from "./notification-service";
import { WebhookService } from "./webhook-service";

describe("WebhookService", () => {
  it("archives and emails an inbound fax once when a webhook is replayed", async () => {
    const fixture = await createFixture();

    const first = await fixture.service.handleProviderEvent(incomingEvent());
    const duplicate = await fixture.service.handleProviderEvent(incomingEvent());

    expect(first.duplicate).toBe(false);
    expect(duplicate.duplicate).toBe(true);
    const jobs = await fixture.repository.listFaxJobs({ limit: 20 });
    expect(jobs.filter((job) => job.direction === "inbound")).toHaveLength(1);
    expect(await fixture.repository.listDocumentsForFax(first.faxJobId!)).toHaveLength(1);
    expect(fixture.notifier.send).toHaveBeenCalledOnce();
    expect(await fixture.repository.listFaxNotificationsForFax(first.faxJobId!)).toEqual([
      expect.objectContaining({ kind: "inbound_received", state: "delivered" }),
    ]);
  });

  it("can resume an inbound archive after provider document retrieval fails", async () => {
    const fixture = await createFixture();
    vi.spyOn(fixture.provider, "downloadFax")
      .mockRejectedValueOnce(new Error("provider file temporarily unavailable"))
      .mockResolvedValueOnce({
        body: new Blob(["pdf bytes"]).stream(),
        contentType: "application/pdf",
        size: 9,
      });
    const event = { ...incomingEvent(), file: null };

    await expect(fixture.service.handleProviderEvent(event)).rejects.toThrow(/temporarily unavailable/i);
    const resumed = await fixture.service.handleProviderEvent(event);

    expect(resumed.duplicate).toBe(false);
    expect(await fixture.repository.listDocumentsForFax(resumed.faxJobId!)).toHaveLength(1);
    expect((await fixture.repository.listFaxJobs({ limit: 20 })).filter((job) => job.direction === "inbound")).toHaveLength(1);
  });

  it("rejects inbound content while a number is not in a receiving lifecycle state", async () => {
    const fixture = await createFixture();
    await fixture.repository.updateTemporaryNumber("number-1", { state: "provisioning" });

    await expect(fixture.service.handleProviderEvent(incomingEvent())).rejects.toThrow(
      /not currently accepting inbound/i,
    );

    expect((await fixture.repository.listFaxJobs({ limit: 20 })).filter(
      (job) => job.direction === "inbound",
    )).toHaveLength(0);
    expect(fixture.notifier.send).not.toHaveBeenCalled();
  });

  it("keeps failed inbound email separate and does not release the webhook claim", async () => {
    const fixture = await createFixture(
      vi.fn().mockRejectedValue(new Error("email routing unavailable")),
    );

    const first = await fixture.service.handleProviderEvent(incomingEvent());
    const duplicate = await fixture.service.handleProviderEvent(incomingEvent());

    expect(first.duplicate).toBe(false);
    expect(duplicate.duplicate).toBe(true);
    expect(fixture.notifier.send).toHaveBeenCalledOnce();
    expect(await fixture.repository.getFaxNotification(first.faxJobId!, "inbound_received")).toMatchObject({
      state: "failed",
      lastError: "email routing unavailable",
    });
    expect(await fixture.repository.getFaxJob(first.faxJobId!)).toMatchObject({ state: "delivered" });
  });

  it("retains an archived webhook claim and resumes a missing notification on provider retry", async () => {
    const fixture = await createFixture();
    vi.spyOn(fixture.repository, "createFaxNotification")
      .mockRejectedValueOnce(new Error("notification database temporarily unavailable"));

    await expect(fixture.service.handleProviderEvent(incomingEvent())).rejects.toThrow(
      /notification database temporarily unavailable/i,
    );
    const resumed = await fixture.service.handleProviderEvent(incomingEvent());

    expect(resumed).toMatchObject({ duplicate: true, faxJobId: expect.any(String) });
    expect(fixture.notifier.send).toHaveBeenCalledOnce();
    expect(await fixture.repository.getFaxNotification(resumed.faxJobId!, "inbound_received"))
      .toMatchObject({ state: "delivered" });
  });

  it("coordinates terminal outbound status callbacks", async () => {
    const fixture = await createFixture();
    const outbound = outboundJob();
    await fixture.repository.createFaxJob(outbound);
    const event: FaxWebhookEvent = {
      provider: "demo",
      type: "status",
      eventKey: "status:provider-outbound-1:completed",
      eventTime: outbound.completedAt!,
      fax: {
        id: outbound.providerFaxId!,
        direction: "outbound",
        from: outbound.fromNumber!,
        to: outbound.toNumber!,
        status: "completed",
        pageCount: 1,
        price: null,
        errorCode: null,
        errorMessage: null,
        createdAt: outbound.createdAt,
        completedAt: outbound.completedAt,
        raw: {},
      },
      file: null,
      raw: { status: "completed" },
    };

    await fixture.service.handleProviderEvent(event);

    expect(fixture.terminal.complete).toHaveBeenCalledWith(outbound.id);
  });
});

async function createFixture(
  send = vi.fn().mockResolvedValue({ messageId: "message-1", attached: true }),
) {
  const repository = new MemoryRepository();
  const documents = new MemoryDocumentStore();
  const clock = new FixedClock(new Date("2026-08-16T12:00:00.000Z"));
  const audit = new AuditService(repository, documents, clock, () => crypto.randomUUID());
  const provider = new DemoFaxProvider();
  const fax = new FaxService({ repository, documents, audit, provider, clock, defaultPhoneCountry: "US" });
  const notifier: FaxEmailNotifier = { send };
  const notifications = new NotificationService({
    repository,
    documents,
    audit,
    notifier,
    providerName: "demo",
    defaultDestinationEmail: "fax@example.com",
    clock,
  });
  const terminal = { complete: vi.fn<FaxTerminalService["complete"]>().mockResolvedValue({ notification: null, numberState: null }) };
  const service = new WebhookService({
    repository,
    documents,
    audit,
    fax,
    provider,
    notifications,
    terminal,
    clock,
  });
  await repository.createFaxJob(receiveJob());
  await repository.createTemporaryNumber(activeNumber());
  return { repository, documents, provider, notifier: { send }, notifications, terminal, service };
}

function incomingEvent(): FaxWebhookEvent {
  return {
    provider: "demo",
    type: "incoming",
    eventKey: "INCOMING_FAX:provider-inbound-1:2026-08-16T12:00:00.000Z",
    eventTime: "2026-08-16T12:00:00.000Z",
    fax: {
      id: "provider-inbound-1",
      direction: "inbound",
      from: "+16155550123",
      to: "+16155550199",
      status: "completed",
      pageCount: 1,
      price: { amount: "0.045", currency: "USD" },
      errorCode: null,
      errorMessage: null,
      createdAt: "2026-08-16T11:59:00.000Z",
      completedAt: "2026-08-16T12:00:00.000Z",
      raw: { event: "INCOMING_FAX" },
    },
    file: {
      body: new Blob(["pdf bytes"]).stream(),
      contentType: "application/pdf",
      size: 9,
    },
    raw: { event: "INCOMING_FAX" },
  };
}

function receiveJob(): FaxJob {
  return {
    id: "receive-job",
    mode: "receive-only",
    direction: "none",
    state: "active",
    toNumber: null,
    fromNumber: "+16155550199",
    providerFaxId: null,
    providerProjectId: null,
    temporaryNumberId: "number-1",
    correlationId: "receive-correlation",
    finalDocumentId: null,
    pageCount: null,
    estimatedCost: null,
    reportedCost: null,
    requestedTtlDays: 3,
    requestedRentalMonths: 1,
    coverData: null,
    failureCode: null,
    failureMessage: null,
    createdAt: "2026-08-16T11:00:00.000Z",
    updatedAt: "2026-08-16T11:00:00.000Z",
    submittedAt: null,
    completedAt: null,
  };
}

function outboundJob(): FaxJob {
  return {
    ...receiveJob(),
    id: "outbound-job",
    mode: "send-only",
    direction: "outbound",
    state: "sending",
    toNumber: "+16155550123",
    providerFaxId: "provider-outbound-1",
    correlationId: "outbound-correlation",
    finalDocumentId: "outbound-document",
    pageCount: 1,
    requestedTtlDays: null,
    completedAt: "2026-08-16T12:00:00.000Z",
  };
}

function activeNumber(): TemporaryNumber {
  return {
    id: "number-1",
    faxJobId: "receive-job",
    e164: "+16155550199",
    areaCode: "615",
    providerId: "+16155550199",
    providerName: "demo",
    state: "active",
    mode: "receive-only",
    forwardingEmail: "fax@example.com",
    setupPrice: null,
    monthlyPrice: { amount: "1.00", currency: "USD", intervalMonths: 1 },
    provisionedAt: "2026-08-16T11:00:00.000Z",
    earliestProviderReleaseAt: null,
    releasePolicy: "scheduled",
    rentalMonths: 1,
    nextBilledAt: "2026-09-16T11:00:00.000Z",
    releaseAt: "2026-09-16T10:00:00.000Z",
    expiresAt: "2026-09-16T10:00:00.000Z",
    releaseStartedAt: null,
    releasedAt: null,
    workflowId: "number-number-1",
    createdAt: "2026-08-16T11:00:00.000Z",
    updatedAt: "2026-08-16T11:00:00.000Z",
  };
}
