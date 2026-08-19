import { describe, expect, it, vi } from "vitest";
import type { CountryCode } from "libphonenumber-js";

import { FixedClock } from "../../domain/clock";
import { DemoFaxProvider } from "../../providers/demo-fax-provider";
import type { FaxProvider } from "../../providers/fax-provider";
import { MemoryRepository } from "../repositories/memory-repository";
import { MemoryDocumentStore } from "../storage/document-store";
import { AuditService } from "./audit-service";
import { FaxService } from "./fax-service";

const clock = new FixedClock(new Date("2026-08-16T12:00:00.000Z"));

describe("FaxService", () => {
  it("normalizes a local destination with the configured default country", async () => {
    const { service } = createService(new DemoFaxProvider());

    const job = await service.createDraft({
      mode: "send-only",
      toNumber: "6155550123",
      requestedTtlDays: null,
      coverData: null,
    });

    expect(job.toNumber).toBe("+16155550123");
  });

  it("honors a non-US default country when normalizing a local destination", async () => {
    const { service } = createService(new DemoFaxProvider(), "GB");

    const job = await service.createDraft({
      mode: "send-only",
      toNumber: "020 7946 0018",
      requestedTtlDays: null,
      coverData: null,
    });

    expect(job.toNumber).toBe("+442079460018");
  });

  it("cancels an abandoned prepared fax so retries remain explicit", async () => {
    const { service, repository } = createService(new DemoFaxProvider());
    const job = await service.createDraft({
      mode: "receive-only",
      toNumber: null,
      requestedTtlDays: 3,
      coverData: null,
    });
    await service.prepare(job.id, null, null);

    const canceled = await service.cancelDraft(job.id, "No numbers were available.");

    expect(canceled).toMatchObject({
      state: "canceled",
      failureCode: "preparation_abandoned",
      failureMessage: "No numbers were available.",
    });
    expect((await repository.listEventsForFax(job.id)).at(-1)?.type).toBe("fax.preparation_abandoned");
  });

  it("creates, prepares, and submits a one-time fax", async () => {
    const { service, repository } = createService(new DemoFaxProvider());
    const job = await service.createDraft({
      mode: "send-only",
      toNumber: "+16155550123",
      requestedTtlDays: null,
      coverData: null,
    });
    await service.registerDocument(job.id, {
      id: "document-1",
      kind: "final-packet",
      objectKey: "faxes/job-1/final.pdf",
      mimeType: "application/pdf",
      byteCount: 123,
      pageCount: 2,
      sha256: "abc",
      displayName: "fax.pdf",
    });
    await service.prepare(job.id, "document-1", 2);
    await repository.updateFaxJob(job.id, {
      state: "submitting",
      fromNumber: "+16155550199",
      updatedAt: clock.now().toISOString(),
    });

    const result = await service.submitOutbound(job.id, {
      contentUrl: "https://fax.example.com/provider-content/token",
      callbackUrl: "https://events.example.com/webhooks/sinch/fax",
    });

    expect(result.state).toBe("delivered");
    expect(result.providerFaxId).toBeTruthy();
    expect((await repository.listEventsForFax(job.id)).map((event) => event.type)).toContain(
      "fax.delivered",
    );
  });

  it("keeps a terminal provider result usable when its audit write fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const provider = new DemoFaxProvider();
    const { service, repository, audit } = createService(provider);
    const job = await service.createDraft({
      mode: "send-only",
      toNumber: "+16155550123",
      requestedTtlDays: null,
      coverData: null,
    });
    await repository.updateFaxJob(job.id, {
      state: "submitting",
      fromNumber: "+16155550199",
      updatedAt: clock.now().toISOString(),
    });
    const record = audit.record.bind(audit);
    vi.spyOn(audit, "record").mockImplementation(async (input) => {
      if (input.type === "fax.delivered") throw new Error("D1 audit unavailable");
      return record(input);
    });

    const delivered = await service.submitOutbound(job.id, {
      contentUrl: "https://fax.example.com/provider-content/token",
      callbackUrl: "https://events.example.com/webhooks/demo/fax",
    });

    expect(delivered.state).toBe("delivered");
    expect(await repository.getFaxJob(job.id)).toMatchObject({ state: "delivered" });
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("fax.provider_event_audit_failed"));
  });

  it("starts a prepared fax on an existing active family line", async () => {
    const { service, repository } = createService(new DemoFaxProvider());
    const job = await service.createDraft({
      mode: "send-only",
      toNumber: "+16155550123",
      requestedTtlDays: null,
      requestedRentalMonths: null,
      coverData: null,
    });
    await service.registerDocument(job.id, {
      id: "document-existing-line",
      kind: "final-packet",
      objectKey: "faxes/existing/final.pdf",
      mimeType: "application/pdf",
      byteCount: 123,
      pageCount: 2,
      sha256: "abc",
      displayName: "fax.pdf",
    });
    await service.prepare(job.id, "document-existing-line", 2);
    await repository.createTemporaryNumber({
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
      releasePolicy: "manual",
      rentalMonths: null,
      nextBilledAt: "2026-09-01T12:00:00.000Z",
      releaseAt: null,
      expiresAt: null,
      releaseStartedAt: null,
      releasedAt: null,
      workflowId: "number-workflow",
      createdAt: "2026-08-01T12:00:00.000Z",
      updatedAt: "2026-08-01T12:00:00.000Z",
    });

    const started = await service.startWithExistingNumber(job.id, "number-existing");

    expect(started).toMatchObject({
      state: "submitting",
      fromNumber: "+16155550199",
      temporaryNumberId: "number-existing",
    });
    expect((await repository.listEventsForFax(job.id)).at(-1)?.type).toBe("fax.existing_number_selected");
  });

  it("rejects an after-send line because its original workflow can release it", async () => {
    const { service, repository } = createService(new DemoFaxProvider());
    const job = await service.createDraft({
      mode: "send-only",
      toNumber: "+16155550123",
      requestedTtlDays: null,
      requestedRentalMonths: null,
      coverData: null,
    });
    await service.registerDocument(job.id, {
      id: "document-after-send",
      kind: "final-packet",
      objectKey: "faxes/after-send/final.pdf",
      mimeType: "application/pdf",
      byteCount: 123,
      pageCount: 1,
      sha256: "abc",
      displayName: "fax.pdf",
    });
    await service.prepare(job.id, "document-after-send", 1);
    await repository.createTemporaryNumber({
      id: "number-after-send",
      faxJobId: "original-send",
      e164: "+16155550199",
      areaCode: "615",
      providerId: "provider-number-after-send",
      providerName: "demo",
      state: "active",
      mode: "send-only",
      forwardingEmail: "fax@example.com",
      setupPrice: null,
      monthlyPrice: null,
      provisionedAt: clock.now().toISOString(),
      earliestProviderReleaseAt: null,
      releasePolicy: "after-send",
      rentalMonths: null,
      nextBilledAt: null,
      releaseAt: null,
      expiresAt: null,
      releaseStartedAt: null,
      releasedAt: null,
      workflowId: "number-workflow",
      createdAt: clock.now().toISOString(),
      updatedAt: clock.now().toISOString(),
    });

    await expect(service.startWithExistingNumber(job.id, "number-after-send")).rejects.toThrow(
      /retained fax number/i,
    );
    expect(await repository.getFaxJob(job.id)).toMatchObject({ state: "prepared" });
  });

  it("records an ambiguous submission and never replays it", async () => {
    const provider = new DemoFaxProvider();
    const send = vi.spyOn(provider, "sendFax").mockRejectedValue(new TypeError("network timeout"));
    const { service, repository } = createService(provider);
    const job = await service.createDraft({
      mode: "send-only",
      toNumber: "+16155550123",
      requestedTtlDays: null,
      coverData: null,
    });
    await repository.updateFaxJob(job.id, {
      state: "submitting",
      fromNumber: "+16155550199",
      updatedAt: clock.now().toISOString(),
    });

    expect(
      (
        await service.submitOutbound(job.id, {
          contentUrl: "https://fax.example.com/provider-content/token",
          callbackUrl: "https://events.example.com/webhooks/sinch/fax",
        })
      ).state,
    ).toBe("status_unknown");
    await expect(
      service.submitOutbound(job.id, {
        contentUrl: "https://fax.example.com/provider-content/token",
        callbackUrl: "https://events.example.com/webhooks/sinch/fax",
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("does not replay a provider send when persisting its successful response fails", async () => {
    const provider = new DemoFaxProvider();
    const send = vi.spyOn(provider, "sendFax");
    const { service, repository } = createService(provider);
    const job = await service.createDraft({
      mode: "send-only",
      toNumber: "+16155550123",
      requestedTtlDays: null,
      coverData: null,
    });
    await repository.updateFaxJob(job.id, {
      state: "submitting",
      fromNumber: "+16155550199",
      updatedAt: clock.now().toISOString(),
    });
    const updateFaxJobIfState = repository.updateFaxJobIfState.bind(repository);
    let conditionalUpdateCount = 0;
    vi.spyOn(repository, "updateFaxJobIfState").mockImplementation(async (...args) => {
      conditionalUpdateCount += 1;
      if (conditionalUpdateCount === 2) throw new Error("D1 result persistence unavailable");
      return updateFaxJobIfState(...args);
    });

    await expect(
      service.submitOutbound(job.id, {
        contentUrl: "https://fax.example.com/provider-content/token",
        callbackUrl: "https://events.example.com/webhooks/demo/fax",
      }),
    ).rejects.toThrow(/result persistence unavailable/i);
    expect(await repository.getFaxJob(job.id)).toMatchObject({
      state: "status_unknown",
      providerFaxId: null,
      failureCode: "submission_in_progress",
    });

    await expect(
      service.submitOutbound(job.id, {
        contentUrl: "https://fax.example.com/provider-content/token",
        callbackUrl: "https://events.example.com/webhooks/demo/fax",
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("does not replay a provider send when raw diagnostic storage fails afterward", async () => {
    const provider = new DemoFaxProvider();
    const send = vi.spyOn(provider, "sendFax");
    const { service, repository, documents } = createService(provider);
    const job = await service.createDraft({
      mode: "send-only",
      toNumber: "+16155550123",
      requestedTtlDays: null,
      coverData: null,
    });
    await repository.updateFaxJob(job.id, {
      state: "submitting",
      fromNumber: "+16155550199",
      updatedAt: clock.now().toISOString(),
    });
    const put = documents.put.bind(documents);
    let diagnosticWriteFailed = false;
    vi.spyOn(documents, "put").mockImplementation(async (key, body, metadata) => {
      if (!key.startsWith("diagnostics/submissions/") && !diagnosticWriteFailed) {
        diagnosticWriteFailed = true;
        throw new Error("diagnostic storage unavailable");
      }
      return put(key, body, metadata);
    });

    const delivered = await service.submitOutbound(job.id, {
      contentUrl: "https://fax.example.com/provider-content/token",
      callbackUrl: "https://events.example.com/webhooks/sinch/fax",
    });
    expect(delivered.state).toBe("delivered");
    expect((await repository.listEventsForFax(job.id)).at(-1)?.details).toMatchObject({
      diagnosticPayloadStorage: { stored: false, error: "diagnostic storage unavailable" },
    });
    await expect(
      service.submitOutbound(job.id, {
        contentUrl: "https://fax.example.com/provider-content/token",
        callbackUrl: "https://events.example.com/webhooks/sinch/fax",
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("keeps the terminal provider result when submission recovery storage is unavailable", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const provider = new DemoFaxProvider();
    const send = vi.spyOn(provider, "sendFax");
    const { service, repository, documents } = createService(provider);
    const job = await service.createDraft({
      mode: "send-only",
      toNumber: "+16155550123",
      requestedTtlDays: null,
      coverData: null,
    });
    await repository.updateFaxJob(job.id, {
      state: "submitting",
      fromNumber: "+16155550199",
      updatedAt: clock.now().toISOString(),
    });
    const put = documents.put.bind(documents);
    vi.spyOn(documents, "put").mockImplementation(async (key, body, metadata) => {
      if (key.startsWith("diagnostics/submissions/")) {
        throw new Error("submission recovery storage unavailable");
      }
      return put(key, body, metadata);
    });

    const delivered = await service.submitOutbound(job.id, {
      contentUrl: "https://fax.example.com/provider-content/token",
      callbackUrl: "https://events.example.com/webhooks/demo/fax",
    });

    expect(delivered.state).toBe("delivered");
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining("fax.submission_recovery_storage_failed"),
    );
    await expect(service.submitOutbound(job.id, {
      contentUrl: "https://fax.example.com/provider-content/token",
      callbackUrl: "https://events.example.com/webhooks/demo/fax",
    })).rejects.toMatchObject({ code: "conflict" });
    expect(send).toHaveBeenCalledOnce();
  });

  it("recovers a provider result after its first local persistence attempt fails", async () => {
    const provider = new DemoFaxProvider();
    const send = vi.spyOn(provider, "sendFax");
    const { service, repository } = createService(provider);
    const job = await service.createDraft({
      mode: "send-only",
      toNumber: "+16155550123",
      requestedTtlDays: null,
      coverData: null,
    });
    await repository.updateFaxJob(job.id, {
      state: "submitting",
      fromNumber: "+16155550199",
      updatedAt: clock.now().toISOString(),
    });
    const updateFaxJobIfState = repository.updateFaxJobIfState.bind(repository);
    let resultWriteFailed = false;
    vi.spyOn(repository, "updateFaxJobIfState").mockImplementation(async (id, expected, patch) => {
      if (!resultWriteFailed && expected === "status_unknown" && patch.providerFaxId) {
        resultWriteFailed = true;
        throw new Error("D1 provider result persistence unavailable");
      }
      return updateFaxJobIfState(id, expected, patch);
    });

    await expect(
      service.submitOutbound(job.id, {
        contentUrl: "https://fax.example.com/provider-content/token",
        callbackUrl: "https://events.example.com/webhooks/demo/fax",
      }),
    ).rejects.toThrow(/provider result persistence unavailable/i);
    expect(await repository.getFaxJob(job.id)).toMatchObject({
      state: "status_unknown",
      providerFaxId: null,
    });

    const recovered = await service.reconcileOutbound(job.id);

    expect(recovered).toMatchObject({ state: "delivered", providerFaxId: expect.any(String) });
    expect(send).toHaveBeenCalledOnce();
  });

  it("restores a missing terminal provider event when its first audit write fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const provider = new DemoFaxProvider();
    const { service, repository, audit } = createService(provider);
    const job = await service.createDraft({
      mode: "send-only",
      toNumber: "+16155550123",
      requestedTtlDays: null,
      coverData: null,
    });
    await repository.updateFaxJob(job.id, {
      state: "submitting",
      fromNumber: "+16155550199",
      updatedAt: clock.now().toISOString(),
    });
    const originalRecord = audit.record.bind(audit);
    vi.spyOn(audit, "record").mockImplementation(async (input) => {
      if (input.type === "fax.delivered") throw new Error("event write unavailable");
      return originalRecord(input);
    });

    await expect(service.submitOutbound(job.id, {
      contentUrl: "https://fax.example.com/provider-content/token",
      callbackUrl: "https://events.example.com/webhooks/demo/fax",
    })).resolves.toMatchObject({ state: "delivered" });
    const terminal = (await repository.getFaxJob(job.id))!;
    expect(terminal.state).toBe("delivered");
    vi.mocked(audit.record).mockImplementation(originalRecord);

    await service.applyProviderUpdate(await provider.getFax(terminal.providerFaxId!));

    expect((await repository.listEventsForFax(job.id)).map((event) => event.type)).toContain("fax.delivered");
  });

  it("atomically preserves terminal metadata against a concurrent nonterminal provider update", async () => {
    const provider = new DemoFaxProvider();
    const { service, repository } = createService(provider);
    const job = await service.createDraft({
      mode: "send-only",
      toNumber: "+16155550123",
      requestedTtlDays: null,
      coverData: null,
    });
    await repository.updateFaxJob(job.id, {
      state: "submitted",
      providerFaxId: "fax-race",
      fromNumber: "+16155550199",
      updatedAt: clock.now().toISOString(),
    });
    let releaseStaleUpdate!: () => void;
    let markStaleUpdateEntered!: () => void;
    const staleUpdateEntered = new Promise<void>((resolve) => {
      markStaleUpdateEntered = resolve;
    });
    const staleUpdateGate = new Promise<void>((resolve) => {
      releaseStaleUpdate = resolve;
    });
    const updateFaxJobIfState = repository.updateFaxJobIfState.bind(repository);
    let blockedStaleUpdate = false;
    vi.spyOn(repository, "updateFaxJobIfState").mockImplementation(async (id, expected, patch) => {
      if (!blockedStaleUpdate && patch.state === "sending") {
        blockedStaleUpdate = true;
        markStaleUpdateEntered();
        await staleUpdateGate;
      }
      return updateFaxJobIfState(id, expected, patch);
    });

    const staleUpdate = service.applyProviderUpdate({
      id: "fax-race",
      direction: "outbound",
      from: "+16155550199",
      to: "+16155550123",
      status: "in_progress",
      pageCount: 1,
      price: { amount: "0.01", currency: "USD" },
      errorCode: null,
      errorMessage: null,
      createdAt: clock.now().toISOString(),
      completedAt: null,
      raw: { status: "sending" },
    });
    await staleUpdateEntered;
    clock.advance(60_000);
    const terminalTimestamp = clock.now().toISOString();
    const terminalResult = await service.applyProviderUpdate({
      id: "fax-race",
      direction: "outbound",
      from: "+16155550199",
      to: "+16155550123",
      status: "failure",
      pageCount: 4,
      price: { amount: "0.32", currency: "USD" },
      errorCode: "32034",
      errorMessage: "No answer",
      createdAt: terminalTimestamp,
      completedAt: terminalTimestamp,
      raw: { status: "failed" },
    });
    releaseStaleUpdate();
    const staleResult = await staleUpdate;

    expect(terminalResult?.state).toBe("failed");
    expect(staleResult?.state).toBe("failed");
    expect(await repository.getFaxJob(job.id)).toMatchObject({
      state: "failed",
      pageCount: 4,
      reportedCost: { amount: "0.32", currency: "USD" },
      failureCode: "32034",
      failureMessage: "No answer",
      submittedAt: terminalTimestamp,
      completedAt: terminalTimestamp,
      updatedAt: terminalTimestamp,
    });
  });
});

function createService(provider: FaxProvider, defaultPhoneCountry: CountryCode = "US") {
  const repository = new MemoryRepository();
  const documents = new MemoryDocumentStore();
  const audit = new AuditService(repository, documents, clock, () => crypto.randomUUID());
  const service = new FaxService({
    repository,
    documents,
    audit,
    provider,
    clock,
    defaultPhoneCountry,
  });
  return { service, repository, documents, audit };
}
