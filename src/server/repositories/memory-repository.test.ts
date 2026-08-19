import { describe, expect, it } from "vitest";

import type { FaxJob, FaxNotification, TemporaryNumber } from "../../shared/contracts";
import { MemoryRepository } from "./memory-repository";

const job = (id = "job-1"): FaxJob => ({
  id,
  mode: "send-only",
  direction: "outbound",
  state: "draft",
  toNumber: "+16155550100",
  fromNumber: null,
  providerFaxId: null,
  providerProjectId: null,
  temporaryNumberId: null,
  correlationId: `correlation-${id}`,
  finalDocumentId: null,
  pageCount: null,
  estimatedCost: null,
  reportedCost: null,
  requestedTtlDays: null,
  coverData: null,
  failureCode: null,
  failureMessage: null,
  createdAt: "2026-08-16T12:00:00.000Z",
  updatedAt: "2026-08-16T12:00:00.000Z",
  submittedAt: null,
  completedAt: null,
});

const number = (): TemporaryNumber => ({
  id: "number-1",
  faxJobId: "job-1",
  e164: null,
  areaCode: "615",
  providerId: null,
  state: "requested",
  mode: "send-only",
  forwardingEmail: "fax@example.com",
  setupPrice: null,
  monthlyPrice: null,
  provisionedAt: null,
  earliestProviderReleaseAt: null,
  expiresAt: null,
  releaseStartedAt: null,
  releasedAt: null,
  workflowId: null,
  createdAt: "2026-08-16T12:00:00.000Z",
  updatedAt: "2026-08-16T12:00:00.000Z",
});

const notification = (overrides: Partial<FaxNotification> = {}): FaxNotification => ({
  faxJobId: "job-1",
  kind: "outbound_delivered",
  state: "sending",
  destinationEmail: "family@example.com",
  attempt: 1,
  messageId: null,
  attached: null,
  lastError: null,
  createdAt: "2026-08-16T12:00:00.000Z",
  updatedAt: "2026-08-16T12:00:00.000Z",
  deliveredAt: null,
  ...overrides,
});

