import { describe, expect, it, vi } from "vitest";

import { FixedClock } from "../../domain/clock";
import { DemoFaxProvider } from "../../providers/demo-fax-provider";
import { MemoryRepository } from "../repositories/memory-repository";
import { MemoryDocumentStore } from "../storage/document-store";
import { AuditService } from "./audit-service";
import { FaxService } from "./fax-service";
import { NumberService } from "./number-service";

describe("NumberService", () => {
  it("refuses to provision a number without a monthly rental quote", async () => {
    const { fax, numbers, provider } = createServices();
    const job = await fax.createDraft({
      mode: "receive-only",
      toNumber: null,
      requestedTtlDays: null,
      requestedRentalMonths: 1,
      coverData: null,
    });
    await fax.prepare(job.id, null, null);
    const candidate = (
      await provider.searchNumbers({ areaCodes: ["615"], countryCode: "US", limitPerAreaCode: 1 })
    )[0]!;

    await expect(numbers.requestNumber(job.id, { ...candidate, monthlyPrice: null }, "fax@example.com"))
      .rejects.toThrow(/monthly rental (?:price|estimate)/i);
  });

  it("schedules a one-time sending number at SignalWire's Trial Mode release boundary", async () => {
    const { fax, numbers, provider } = createServices({ minimumNumberHoldDays: 30 });
    const job = await fax.createDraft({
      mode: "send-only",
      toNumber: "+16155550123",
      requestedTtlDays: null,
      coverData: null,
    });
    await fax.registerDocument(job.id, {
      id: "document-send-only",
      kind: "final-packet",
      objectKey: "faxes/send-only/final.pdf",
      mimeType: "application/pdf",
      byteCount: 123,
      pageCount: 1,
      sha256: "send-only",
      displayName: "fax.pdf",
    });
    await fax.prepare(job.id, "document-send-only", 1);
    const candidate = (
      await provider.searchNumbers({ areaCodes: ["615"], countryCode: "US", limitPerAreaCode: 1 })
    )[0]!;

    const requested = await numbers.requestNumber(job.id, candidate, "fax@example.com");
    const active = await numbers.provisionNumber(requested.id, candidate);

    expect(active).toMatchObject({
      releasePolicy: "after-send",
      releaseAt: "2026-09-15T12:00:00.000Z",
      expiresAt: "2026-09-15T12:00:00.000Z",
    });
  });

  it("provisions receive-only service with email routing and expiration", async () => {
    const { fax, numbers, provider, repository } = createServices();
    const job = await fax.createDraft({
      mode: "receive-only",
      toNumber: null,
      requestedTtlDays: 3,
      coverData: null,
    });
    await fax.prepare(job.id, null, null);
    const candidate = (
      await provider.searchNumbers({ areaCodes: ["615"], countryCode: "US", limitPerAreaCode: 1 })
    )[0]!;
    const requested = await numbers.requestNumber(job.id, candidate, "fax@example.com");
    const active = await numbers.provisionNumber(requested.id, candidate);

    expect(active.state).toBe("active");
    expect(active.expiresAt).toBe("2026-08-19T12:00:00.000Z");
    expect((await repository.getFaxJob(job.id))?.state).toBe("active");
  });

  it("updates the active receiving line and provider forwarding route", async () => {
    const { fax, numbers, provider, repository } = createServices();
    const job = await fax.createDraft({
      mode: "receive-only",
      toNumber: null,
      requestedTtlDays: 3,
      coverData: null,
    });
    await fax.prepare(job.id, null, null);
    const candidate = (
      await provider.searchNumbers({ areaCodes: ["615"], countryCode: "US", limitPerAreaCode: 1 })
    )[0]!;
    const requested = await numbers.requestNumber(job.id, candidate, "old@example.com");
    await numbers.provisionNumber(requested.id, candidate);
    const configure = vi.spyOn(provider, "configureInboundNumber");
    const remove = vi.spyOn(provider, "removeInboundNumberRouting");

    const updated = await numbers.updateForwardingEmail(requested.id, "new@example.com");

    expect(updated.forwardingEmail).toBe("new@example.com");
    expect(configure).toHaveBeenCalledWith(expect.objectContaining({
      e164: candidate.e164,
      email: "new@example.com",
    }));
    expect(remove).toHaveBeenCalledWith(expect.objectContaining({
      e164: candidate.e164,
      email: "old@example.com",
    }));
    expect((await repository.listEventsForNumber(requested.id)).at(-1)?.type).toBe(
      "number.forwarding_updated",
    );
  });

  it("schedules release before the selected monthly term renews", async () => {
    const { fax, numbers, provider } = createServices();
    const job = await fax.createDraft({
      mode: "receive-only",
      toNumber: null,
      requestedTtlDays: null,
      requestedRentalMonths: 2,
      coverData: null,
    });
    await fax.prepare(job.id, null, null);
    const candidate = (
      await provider.searchNumbers({ areaCodes: ["615"], countryCode: "US", limitPerAreaCode: 1 })
    )[0]!;
    const provision = provider.provisionNumber.bind(provider);
    vi.spyOn(provider, "provisionNumber").mockImplementation(async (input) => ({
      ...(await provision(input)),
      nextBilledAt: "2026-09-16T12:00:00.000Z",
    }));

    const requested = await numbers.requestNumber(job.id, candidate, "fax@example.com");
    const active = await numbers.provisionNumber(requested.id, candidate);

    expect(active).toMatchObject({
      releasePolicy: "scheduled",
      rentalMonths: 2,
      nextBilledAt: "2026-09-16T12:00:00.000Z",
      releaseAt: "2026-10-16T11:00:00.000Z",
    });
  });

  it("keeps a receive line until manual release when no term is selected", async () => {
    const { fax, numbers, provider } = createServices();
    const job = await fax.createDraft({
      mode: "receive-only",
      toNumber: null,
      requestedTtlDays: null,
      requestedRentalMonths: null,
      coverData: null,
    });
    await fax.prepare(job.id, null, null);
    const candidate = (
      await provider.searchNumbers({ areaCodes: ["615"], countryCode: "US", limitPerAreaCode: 1 })
    )[0]!;

    const requested = await numbers.requestNumber(job.id, candidate, "fax@example.com");
    const active = await numbers.provisionNumber(requested.id, candidate);

    expect(active).toMatchObject({ releasePolicy: "manual", releaseAt: null, expiresAt: null });
  });

  it("defers a manual release until SignalWire permits the number to be released", async () => {
    const { fax, numbers, provider, repository, audit, clock } = createServices({ minimumNumberHoldDays: 30 });
    const job = await fax.createDraft({
      mode: "receive-only",
      toNumber: null,
      requestedTtlDays: null,
      requestedRentalMonths: null,
      coverData: null,
    });
    await fax.prepare(job.id, null, null);
    const candidate = (
      await provider.searchNumbers({ areaCodes: ["615"], countryCode: "US", limitPerAreaCode: 1 })
    )[0]!;
    const requested = await numbers.requestNumber(job.id, candidate, "fax@example.com");
    const active = await numbers.provisionNumber(requested.id, candidate);
    const release = vi.spyOn(provider, "releaseNumber");

    expect(active).toMatchObject({
      earliestProviderReleaseAt: "2026-09-15T12:00:00.000Z",
    });

    const fundedAccountNumbers = new NumberService({
      repository,
      audit,
      provider,
      clock,
      maxTtlDays: 365,
      minimumNumberHoldDays: 14,
    });
    clock.set(new Date("2026-08-30T12:00:00.000Z"));

    const deferred = await fundedAccountNumbers.releaseNumber(requested.id);

    expect(deferred).toMatchObject({
      state: "expiring",
      releasePolicy: "scheduled",
      releaseAt: "2026-09-15T12:00:00.000Z",
      expiresAt: "2026-09-15T12:00:00.000Z",
    });
    expect(release).not.toHaveBeenCalled();
    expect((await repository.listEventsForNumber(requested.id)).at(-1)?.type).toBe(
      "number.release_deferred",
    );

    clock.set(new Date("2026-09-15T12:00:00.000Z"));
    expect(await fundedAccountNumbers.releaseNumber(requested.id)).toMatchObject({ state: "released" });
    expect(release).toHaveBeenCalledOnce();
  });

  it("atomically permits only one number request for a prepared fax", async () => {
    const { fax, numbers, provider, repository } = createServices();
    const job = await fax.createDraft({
      mode: "receive-only",
      toNumber: null,
      requestedTtlDays: 3,
      coverData: null,
    });
    await fax.prepare(job.id, null, null);
    const candidate = (
      await provider.searchNumbers({ areaCodes: ["615"], countryCode: "US", limitPerAreaCode: 1 })
    )[0]!;

    const attempts = await Promise.allSettled([
      numbers.requestNumber(job.id, candidate, "fax@example.com"),
      numbers.requestNumber(job.id, candidate, "fax@example.com"),
    ]);

    expect(attempts.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(await repository.listActiveNumbers()).toHaveLength(1);
  });

  it("atomically permits only one pending retained line across household fax jobs", async () => {
    const { fax, numbers, provider, repository } = createServices();
    const jobs = await Promise.all(["first", "second"].map(async () => {
      const job = await fax.createDraft({
        mode: "receive-only",
        toNumber: null,
        requestedTtlDays: 3,
        coverData: null,
      });
      await fax.prepare(job.id, null, null);
      return job;
    }));
    const candidate = (
      await provider.searchNumbers({ areaCodes: ["615"], countryCode: "US", limitPerAreaCode: 1 })
    )[0]!;

    const attempts = await Promise.allSettled(
      jobs.map((job) => numbers.requestNumber(job.id, candidate, "fax@example.com")),
    );

    expect(attempts.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect((await repository.listActiveNumbers()).filter(
      (number) => ["requested", "provisioning"].includes(number.state),
    )).toHaveLength(1);
  });

  it("reports an existing household-line cleanup before claiming another fax job", async () => {
    const { fax, numbers, provider, repository } = createServices();
    const first = await fax.createDraft({
      mode: "receive-only",
      toNumber: null,
      requestedTtlDays: 3,
      coverData: null,
    });
    await fax.prepare(first.id, null, null);
    const second = await fax.createDraft({
      mode: "receive-only",
      toNumber: null,
      requestedTtlDays: 3,
      coverData: null,
    });
    await fax.prepare(second.id, null, null);
    const candidate = (
      await provider.searchNumbers({ areaCodes: ["615"], countryCode: "US", limitPerAreaCode: 1 })
    )[0]!;
    const pending = await numbers.requestNumber(first.id, candidate, "fax@example.com");
    await repository.updateTemporaryNumber(pending.id, { state: "cleaning" });

    await expect(numbers.requestNumber(second.id, candidate, "fax@example.com")).rejects.toThrow(
      /already being opened/i,
    );
    expect(await repository.getFaxJob(second.id)).toMatchObject({ state: "prepared" });
  });

  it("calls the provider once when provisioning requests overlap", async () => {
    const { fax, numbers, provider } = createServices();
    const job = await fax.createDraft({
      mode: "receive-only",
      toNumber: null,
      requestedTtlDays: 3,
      coverData: null,
    });
    await fax.prepare(job.id, null, null);
    const candidate = (
      await provider.searchNumbers({ areaCodes: ["615"], countryCode: "US", limitPerAreaCode: 2 })
    )[0]!;
    const otherCandidate = {
      ...candidate,
      e164: "+16155550101",
    };
    const requested = await numbers.requestNumber(job.id, candidate, "fax@example.com");
    const provisionNumber = provider.provisionNumber.bind(provider);
    let releaseProvider!: () => void;
    const providerGate = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    const provision = vi.spyOn(provider, "provisionNumber").mockImplementation(async (input) => {
      await providerGate;
      return provisionNumber(input);
    });

    const first = numbers.provisionNumber(requested.id, candidate);
    await vi.waitFor(() => expect(provision).toHaveBeenCalledOnce());
    const sameCandidate = await numbers.provisionNumber(requested.id, candidate);
    await expect(numbers.provisionNumber(requested.id, otherCandidate)).rejects.toThrow(
      /different provider number/i,
    );
    releaseProvider();

    expect(sameCandidate.state).toBe("provisioning");
    expect((await first).state).toBe("active");
    expect(provision).toHaveBeenCalledOnce();
  });

  it("marks a number request failed when its workflow cannot start", async () => {
    const { fax, numbers, provider, repository } = createServices();
    const job = await fax.createDraft({
      mode: "receive-only",
      toNumber: null,
      requestedTtlDays: 3,
      coverData: null,
    });
    await fax.prepare(job.id, null, null);
    const candidate = (
      await provider.searchNumbers({ areaCodes: ["615"], countryCode: "US", limitPerAreaCode: 1 })
    )[0]!;
    const requested = await numbers.requestNumber(job.id, candidate, "fax@example.com");

    const failed = await numbers.abortNumberRequest(
      requested.id,
      "The number workflow could not be started.",
    );

    expect(failed.state).toBe("provision_failed");
    expect(await repository.getFaxJob(job.id)).toMatchObject({
      state: "failed",
      failureCode: "number_workflow_start_failed",
    });
  });

  it("fails the request cleanly if its durable audit event cannot be recorded", async () => {
    const { fax, numbers, provider, repository } = createServices();
    const job = await fax.createDraft({
      mode: "receive-only",
      toNumber: null,
      requestedTtlDays: 3,
      coverData: null,
    });
    await fax.prepare(job.id, null, null);
    const candidate = (
      await provider.searchNumbers({ areaCodes: ["615"], countryCode: "US", limitPerAreaCode: 1 })
    )[0]!;
    vi.spyOn(repository, "appendEvent").mockRejectedValueOnce(new Error("audit database unavailable"));

    await expect(numbers.requestNumber(job.id, candidate, "fax@example.com")).rejects.toThrow(
      /audit database unavailable/i,
    );

    expect(await repository.listActiveNumbers()).toHaveLength(0);
    expect(await repository.getFaxJob(job.id)).toMatchObject({
      state: "failed",
      failureCode: "number_request_initialization_failed",
    });
  });

  it("waits for an asynchronously configured provider number without renting again", async () => {
    const { fax, numbers, provider, repository } = createServices();
    const job = await fax.createDraft({
      mode: "receive-only",
      toNumber: null,
      requestedTtlDays: 3,
      coverData: null,
    });
    await fax.prepare(job.id, null, null);
    const candidate = (
      await provider.searchNumbers({ areaCodes: ["615"], countryCode: "US", limitPerAreaCode: 1 })
    )[0]!;
    const provision = vi.spyOn(provider, "provisionNumber").mockResolvedValue({
      e164: candidate.e164,
      providerId: candidate.e164,
      ready: false,
      nextBilledAt: null,
      raw: { scheduledVoiceProvisioning: true },
    });
    vi.spyOn(provider, "getNumber").mockResolvedValue({
      e164: candidate.e164,
      providerId: candidate.e164,
      ready: true,
      nextBilledAt: null,
      raw: { scheduledVoiceProvisioning: false },
    });
    const requested = await numbers.requestNumber(job.id, candidate, "fax@example.com");

    const pending = await numbers.provisionNumber(requested.id, candidate);
    const active = await numbers.reconcileProvisioning(requested.id);

    expect(pending).toMatchObject({ state: "provisioning", e164: candidate.e164 });
    expect(active.state).toBe("active");
    expect(provision).toHaveBeenCalledTimes(1);
    expect((await repository.getFaxJob(job.id))?.state).toBe("active");
  });

  it("repairs the owner fax when number activation outlives its first fax-state write", async () => {
    const { fax, numbers, provider, repository } = createServices();
    const job = await fax.createDraft({
      mode: "receive-only",
      toNumber: null,
      requestedTtlDays: 3,
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
    expect(await repository.getTemporaryNumber(requested.id)).toMatchObject({ state: "active" });
    expect(await repository.getFaxJob(job.id)).toMatchObject({ state: "provisioning" });

    expect(await numbers.reconcileProvisioning(requested.id)).toMatchObject({ state: "active" });
    expect(await repository.getFaxJob(job.id)).toMatchObject({
      state: "active",
      fromNumber: candidate.e164,
    });
  });

  it("retries idempotent inbound route configuration after a provider error", async () => {
    const { fax, numbers, provider, repository } = createServices();
    const job = await fax.createDraft({
      mode: "receive-only",
      toNumber: null,
      requestedTtlDays: 3,
      coverData: null,
    });
    await fax.prepare(job.id, null, null);
    const candidate = (
      await provider.searchNumbers({ areaCodes: ["615"], countryCode: "US", limitPerAreaCode: 1 })
    )[0]!;
    const requested = await numbers.requestNumber(job.id, candidate, "fax@example.com");
    const configure = vi.spyOn(provider, "configureInboundNumber")
      .mockRejectedValueOnce(new Error("route configuration unavailable"));
    const provision = vi.spyOn(provider, "provisionNumber");

    await expect(numbers.provisionNumber(requested.id, candidate)).rejects.toThrow(
      /route configuration unavailable/i,
    );
    expect(await repository.getTemporaryNumber(requested.id)).toMatchObject({ state: "provisioning" });

    expect(await numbers.reconcileProvisioning(requested.id)).toMatchObject({ state: "active" });
    expect(configure).toHaveBeenCalledTimes(2);
    expect(provision).toHaveBeenCalledOnce();
  });

  it("prevents provisioning cleanup from racing an activation in progress", async () => {
    const { fax, numbers, provider, repository } = createServices();
    const job = await fax.createDraft({
      mode: "receive-only",
      toNumber: null,
      requestedTtlDays: 3,
      coverData: null,
    });
    await fax.prepare(job.id, null, null);
    const candidate = (
      await provider.searchNumbers({ areaCodes: ["615"], countryCode: "US", limitPerAreaCode: 1 })
    )[0]!;
    const requested = await numbers.requestNumber(job.id, candidate, "fax@example.com");
    const configureInboundNumber = provider.configureInboundNumber.bind(provider);
    let releaseConfiguration!: () => void;
    const configurationGate = new Promise<void>((resolve) => {
      releaseConfiguration = resolve;
    });
    const configure = vi.spyOn(provider, "configureInboundNumber").mockImplementation(async (input) => {
      await configurationGate;
      return configureInboundNumber(input);
    });
    const release = vi.spyOn(provider, "releaseNumber");

    const activation = numbers.provisionNumber(requested.id, candidate);
    await vi.waitFor(() => expect(configure).toHaveBeenCalledOnce());
    expect(await repository.getTemporaryNumber(requested.id)).toMatchObject({ state: "activating" });
    expect(await numbers.reconcileProvisioning(requested.id)).toMatchObject({ state: "activating" });
    expect(configure).toHaveBeenCalledOnce();
    await expect(numbers.failProvisioning(requested.id, "stale workflow cleanup")).rejects.toThrow(
      /cannot be failed safely/i,
    );
    expect(release).not.toHaveBeenCalled();
    releaseConfiguration();

    expect(await activation).toMatchObject({ state: "active" });
    expect(await repository.getFaxJob(job.id)).toMatchObject({ state: "active" });
  });

  it("prevents activation from racing a provisioning cleanup in progress", async () => {
    const { fax, numbers, provider, repository } = createServices();
    const job = await fax.createDraft({
      mode: "receive-only",
      toNumber: null,
      requestedTtlDays: 3,
      coverData: null,
    });
    await fax.prepare(job.id, null, null);
    const candidate = (
      await provider.searchNumbers({ areaCodes: ["615"], countryCode: "US", limitPerAreaCode: 1 })
    )[0]!;
    const requested = await numbers.requestNumber(job.id, candidate, "fax@example.com");
    await provider.provisionNumber({ candidate, correlationId: job.correlationId });
    await repository.updateTemporaryNumber(requested.id, {
      state: "provisioning",
      e164: candidate.e164,
      providerId: candidate.e164,
      provisionedAt: "2026-08-16T12:00:00.000Z",
    });
    const removeInboundNumberRouting = provider.removeInboundNumberRouting.bind(provider);
    let continueCleanup!: () => void;
    const cleanupGate = new Promise<void>((resolve) => {
      continueCleanup = resolve;
    });
    const remove = vi.spyOn(provider, "removeInboundNumberRouting").mockImplementation(async (input) => {
      await cleanupGate;
      return removeInboundNumberRouting(input);
    });

    const cleanup = numbers.failProvisioning(requested.id, "stale workflow cleanup");
    await vi.waitFor(() => expect(remove).toHaveBeenCalledOnce());
    expect(await repository.getTemporaryNumber(requested.id)).toMatchObject({ state: "cleaning" });
    await expect(numbers.reconcileProvisioning(requested.id)).rejects.toThrow(/cannot be reconciled/i);
    continueCleanup();

    expect(await cleanup).toMatchObject({ state: "provision_failed", e164: null });
    expect(await repository.getFaxJob(job.id)).toMatchObject({ state: "failed" });
  });

  it("does not rent again when provider success outlives local result persistence", async () => {
    const { fax, numbers, provider, repository } = createServices();
    const job = await fax.createDraft({
      mode: "receive-only",
      toNumber: null,
      requestedTtlDays: 3,
      coverData: null,
    });
    await fax.prepare(job.id, null, null);
    const candidate = (
      await provider.searchNumbers({ areaCodes: ["615"], countryCode: "US", limitPerAreaCode: 1 })
    )[0]!;
    const provision = vi.spyOn(provider, "provisionNumber");
    const requested = await numbers.requestNumber(job.id, candidate, "fax@example.com");
    const updateNumber = repository.updateTemporaryNumberIfState.bind(repository);
    let failProviderResult = true;
    vi.spyOn(repository, "updateTemporaryNumberIfState").mockImplementation(async (id, expected, patch) => {
      if (failProviderResult && patch.provisionedAt) {
        failProviderResult = false;
        throw new Error("D1 number result persistence unavailable");
      }
      return updateNumber(id, expected, patch);
    });

    await expect(numbers.provisionNumber(requested.id, candidate)).rejects.toThrow(
      /result persistence unavailable/i,
    );
    expect(await repository.getTemporaryNumber(requested.id)).toMatchObject({
      state: "provisioning",
      e164: candidate.e164,
    });

    const recovered = await numbers.provisionNumber(requested.id, candidate);

    expect(recovered.state).toBe("active");
    expect(provision).toHaveBeenCalledTimes(1);
  });

  it("keeps an ambiguous rental recoverable and releases the exact candidate on failure", async () => {
    const { fax, numbers, provider, repository } = createServices();
    const job = await fax.createDraft({
      mode: "receive-only",
      toNumber: null,
      requestedTtlDays: 3,
      coverData: null,
    });
    await fax.prepare(job.id, null, null);
    const candidate = (
      await provider.searchNumbers({ areaCodes: ["615"], countryCode: "US", limitPerAreaCode: 1 })
    )[0]!;
    vi.spyOn(provider, "provisionNumber").mockRejectedValue(new Error("connection closed"));
    const release = vi.spyOn(provider, "releaseNumber");
    const requested = await numbers.requestNumber(job.id, candidate, "fax@example.com");

    await expect(numbers.provisionNumber(requested.id, candidate)).rejects.toThrow(
      /connection closed/i,
    );
    expect(await repository.getTemporaryNumber(requested.id)).toMatchObject({
      state: "provisioning",
      e164: candidate.e164,
    });

    const failed = await numbers.failProvisioning(requested.id, "Provider setup never became ready.");

    expect(failed).toMatchObject({ state: "provision_failed", e164: null });
    expect(release).toHaveBeenCalledWith(candidate.e164, job.correlationId);
    expect(await repository.getFaxJob(job.id)).toMatchObject({
      state: "failed",
      failureCode: "number_provision_failed",
    });
  });

  it("defers cleanup of an ambiguous SignalWire rental until its hold ends", async () => {
    const { fax, numbers, provider, repository } = createServices({ minimumNumberHoldDays: 30 });
    const job = await fax.createDraft({
      mode: "receive-only",
      toNumber: null,
      requestedTtlDays: null,
      requestedRentalMonths: 1,
      coverData: null,
    });
    await fax.prepare(job.id, null, null);
    const candidate = (
      await provider.searchNumbers({ areaCodes: ["615"], countryCode: "US", limitPerAreaCode: 1 })
    )[0]!;
    vi.spyOn(provider, "provisionNumber").mockRejectedValue(new Error("connection closed"));
    const release = vi.spyOn(provider, "releaseNumber");
    const requested = await numbers.requestNumber(job.id, candidate, "fax@example.com");

    await expect(numbers.provisionNumber(requested.id, candidate)).rejects.toThrow();
    const deferred = await numbers.failProvisioning(
      requested.id,
      "Provider setup never became ready.",
    );

    expect(deferred).toMatchObject({
      state: "release_failed",
      e164: candidate.e164,
      releaseAt: "2026-09-15T12:00:00.000Z",
      expiresAt: "2026-09-15T12:00:00.000Z",
    });
    expect(release).not.toHaveBeenCalled();
    expect((await repository.listEventsForNumber(requested.id)).at(-1)?.type).toBe(
      "number.provision_cleanup_deferred",
    );
  });

  it("surfaces a failed provisioning cleanup for UI and scheduled recovery", async () => {
    const { fax, numbers, provider, repository } = createServices();
    const job = await fax.createDraft({
      mode: "receive-only",
      toNumber: null,
      requestedTtlDays: 3,
      coverData: null,
    });
    await fax.prepare(job.id, null, null);
    const candidate = (
      await provider.searchNumbers({ areaCodes: ["615"], countryCode: "US", limitPerAreaCode: 1 })
    )[0]!;
    vi.spyOn(provider, "provisionNumber").mockRejectedValue(new Error("connection closed"));
    vi.spyOn(provider, "releaseNumber").mockRejectedValue(new Error("release unavailable"));
    const requested = await numbers.requestNumber(job.id, candidate, "fax@example.com");

    await expect(numbers.provisionNumber(requested.id, candidate)).rejects.toThrow();
    const failed = await numbers.failProvisioning(requested.id, "Provider setup never became ready.");

    expect(failed).toMatchObject({
      state: "release_failed",
      e164: candidate.e164,
      expiresAt: "2026-08-16T12:00:00.000Z",
    });
    expect((await repository.listOverdueNumbers("2026-08-16T12:00:00.000Z"))[0]?.id).toBe(
      requested.id,
    );
  });

  it("adds calendar months to a scheduled release and can cancel the schedule", async () => {
    const { fax, numbers, provider } = createServices();
    const job = await fax.createDraft({
      mode: "receive-only",
      toNumber: null,
      requestedTtlDays: null,
      requestedRentalMonths: 1,
      coverData: null,
    });
    await fax.prepare(job.id, null, null);
    const candidate = (
      await provider.searchNumbers({ areaCodes: ["615"], countryCode: "US", limitPerAreaCode: 1 })
    )[0]!;
    const provision = provider.provisionNumber.bind(provider);
    vi.spyOn(provider, "provisionNumber").mockImplementation(async (input) => ({
      ...(await provision(input)),
      nextBilledAt: "2026-09-16T12:00:00.000Z",
    }));
    const requested = await numbers.requestNumber(job.id, candidate, "fax@example.com");
    await numbers.provisionNumber(requested.id, candidate);

    expect((await numbers.extendNumber(requested.id, 1)).releaseAt).toBe("2026-10-16T11:00:00.000Z");
    expect(await numbers.cancelScheduledRelease(requested.id)).toMatchObject({
      releasePolicy: "manual",
      releaseAt: null,
    });
  });

  it("reconciles provider absence and billing metadata for active numbers", async () => {
    const { fax, numbers, provider, repository } = createServices();
    const job = await fax.createDraft({
      mode: "receive-only",
      toNumber: null,
      requestedTtlDays: null,
      requestedRentalMonths: 1,
      coverData: null,
    });
    await fax.prepare(job.id, null, null);
    const candidate = (
      await provider.searchNumbers({ areaCodes: ["615"], countryCode: "US", limitPerAreaCode: 1 })
    )[0]!;
    const requested = await numbers.requestNumber(job.id, candidate, "fax@example.com");
    await numbers.provisionNumber(requested.id, candidate);
    const current = (await repository.getTemporaryNumber(requested.id))!;
    const getNumber = provider.getNumber.bind(provider);
    vi.spyOn(provider, "getNumber").mockImplementationOnce(async (e164) => ({
      ...(await getNumber(e164))!,
      nextBilledAt: "2026-09-20T12:00:00.000Z",
    }));

    expect(await numbers.reconcileActiveNumber(requested.id)).toMatchObject({
      nextBilledAt: "2026-09-20T12:00:00.000Z",
      releaseAt: expect.any(String),
    });
    const reconciled = (await repository.getTemporaryNumber(requested.id))!;
    const previousBoundary = new Date(current.nextBilledAt!).getTime();
    const boundaryShift = new Date("2026-09-20T12:00:00.000Z").getTime() - previousBoundary;
    expect(reconciled.releaseAt).toBe(
      new Date(new Date(current.releaseAt!).getTime() + boundaryShift).toISOString(),
    );
    await provider.releaseNumber(candidate.e164, job.correlationId);
    expect(await numbers.reconcileActiveNumber(requested.id)).toMatchObject({ state: "released" });
    expect((await repository.listEventsForNumber(current.id)).map((event) => event.type)).toEqual(
      expect.arrayContaining(["number.billing_reconciled", "number.provider_absent"]),
    );
  });

  it("does not extend a scheduled rental when the provider advances a consumed billing boundary", async () => {
    const { fax, numbers, provider, repository, clock } = createServices();
    const job = await fax.createDraft({
      mode: "receive-only",
      toNumber: null,
      requestedTtlDays: null,
      requestedRentalMonths: 2,
      coverData: null,
    });
    await fax.prepare(job.id, null, null);
    const candidate = (
      await provider.searchNumbers({ areaCodes: ["615"], countryCode: "US", limitPerAreaCode: 1 })
    )[0]!;
    const provision = provider.provisionNumber.bind(provider);
    vi.spyOn(provider, "provisionNumber").mockImplementation(async (input) => ({
      ...(await provision(input)),
      nextBilledAt: "2026-09-16T12:00:00.000Z",
    }));
    const requested = await numbers.requestNumber(job.id, candidate, "fax@example.com");
    const active = await numbers.provisionNumber(requested.id, candidate);
    clock.advance(31 * 86_400_000);
    const getNumber = provider.getNumber.bind(provider);
    vi.spyOn(provider, "getNumber").mockImplementationOnce(async (e164) => ({
      ...(await getNumber(e164))!,
      nextBilledAt: "2026-10-16T12:00:00.000Z",
    }));

    expect(await numbers.reconcileActiveNumber(requested.id)).toMatchObject({
      nextBilledAt: "2026-10-16T12:00:00.000Z",
      releaseAt: active.releaseAt,
    });
    expect((await repository.getTemporaryNumber(requested.id))?.releaseAt).toBe(active.releaseAt);
  });

  it("records a failed release for operator recovery", async () => {
    const { fax, numbers, provider, repository } = createServices();
    const job = await fax.createDraft({
      mode: "receive-only",
      toNumber: null,
      requestedTtlDays: 1,
      coverData: null,
    });
    await fax.prepare(job.id, null, null);
    const candidate = (
      await provider.searchNumbers({ areaCodes: ["615"], countryCode: "US", limitPerAreaCode: 3 })
    )[2]!;
    const requested = await numbers.requestNumber(job.id, candidate, "fax@example.com");
    await numbers.provisionNumber(requested.id, candidate);

    await expect(numbers.releaseNumber(requested.id)).rejects.toThrow(/demo release failure/i);
    expect((await repository.getTemporaryNumber(requested.id))?.state).toBe("release_failed");
    expect((await repository.listEventsForNumber(requested.id)).at(-1)?.type).toBe("number.release_failed");
  });

  it("keeps an after-send number until the fax is terminal even after the hold ends", async () => {
    const { fax, numbers, provider, repository, clock } = createServices({ minimumNumberHoldDays: 30 });
    const job = await fax.createDraft({
      mode: "send-only",
      toNumber: "+16155550123",
      requestedTtlDays: null,
      coverData: null,
    });
    await fax.registerDocument(job.id, {
      id: "document-after-send-hold",
      kind: "final-packet",
      objectKey: "faxes/after-send-hold/final.pdf",
      mimeType: "application/pdf",
      byteCount: 123,
      pageCount: 1,
      sha256: "after-send-hold",
      displayName: "fax.pdf",
    });
    await fax.prepare(job.id, "document-after-send-hold", 1);
    const candidate = (
      await provider.searchNumbers({ areaCodes: ["615"], countryCode: "US", limitPerAreaCode: 1 })
    )[0]!;
    const requested = await numbers.requestNumber(job.id, candidate, "fax@example.com");
    await numbers.provisionNumber(requested.id, candidate);
    const release = vi.spyOn(provider, "releaseNumber");
    clock.advance(30 * 86_400_000 + 1);

    expect(await numbers.releaseNumber(requested.id)).toMatchObject({ state: "active" });
    expect(release).not.toHaveBeenCalled();
    await repository.updateFaxJob(job.id, { state: "delivered", updatedAt: clock.now().toISOString() });

    expect(await numbers.releaseNumber(requested.id)).toMatchObject({ state: "released" });
    expect(release).toHaveBeenCalledOnce();
  });

  it("does not mark a number released through the wrong provider", async () => {
    const { fax, numbers, provider, repository } = createServices();
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
    const active = await numbers.provisionNumber(requested.id, candidate);
    const sinchOwned = { ...active, id: "sinch-owned-number", providerName: "sinch" as const };
    await repository.createTemporaryNumber(sinchOwned);
    const release = vi.spyOn(provider, "releaseNumber");

    await expect(numbers.releaseNumber(sinchOwned.id)).rejects.toThrow(/belongs to sinch/i);

    expect(release).not.toHaveBeenCalled();
    expect(await repository.getTemporaryNumber(sinchOwned.id)).toMatchObject({ state: "active" });
  });

  it("keeps a number recoverable when the provider has not confirmed its release", async () => {
    const { fax, numbers, provider, repository } = createServices();
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
    vi.spyOn(provider, "releaseNumber").mockResolvedValue({
      released: false,
      raw: { status: 202 },
    });

    await expect(numbers.releaseNumber(requested.id)).rejects.toThrow(/still reports this number as active/i);

    expect(await repository.getTemporaryNumber(requested.id)).toMatchObject({ state: "release_failed" });
    expect((await repository.listEventsForNumber(requested.id)).at(-1)?.type).toBe("number.release_failed");
  });

  it("releases idempotently", async () => {
    const { fax, numbers, provider } = createServices();
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

    expect((await numbers.releaseNumber(requested.id)).state).toBe("released");
    expect((await numbers.releaseNumber(requested.id)).state).toBe("released");
  });

  it("calls the provider once when release requests overlap", async () => {
    const { fax, numbers, provider } = createServices();
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
    const releaseNumber = provider.releaseNumber.bind(provider);
    let releaseProvider!: () => void;
    const providerGate = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    const release = vi.spyOn(provider, "releaseNumber").mockImplementation(async (...input) => {
      await providerGate;
      return releaseNumber(...input);
    });

    const first = numbers.releaseNumber(requested.id);
    await vi.waitFor(() => expect(release).toHaveBeenCalledOnce());
    const overlapping = await numbers.releaseNumber(requested.id);
    releaseProvider();

    expect(overlapping.state).toBe("releasing");
    expect((await first).state).toBe("released");
    expect(release).toHaveBeenCalledOnce();
  });
});

function createServices(options: { minimumNumberHoldDays?: number } = {}) {
  const clock = new FixedClock(new Date("2026-08-16T12:00:00.000Z"));
  const provider = new DemoFaxProvider();
  const repository = new MemoryRepository();
  const documents = new MemoryDocumentStore();
  const audit = new AuditService(repository, documents, clock, () => crypto.randomUUID());
  const fax = new FaxService({
    repository,
    documents,
    audit,
    provider,
    clock,
    defaultPhoneCountry: "US",
  });
  const numbers = new NumberService({
    repository,
    audit,
    provider,
    clock,
    maxTtlDays: 365,
    minimumNumberHoldDays: options.minimumNumberHoldDays ?? 0,
  });
  return { fax, numbers, provider, repository, documents, audit, clock };
}
