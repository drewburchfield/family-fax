import { describe, expect, it, vi } from "vitest";

import { FixedClock } from "../domain/clock";
import { DemoFaxProvider } from "../providers/demo-fax-provider";
import { MemoryRepository } from "../server/repositories/memory-repository";
import { AuditService } from "../server/services/audit-service";
import { FaxService } from "../server/services/fax-service";
import type { FaxTerminalService } from "../server/services/fax-terminal-service";
import { NumberService } from "../server/services/number-service";
import { MemoryDocumentStore } from "../server/storage/document-store";
import { runSafetySweep } from "./scheduled";

describe("scheduled safety sweep", () => {
  it("finishes terminal handling and records fax context when reconciliation throws after persistence", async () => {
    const clock = new FixedClock(new Date("2026-08-16T12:20:00.000Z"));
    const provider = new DemoFaxProvider();
    const repository = new MemoryRepository();
    const documents = new MemoryDocumentStore();
    const audit = new AuditService(repository, documents, clock);
    const fax = new FaxService({ repository, documents, audit, provider, clock, defaultPhoneCountry: "US" });
    const numbers = new NumberService({ repository, audit, provider, clock, maxTtlDays: 365 });
    const job = await fax.createDraft({
      mode: "send-only",
      toNumber: "+16155550123",
      requestedTtlDays: null,
      coverData: null,
    });
    await repository.updateFaxJob(job.id, {
      state: "submitted",
      providerFaxId: "provider-fax-1",
      updatedAt: "2026-08-16T12:00:00.000Z",
      submittedAt: "2026-08-16T12:00:00.000Z",
    });
    vi.spyOn(fax, "reconcileOutbound").mockImplementation(async () => {
      await repository.updateFaxJob(job.id, {
        state: "delivered",
        completedAt: clock.now().toISOString(),
        updatedAt: clock.now().toISOString(),
      });
      throw new Error("provider event audit unavailable");
    });
    const terminal = {
      complete: vi.fn<FaxTerminalService["complete"]>().mockResolvedValue({ notification: null, numberState: null }),
    };

    const result = await runSafetySweep({
      repository,
      numbers,
      fax,
      audit,
      clock,
      terminal,
    });

    expect(result.reconcileFailed).toBe(1);
    expect(terminal.complete).toHaveBeenCalledWith(job.id);
    expect(await repository.listEventsForFax(job.id)).toContainEqual(expect.objectContaining({
      type: "fax.reconcile_sweep_failed",
      faxJobId: job.id,
      details: expect.objectContaining({ error: "provider event audit unavailable" }),
    }));
  });

  it("releases overdue numbers and persists its last run", async () => {
    const clock = new FixedClock(new Date("2026-08-16T12:00:00.000Z"));
    const provider = new DemoFaxProvider();
    const repository = new MemoryRepository();
    const documents = new MemoryDocumentStore();
    const audit = new AuditService(repository, documents, clock);
    const fax = new FaxService({ repository, documents, audit, provider, clock, defaultPhoneCountry: "US" });
    const numbers = new NumberService({ repository, audit, provider, clock, maxTtlDays: 365 });
    const job = await fax.createDraft({
      mode: "receive-only",
      toNumber: null,
      requestedTtlDays: 1,
      coverData: null,
    });
    await fax.prepare(job.id, null, null);
    const candidate = (
      await provider.searchNumbers({ areaCodes: ["615"], countryCode: "US", limitPerAreaCode: 1 })
    )[0]!;
    const requested = await numbers.requestNumber(job.id, candidate, "fax@example.com");
    await numbers.provisionNumber(requested.id, candidate);
    clock.advance(86_400_001);

    const result = await runSafetySweep({ repository, numbers, fax, audit, clock });

    expect(result).toEqual({
      inspected: 2,
      released: 1,
      deferred: 0,
      failed: 0,
      recoveredNumberRequests: 0,
      numberRequestRecoveryFailed: 0,
      reconciledFaxes: 0,
      reconcileFailed: 0,
      reconciledNumbers: 1,
      numberReconcileFailed: 0,
    });
    expect((await repository.getTemporaryNumber(requested.id))?.state).toBe("released");
    expect(await repository.getSetting("lastScheduledSweep")).toBe("2026-08-17T12:00:00.001Z");
  });

  it("fails a requested number whose provisioning workflow stopped", async () => {
    const clock = new FixedClock(new Date("2026-08-16T12:00:00.000Z"));
    const provider = new DemoFaxProvider();
    const repository = new MemoryRepository();
    const documents = new MemoryDocumentStore();
    const audit = new AuditService(repository, documents, clock);
    const fax = new FaxService({ repository, documents, audit, provider, clock, defaultPhoneCountry: "US" });
    const numbers = new NumberService({ repository, audit, provider, clock, maxTtlDays: 365 });
    const job = await fax.createDraft({
      mode: "receive-only",
      toNumber: null,
      requestedTtlDays: 1,
      coverData: null,
    });
    await fax.prepare(job.id, null, null);
    const candidate = (
      await provider.searchNumbers({ areaCodes: ["615"], countryCode: "US", limitPerAreaCode: 1 })
    )[0]!;
    const requested = await numbers.requestNumber(job.id, candidate, "fax@example.com");
    clock.advance(31 * 60_000);

    const result = await runSafetySweep({ repository, numbers, fax, audit, clock });

    expect(result.recoveredNumberRequests).toBe(1);
    expect(await repository.getTemporaryNumber(requested.id)).toMatchObject({ state: "provision_failed" });
    expect(await repository.getFaxJob(job.id)).toMatchObject({ state: "failed" });
  });

  it("automatically finalizes an active number whose owner-fax write failed", async () => {
    const clock = new FixedClock(new Date("2026-08-16T12:00:00.000Z"));
    const provider = new DemoFaxProvider();
    const repository = new MemoryRepository();
    const documents = new MemoryDocumentStore();
    const audit = new AuditService(repository, documents, clock);
    const fax = new FaxService({ repository, documents, audit, provider, clock, defaultPhoneCountry: "US" });
    const numbers = new NumberService({ repository, audit, provider, clock, maxTtlDays: 365 });
    const job = await fax.createDraft({
      mode: "receive-only",
      toNumber: null,
      requestedTtlDays: 1,
      coverData: null,
    });
    await fax.prepare(job.id, null, null);
    const candidate = (
      await provider.searchNumbers({ areaCodes: ["615"], countryCode: "US", limitPerAreaCode: 1 })
    )[0]!;
    const requested = await numbers.requestNumber(job.id, candidate, "fax@example.com");
    const updateFaxJobIfState = repository.updateFaxJobIfState.bind(repository);
    let faxWriteFailed = false;
    vi.spyOn(repository, "updateFaxJobIfState").mockImplementation(async (id, expected, patch) => {
      if (!faxWriteFailed && expected === "provisioning" && patch.state === "active") {
        faxWriteFailed = true;
        throw new Error("D1 fax activation write unavailable");
      }
      return updateFaxJobIfState(id, expected, patch);
    });
    await expect(numbers.provisionNumber(requested.id, candidate)).rejects.toThrow(
      /fax activation write unavailable/i,
    );

    const result = await runSafetySweep({ repository, numbers, fax, audit, clock });

    expect(result.numberReconcileFailed).toBe(0);
    expect(await repository.getFaxJob(job.id)).toMatchObject({
      state: "active",
      fromNumber: candidate.e164,
    });
  });

  it("records the number and sanitized error when active reconciliation fails", async () => {
    const clock = new FixedClock(new Date("2026-08-16T12:00:00.000Z"));
    const provider = new DemoFaxProvider();
    const repository = new MemoryRepository();
    const documents = new MemoryDocumentStore();
    const audit = new AuditService(repository, documents, clock);
    const fax = new FaxService({ repository, documents, audit, provider, clock, defaultPhoneCountry: "US" });
    const numbers = new NumberService({ repository, audit, provider, clock, maxTtlDays: 365 });
    const job = await fax.createDraft({
      mode: "receive-only",
      toNumber: null,
      requestedTtlDays: 1,
      coverData: null,
    });
    await fax.prepare(job.id, null, null);
    const candidate = (
      await provider.searchNumbers({ areaCodes: ["615"], countryCode: "US", limitPerAreaCode: 1 })
    )[0]!;
    const requested = await numbers.requestNumber(job.id, candidate, "fax@example.com");
    await numbers.provisionNumber(requested.id, candidate);
    vi.spyOn(numbers, "reconcileActiveNumber").mockRejectedValue(
      new Error("https://user:password@example.com/provider?token=secret failed"),
    );

    const result = await runSafetySweep({ repository, numbers, fax, audit, clock });
    const events = await repository.listEventsForNumber(requested.id);

    expect(result).toMatchObject({ inspected: 1, reconciledNumbers: 0, numberReconcileFailed: 1 });
    expect(events).toContainEqual(expect.objectContaining({
      temporaryNumberId: requested.id,
      type: "number.reconcile_failed",
      details: expect.objectContaining({
        e164: candidate.e164,
        error: "https://example.com/provider?token=%5Bsecret+omitted%5D",
      }),
    }));
  });

  it("continues the sweep with sanitized console telemetry when failure auditing is unavailable", async () => {
    const clock = new FixedClock(new Date("2026-08-16T12:00:00.000Z"));
    const provider = new DemoFaxProvider();
    const repository = new MemoryRepository();
    const documents = new MemoryDocumentStore();
    const audit = new AuditService(repository, documents, clock);
    const fax = new FaxService({ repository, documents, audit, provider, clock, defaultPhoneCountry: "US" });
    const numbers = new NumberService({ repository, audit, provider, clock, maxTtlDays: 365 });
    const job = await fax.createDraft({
      mode: "receive-only",
      toNumber: null,
      requestedTtlDays: 1,
      coverData: null,
    });
    await fax.prepare(job.id, null, null);
    const candidate = (
      await provider.searchNumbers({ areaCodes: ["615"], countryCode: "US", limitPerAreaCode: 1 })
    )[0]!;
    const requested = await numbers.requestNumber(job.id, candidate, "fax@example.com");
    await numbers.provisionNumber(requested.id, candidate);
    vi.spyOn(numbers, "reconcileActiveNumber").mockRejectedValue(
      new Error("https://user:password@example.com/provider?token=secret failed"),
    );
    const record = audit.record.bind(audit);
    vi.spyOn(audit, "record").mockImplementation(async (input) => {
      if (input.type === "number.reconcile_failed") {
        throw new Error("https://audit-user:audit-password@example.com/write?token=audit-secret failed");
      }
      return record(input);
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const result = await runSafetySweep({ repository, numbers, fax, audit, clock });

    expect(result.numberReconcileFailed).toBe(1);
    expect(await repository.getSetting("lastScheduledSweep")).toBe(clock.now().toISOString());
    expect(consoleError).toHaveBeenCalledOnce();
    const telemetry = String(consoleError.mock.calls[0]?.[0]);
    expect(telemetry).toContain("lifecycle.number_failure_audit_failed");
    expect(telemetry).toContain("%5Bsecret+omitted%5D");
    expect(telemetry).not.toContain("password");
    expect(telemetry).not.toContain("audit-secret");
  });

  it("recovers a release interrupted after the provider call started", async () => {
    const clock = new FixedClock(new Date("2026-08-16T12:00:00.000Z"));
    const provider = new DemoFaxProvider();
    const repository = new MemoryRepository();
    const documents = new MemoryDocumentStore();
    const audit = new AuditService(repository, documents, clock);
    const fax = new FaxService({ repository, documents, audit, provider, clock, defaultPhoneCountry: "US" });
    const numbers = new NumberService({ repository, audit, provider, clock, maxTtlDays: 365 });
    const job = await fax.createDraft({
      mode: "receive-only",
      toNumber: null,
      requestedTtlDays: 1,
      coverData: null,
    });
    await fax.prepare(job.id, null, null);
    const candidate = (
      await provider.searchNumbers({ areaCodes: ["615"], countryCode: "US", limitPerAreaCode: 1 })
    )[0]!;
    const requested = await numbers.requestNumber(job.id, candidate, "fax@example.com");
    await numbers.provisionNumber(requested.id, candidate);
    await repository.updateTemporaryNumber(requested.id, {
      state: "releasing",
      releaseStartedAt: clock.now().toISOString(),
      updatedAt: clock.now().toISOString(),
    });
    clock.advance(16 * 60_000);

    const result = await runSafetySweep({ repository, numbers, fax, audit, clock });

    expect(result.released).toBe(1);
    expect((await repository.getTemporaryNumber(requested.id))?.state).toBe("released");
  });

  it("finishes owner-fax bookkeeping after a provider release was already persisted", async () => {
    const clock = new FixedClock(new Date("2026-08-16T12:00:00.000Z"));
    const provider = new DemoFaxProvider();
    const repository = new MemoryRepository();
    const documents = new MemoryDocumentStore();
    const audit = new AuditService(repository, documents, clock);
    const fax = new FaxService({ repository, documents, audit, provider, clock, defaultPhoneCountry: "US" });
    const numbers = new NumberService({ repository, audit, provider, clock, maxTtlDays: 365 });
    const job = await fax.createDraft({
      mode: "receive-only",
      toNumber: null,
      requestedTtlDays: 1,
      coverData: null,
    });
    await fax.prepare(job.id, null, null);
    const candidate = (
      await provider.searchNumbers({ areaCodes: ["615"], countryCode: "US", limitPerAreaCode: 1 })
    )[0]!;
    const requested = await numbers.requestNumber(job.id, candidate, "fax@example.com");
    await numbers.provisionNumber(requested.id, candidate);
    await provider.releaseNumber(candidate.e164, job.correlationId);
    await repository.updateTemporaryNumber(requested.id, {
      state: "released",
      releasedAt: clock.now().toISOString(),
      updatedAt: clock.now().toISOString(),
    });

    const result = await runSafetySweep({ repository, numbers, fax, audit, clock });

    expect(result.failed).toBe(0);
    expect(await repository.getFaxJob(job.id)).toMatchObject({ state: "completed" });
    expect(await repository.listEventsForNumber(requested.id)).toContainEqual(
      expect.objectContaining({ type: "number.released" }),
    );
  });

  it("safely reconciles stale faxes that already have a provider id", async () => {
    const clock = new FixedClock(new Date("2026-08-16T12:00:00.000Z"));
    const provider = new DemoFaxProvider();
    const repository = new MemoryRepository();
    const documents = new MemoryDocumentStore();
    const audit = new AuditService(repository, documents, clock);
    const fax = new FaxService({ repository, documents, audit, provider, clock, defaultPhoneCountry: "US" });
    const numbers = new NumberService({
      repository,
      audit,
      provider,
      clock,
      maxTtlDays: 365,
      minimumNumberHoldDays: 30,
    });
    const job = await fax.createDraft({
      mode: "send-only",
      toNumber: "+16155550123",
      requestedTtlDays: null,
      coverData: null,
    });
    const candidate = (
      await provider.searchNumbers({ areaCodes: ["615"], countryCode: "US", limitPerAreaCode: 1 })
    )[0]!;
    await provider.provisionNumber({ candidate, correlationId: job.correlationId });
    await repository.createTemporaryNumber({
      id: "one-time-number",
      faxJobId: job.id,
      e164: candidate.e164,
      areaCode: candidate.areaCode,
      providerId: candidate.e164,
      providerName: "demo",
      state: "active",
      mode: "send-only",
      forwardingEmail: "fax@example.com",
      setupPrice: null,
      monthlyPrice: candidate.monthlyPrice,
      provisionedAt: clock.now().toISOString(),
      earliestProviderReleaseAt: "2026-09-15T12:00:00.000Z",
      releasePolicy: "after-send",
      rentalMonths: null,
      nextBilledAt: null,
      releaseAt: null,
      expiresAt: null,
      releaseStartedAt: null,
      releasedAt: null,
      workflowId: "one-time-workflow",
      createdAt: clock.now().toISOString(),
      updatedAt: clock.now().toISOString(),
    });
    await repository.updateFaxJob(job.id, {
      state: "submitting",
      fromNumber: candidate.e164,
      temporaryNumberId: "one-time-number",
      updatedAt: clock.now().toISOString(),
    });
    const delivered = await fax.submitOutbound(job.id, {
      contentUrl: "https://fax.example.com/provider-content/token",
      callbackUrl: "https://fax.example.com/webhooks/sinch",
    });
    await repository.updateFaxJob(job.id, {
      state: "submitted",
      updatedAt: clock.now().toISOString(),
    });
    clock.advance(20 * 60_000);

    const result = await runSafetySweep({ repository, numbers, fax, audit, clock });

    expect(delivered.providerFaxId).toBeTruthy();
    expect(result.reconciledFaxes).toBe(1);
    expect(result.released).toBe(0);
    expect(result.deferred).toBe(1);
    expect((await repository.getFaxJob(job.id))?.state).toBe("delivered");
    expect(await repository.getTemporaryNumber("one-time-number")).toMatchObject({
      state: "expiring",
      releaseAt: "2026-09-15T12:00:00.000Z",
    });
  });

  it("recovers a stale uncertain fax from its submission record without a D1 provider id", async () => {
    const clock = new FixedClock(new Date("2026-08-16T12:00:00.000Z"));
    const provider = new DemoFaxProvider();
    const repository = new MemoryRepository();
    const documents = new MemoryDocumentStore();
    const audit = new AuditService(repository, documents, clock);
    const fax = new FaxService({ repository, documents, audit, provider, clock, defaultPhoneCountry: "US" });
    const numbers = new NumberService({ repository, audit, provider, clock, maxTtlDays: 365 });
    const job = await fax.createDraft({
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
    await fax.submitOutbound(job.id, {
      contentUrl: "https://fax.example.com/provider-content/token",
      callbackUrl: "https://fax.example.com/webhooks/demo/fax",
    });
    await repository.updateFaxJob(job.id, {
      state: "status_unknown",
      providerFaxId: null,
      completedAt: null,
      failureCode: "submission_in_progress",
      updatedAt: clock.now().toISOString(),
    });
    clock.advance(16 * 60_000);

    const result = await runSafetySweep({ repository, numbers, fax, audit, clock });

    expect(result.reconciledFaxes).toBe(1);
    expect(await repository.getFaxJob(job.id)).toMatchObject({
      state: "delivered",
      providerFaxId: expect.any(String),
    });
  });

  it("rechecks overdue numbers after billing reconciliation moves the release date", async () => {
    const clock = new FixedClock(new Date("2026-09-16T11:30:00.000Z"));
    const provider = new DemoFaxProvider();
    const repository = new MemoryRepository();
    const documents = new MemoryDocumentStore();
    const audit = new AuditService(repository, documents, clock);
    const fax = new FaxService({ repository, documents, audit, provider, clock, defaultPhoneCountry: "US" });
    const numbers = new NumberService({ repository, audit, provider, clock, maxTtlDays: 365 });
    const job = await fax.createDraft({
      mode: "receive-only",
      toNumber: null,
      requestedTtlDays: null,
      requestedRentalMonths: 1,
      coverData: null,
    });
    const candidate = (
      await provider.searchNumbers({ areaCodes: ["615"], countryCode: "US", limitPerAreaCode: 1 })
    )[0]!;
    await provider.provisionNumber({ candidate, correlationId: job.correlationId });
    await repository.createTemporaryNumber({
      id: "billing-shift-number",
      faxJobId: job.id,
      e164: candidate.e164,
      areaCode: candidate.areaCode,
      providerId: candidate.e164,
      providerName: "demo",
      state: "active",
      mode: "receive-only",
      forwardingEmail: "fax@example.com",
      setupPrice: null,
      monthlyPrice: candidate.monthlyPrice,
      provisionedAt: "2026-08-16T12:00:00.000Z",
      earliestProviderReleaseAt: null,
      releasePolicy: "scheduled",
      rentalMonths: 1,
      nextBilledAt: "2026-09-16T12:00:00.000Z",
      releaseAt: "2026-09-16T11:00:00.000Z",
      expiresAt: "2026-09-16T11:00:00.000Z",
      releaseStartedAt: null,
      releasedAt: null,
      workflowId: "billing-shift-workflow",
      createdAt: "2026-08-16T12:00:00.000Z",
      updatedAt: "2026-08-16T12:00:00.000Z",
    });
    const getNumber = provider.getNumber.bind(provider);
    vi.spyOn(provider, "getNumber").mockImplementation(async (e164) => ({
      ...(await getNumber(e164))!,
      nextBilledAt: "2026-09-20T12:00:00.000Z",
    }));
    const release = vi.spyOn(provider, "releaseNumber");

    const result = await runSafetySweep({ repository, numbers, fax, audit, clock });

    expect(result.released).toBe(0);
    expect(release).not.toHaveBeenCalled();
    expect(await repository.getTemporaryNumber("billing-shift-number")).toMatchObject({
      state: "active",
      releaseAt: "2026-09-20T11:00:00.000Z",
    });
  });

  it("audits invalid active numbers and release failures with fax correlation context", async () => {
    const clock = new FixedClock(new Date("2026-08-17T12:00:00.000Z"));
    const provider = new DemoFaxProvider();
    const repository = new MemoryRepository();
    const documents = new MemoryDocumentStore();
    const audit = new AuditService(repository, documents, clock);
    const fax = new FaxService({ repository, documents, audit, provider, clock, defaultPhoneCountry: "US" });
    const numbers = new NumberService({ repository, audit, provider, clock, maxTtlDays: 365 });
    const mismatchedJob = await fax.createDraft({
      mode: "receive-only",
      toNumber: null,
      requestedTtlDays: 1,
      coverData: null,
    });
    const missingNumberJob = await fax.createDraft({
      mode: "receive-only",
      toNumber: null,
      requestedTtlDays: 1,
      coverData: null,
    });
    const baseNumber = {
      areaCode: "615",
      state: "active" as const,
      mode: "receive-only" as const,
      forwardingEmail: "fax@example.com",
      setupPrice: null,
      monthlyPrice: { amount: "0.50", currency: "USD", intervalMonths: 1 },
      provisionedAt: "2026-08-16T12:00:00.000Z",
      earliestProviderReleaseAt: null,
      releasePolicy: "scheduled" as const,
      rentalMonths: 1,
      nextBilledAt: "2026-08-17T13:00:00.000Z",
      releaseAt: "2026-08-17T11:00:00.000Z",
      expiresAt: "2026-08-17T11:00:00.000Z",
      releaseStartedAt: null,
      releasedAt: null,
      workflowId: "invalid-number-workflow",
      createdAt: "2026-08-16T12:00:00.000Z",
      updatedAt: "2026-08-16T12:00:00.000Z",
    };
    await repository.createTemporaryNumber({
      ...baseNumber,
      id: "provider-mismatch-number",
      faxJobId: mismatchedJob.id,
      e164: "+16155550199",
      providerId: "provider-mismatch",
      providerName: "signalwire",
    });
    await repository.createTemporaryNumber({
      ...baseNumber,
      id: "missing-e164-number",
      faxJobId: missingNumberJob.id,
      e164: null,
      providerId: null,
      providerName: "demo",
    });

    const result = await runSafetySweep({ repository, numbers, fax, audit, clock });

    expect(result).toMatchObject({ numberReconcileFailed: 2, failed: 0 });
    for (const [numberId, job] of [
      ["provider-mismatch-number", mismatchedJob],
      ["missing-e164-number", missingNumberJob],
    ] as const) {
      const events = await repository.listEventsForNumber(numberId);
      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({
          correlationId: job.correlationId,
          faxJobId: job.id,
          temporaryNumberId: numberId,
          type: "number.reconcile_failed",
        }),
      ]));
      expect(events.some((event) => event.type === "number.release_sweep_failed")).toBe(false);
    }
  });
});