describe("MemoryRepository", () => {
  it("stores and compare-and-sets fax state", async () => {
    const repository = new MemoryRepository();
    await repository.createFaxJob(job());

    expect(await repository.compareAndSetFaxState("job-1", "draft", "preparing", "2026-08-16T12:01:00.000Z")).toBe(true);
    expect(await repository.compareAndSetFaxState("job-1", "draft", "prepared", "2026-08-16T12:02:00.000Z")).toBe(false);
    expect((await repository.getFaxJob("job-1"))?.updatedAt).toBe("2026-08-16T12:01:00.000Z");
    expect((await repository.getFaxJob("job-1"))?.state).toBe("preparing");
  });

  it("does not repeatedly reconcile an unrecoverable ambiguous submission", async () => {
    const repository = new MemoryRepository();
    await repository.createFaxJob({
      ...job("ambiguous"),
      state: "status_unknown",
      failureCode: "ambiguous_submission",
    });
    await repository.createFaxJob({
      ...job("recoverable"),
      state: "status_unknown",
      failureCode: "submission_in_progress",
    });

    expect((await repository.listStuckFaxJobs("2026-08-16T12:01:00.000Z")).map(
      (fax) => fax.id,
    )).toEqual(["recoverable"]);
  });

  it("stores and compare-and-sets temporary number state", async () => {
    const repository = new MemoryRepository();
    await repository.createFaxJob(job());
    await repository.createTemporaryNumber(number());

    expect(await repository.compareAndSetNumberState("number-1", "requested", "active")).toBe(true);
    expect(await repository.compareAndSetNumberState("number-1", "requested", "released")).toBe(false);
  });

  it("updates a temporary number only from the expected lifecycle state", async () => {
    const repository = new MemoryRepository();
    await repository.createFaxJob(job());
    await repository.createTemporaryNumber(number());

    expect(await repository.updateTemporaryNumberIfState("number-1", "requested", {
      state: "provisioning",
      e164: "+16155550199",
      updatedAt: "2026-08-16T12:01:00.000Z",
    })).toMatchObject({ state: "provisioning", e164: "+16155550199" });
    expect(await repository.updateTemporaryNumberIfState("number-1", "requested", {
      state: "provision_failed",
    })).toBeNull();
  });

  it("claims each fax notification once and conditionally advances its state", async () => {
    const repository = new MemoryRepository();
    await repository.createFaxJob(job());
    const claimed = notification();

    expect(await repository.createFaxNotification(claimed)).toBe(true);
    expect(await repository.createFaxNotification(claimed)).toBe(false);
    expect(await repository.getFaxNotification(claimed.faxJobId, claimed.kind)).toEqual(claimed);

    const deliveredAt = "2026-08-16T12:01:00.000Z";
    expect(await repository.updateFaxNotificationIfState(
      claimed.faxJobId,
      claimed.kind,
      "sending",
      {
        state: "delivered",
        messageId: "message-1",
        attached: true,
        deliveredAt,
        updatedAt: deliveredAt,
      },
    )).toMatchObject({
      state: "delivered",
      messageId: "message-1",
      attached: true,
      deliveredAt,
    });
    expect(await repository.updateFaxNotificationIfState(
      claimed.faxJobId,
      claimed.kind,
      "sending",
      { state: "failed", updatedAt: deliveredAt },
    )).toBeNull();
  });

  it("lists a fax's notifications and only stale sending claims", async () => {
    const repository = new MemoryRepository();
    await repository.createFaxJob(job());
    await repository.createFaxJob(job("job-2"));
    await repository.createFaxNotification(notification());
    await repository.createFaxNotification(notification({
      kind: "inbound_received",
      state: "failed",
      updatedAt: "2026-08-16T12:05:00.000Z",
    }));
    await repository.createFaxNotification(notification({
      faxJobId: "job-2",
      updatedAt: "2026-08-16T12:10:00.000Z",
    }));

    expect((await repository.listFaxNotificationsForFax("job-1")).map((item) => item.kind)).toEqual([
      "outbound_delivered",
      "inbound_received",
    ]);
    expect((await repository.listStuckFaxNotifications("2026-08-16T12:05:00.000Z")).map(
      (item) => item.faxJobId,
    )).toEqual(["job-1"]);
    expect((await repository.listFaxNotificationsNeedingAttention("2026-08-16T12:05:00.000Z")).map(
      (item) => `${item.faxJobId}:${item.state}`,
    )).toEqual(["job-1:sending", "job-1:failed"]);
  });

  it("recovers a failed after-send line even when it has no release deadline", async () => {
    const repository = new MemoryRepository();
    await repository.createFaxJob(job());
    await repository.createTemporaryNumber({
      ...number(),
      state: "release_failed",
      releasePolicy: "after-send",
      releaseAt: null,
      expiresAt: null,
    });

    expect(await repository.listOverdueNumbers("2026-08-16T13:00:00.000Z")).toEqual([
      expect.objectContaining({ id: "number-1", state: "release_failed" }),
    ]);
  });

  it("returns the newest unreleased record for a reused phone number", async () => {
    const repository = new MemoryRepository();
    await repository.createFaxJob(job());
    await repository.createTemporaryNumber({
      ...number(),
      id: "number-old",
      e164: "+16155550199",
      createdAt: "2026-08-16T11:00:00.000Z",
    });
    await repository.createTemporaryNumber({
      ...number(),
      id: "number-new",
      e164: "+16155550199",
      createdAt: "2026-08-16T12:00:00.000Z",
    });

    expect((await repository.getTemporaryNumberByE164("+16155550199"))?.id).toBe("number-new");
  });

  it("keeps audit events immutable and ordered", async () => {
    const repository = new MemoryRepository();
    await repository.createFaxJob(job());
    await repository.appendEvent({
      id: "event-2",
      correlationId: "correlation-job-1",
      faxJobId: "job-1",
      temporaryNumberId: null,
      source: "application",
      type: "prepared",
      resultingState: "prepared",
      attempt: null,
      durationMs: null,
      details: { second: true },
      rawPayloadKey: null,
      createdAt: "2026-08-16T12:01:00.000Z",
    });
    await repository.appendEvent({
      id: "event-1",
      correlationId: "correlation-job-1",
      faxJobId: "job-1",
      temporaryNumberId: null,
      source: "user",
      type: "created",
      resultingState: "draft",
      attempt: null,
      durationMs: null,
      details: { first: true },
      rawPayloadKey: null,
      createdAt: "2026-08-16T12:00:00.000Z",
    });

    const events = await repository.listEventsForFax("job-1");
    expect(events.map((event) => event.id)).toEqual(["event-1", "event-2"]);
    events[0]!.details.first = false;
    expect((await repository.listEventsForFax("job-1"))[0]!.details.first).toBe(true);
  });

  it("deduplicates webhook receipts", async () => {
    const repository = new MemoryRepository();

    expect(await repository.claimWebhook("sinch", "event-1", "2026-08-16T12:00:00.000Z")).toBe(true);
    expect(await repository.claimWebhook("sinch", "event-1", "2026-08-16T12:00:01.000Z")).toBe(false);
    expect(await repository.claimWebhook("a:b", "c", "2026-08-16T12:00:02.000Z")).toBe(true);
    expect(await repository.claimWebhook("a", "b:c", "2026-08-16T12:00:03.000Z")).toBe(true);
  });

  it("expires and revokes provider content tokens", async () => {
    const repository = new MemoryRepository();
    await repository.createFaxJob(job());
    await repository.createContentToken({
      tokenHash: "hash",
      faxJobId: "job-1",
      documentId: "document-1",
      expiresAt: "2026-08-16T13:00:00.000Z",
      revokedAt: null,
      createdAt: "2026-08-16T12:00:00.000Z",
    });

    expect(await repository.getActiveContentToken("hash", "2026-08-16T12:30:00.000Z")).not.toBeNull();
    await repository.revokeContentTokensForFax("job-1", "2026-08-16T12:31:00.000Z");
    await repository.revokeContentTokensForFax("job-1", "2026-08-16T12:35:00.000Z");
    expect(await repository.getActiveContentToken("hash", "2026-08-16T12:32:00.000Z")).toBeNull();
  });

  it("searches recent fax jobs by number", async () => {
    const repository = new MemoryRepository();
    await repository.createFaxJob(job("job-1"));
    await repository.createFaxJob({ ...job("job-2"), toNumber: "+16295550123" });

    expect((await repository.listFaxJobs({ search: "629", limit: 20 })).map((item) => item.id)).toEqual([
      "job-2",
    ]);
  });
});
