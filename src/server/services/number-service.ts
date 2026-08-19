import type { Clock } from "../../domain/clock";
import { ConflictError, NotFoundError } from "../../domain/errors";
import { transitionFax } from "../../domain/fax-state";
import { transitionNumber } from "../../domain/number-state";
import type {
  FaxProvider,
  NumberCandidate,
  ProvisionedNumber,
} from "../../providers/fax-provider";
import type { FaxJob, TemporaryNumber } from "../../shared/contracts";
import type { Repository } from "../repositories/types";
import type { AuditService } from "./audit-service";

export class NumberService {
  private readonly idGenerator: () => string;

  constructor(
    private readonly dependencies: {
      repository: Repository;
      audit: AuditService;
      provider: FaxProvider;
      clock: Clock;
      maxTtlDays: number;
      maxRentalMonths?: number;
      minimumNumberHoldDays?: number;
      inboundCallbackUrl?: string;
      idGenerator?: () => string;
    },
  ) {
    this.idGenerator = dependencies.idGenerator ?? (() => crypto.randomUUID());
  }

  search(areaCodes: string[], limitPerAreaCode = 3): Promise<NumberCandidate[]> {
    return this.dependencies.provider.searchNumbers({ areaCodes, countryCode: "US", limitPerAreaCode });
  }

  async requestNumber(
    faxJobId: string,
    candidate: NumberCandidate,
    forwardingEmail: string,
  ): Promise<TemporaryNumber> {
    const job = await this.requireJob(faxJobId);
    if (job.state !== "prepared") throw new ConflictError("The fax must be prepared before choosing a number.");
    if (!candidate.monthlyPrice) {
      throw new ConflictError("No monthly rental estimate is configured. Refresh before provisioning.");
    }
    if (job.mode !== "send-only") {
      const pendingHouseholdLine = (await this.dependencies.repository.listActiveNumbers()).find(
        (number) =>
          number.faxJobId !== job.id &&
          number.providerName === this.dependencies.provider.name &&
          number.mode !== "send-only" &&
          ["requested", "provisioning", "activating", "cleaning"].includes(number.state),
      );
      if (pendingHouseholdLine) {
        throw new ConflictError(
          "A household fax line is already being opened. Wait for it to finish before opening another line.",
          { temporaryNumberId: pendingHouseholdLine.id },
        );
      }
    }
    transitionFax(job.state, "provisioning");
    const timestamp = this.dependencies.clock.now().toISOString();
    const claimed = await this.dependencies.repository.compareAndSetFaxState(
      job.id,
      "prepared",
      "provisioning",
      timestamp,
    );
    if (!claimed) {
      throw new ConflictError("Another number request already started for this fax.");
    }
    const releasePolicy = job.mode === "send-only"
      ? "after-send"
      : job.requestedTtlDays !== null && job.requestedRentalMonths === null
        ? "scheduled"
        : job.requestedRentalMonths === null
          ? "manual"
          : "scheduled";
    const number: TemporaryNumber = {
      id: this.idGenerator(),
      faxJobId: job.id,
      e164: null,
      areaCode: candidate.areaCode,
      providerId: null,
      providerName: this.dependencies.provider.name,
      state: "requested",
      mode: job.mode,
      forwardingEmail,
      setupPrice: candidate.setupPrice,
      monthlyPrice: candidate.monthlyPrice,
      provisionedAt: null,
      earliestProviderReleaseAt: null,
      releasePolicy,
      rentalMonths: job.requestedRentalMonths ?? null,
      nextBilledAt: null,
      releaseAt: null,
      expiresAt: null,
      releaseStartedAt: null,
      releasedAt: null,
      workflowId: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    let numberCreated = false;
    try {
      await this.dependencies.repository.createTemporaryNumber(number);
      numberCreated = true;
      await this.dependencies.repository.updateFaxJob(job.id, {
        temporaryNumberId: number.id,
        updatedAt: timestamp,
      });
      await this.dependencies.audit.record({
        correlationId: job.correlationId,
        faxJobId: job.id,
        temporaryNumberId: number.id,
        source: "user",
        type: "number.requested",
        resultingState: "requested",
        details: {
          candidate: candidate.e164,
          areaCode: candidate.areaCode,
          setupPrice: candidate.setupPrice,
          monthlyPrice: candidate.monthlyPrice,
          releasePolicy,
          rentalMonths: number.rentalMonths,
        },
      });
      return number;
    } catch (error) {
      const message = error instanceof Error ? error.message : "The number request could not be initialized.";
      await Promise.allSettled([
        ...(numberCreated
          ? [this.dependencies.repository.updateTemporaryNumber(number.id, {
              state: "provision_failed",
              updatedAt: timestamp,
            })]
          : []),
        this.dependencies.repository.updateFaxJob(job.id, {
          state: "failed",
          failureCode: "number_request_initialization_failed",
          failureMessage: message,
          completedAt: timestamp,
          updatedAt: timestamp,
        }),
      ]);
      throw error;
    }
  }

  async abortNumberRequest(id: string, message: string): Promise<TemporaryNumber> {
    const number = await this.requireNumber(id);
    if (number.state === "provision_failed") return number;
    if (number.state !== "requested" || number.e164) {
      throw new ConflictError("This number request has already reached the provider.");
    }
    const job = await this.requireJob(number.faxJobId!);
    const timestamp = this.dependencies.clock.now().toISOString();
    transitionNumber(number.state, "provision_failed");
    const canceled = await this.dependencies.repository.updateTemporaryNumberIfState(
      number.id,
      "requested",
      {
        state: "provision_failed",
        updatedAt: timestamp,
      },
    );
    if (!canceled) throw new ConflictError("This number request has already reached the provider.");
    await this.dependencies.repository.updateFaxJob(job.id, {
      state: "failed",
      failureCode: "number_workflow_start_failed",
      failureMessage: message,
      completedAt: timestamp,
      updatedAt: timestamp,
    });
    await this.dependencies.audit.record({
      correlationId: job.correlationId,
      faxJobId: job.id,
      temporaryNumberId: number.id,
      source: "workflow",
      type: "number.workflow_start_failed",
      resultingState: "provision_failed",
      details: { message },
    });
    return (await this.dependencies.repository.getTemporaryNumber(number.id))!;
  }

  async provisionNumber(id: string, candidate: NumberCandidate): Promise<TemporaryNumber> {
    const number = await this.requireNumber(id);
    const job = await this.requireJob(number.faxJobId!);
    if (["provisioning", "activating"].includes(number.state) || number.e164) {
      if (number.e164 !== candidate.e164) {
        throw new ConflictError("This number request already started with a different provider number.");
      }
      return this.reconcileProvisioning(id);
    }
    if (number.state !== "requested") throw new ConflictError("This number request cannot be provisioned again.");
    const startedAt = this.dependencies.clock.now().toISOString();
    transitionNumber(number.state, "provisioning");
    const claimed = await this.dependencies.repository.updateTemporaryNumberIfState(
      number.id,
      "requested",
      {
        state: "provisioning",
        e164: candidate.e164,
        providerId: candidate.e164,
        updatedAt: startedAt,
      },
    );
    if (!claimed) {
      const current = await this.requireNumber(number.id);
      if (current.state === "provisioning" && current.e164 === candidate.e164) {
        return this.reconcileProvisioning(id);
      }
      throw new ConflictError("Another provisioning operation already started for this number.");
    }
    let provisioned: ProvisionedNumber;
    try {
      provisioned = await this.dependencies.provider.provisionNumber({
        candidate,
        correlationId: job.correlationId,
      });
    } catch (error) {
      await this.dependencies.audit.record({
        correlationId: job.correlationId,
        faxJobId: job.id,
        temporaryNumberId: number.id,
        source: "provider",
        type: "number.provisioning_unknown",
        resultingState: "provisioning",
        details: {
          candidate: candidate.e164,
          message: error instanceof Error ? error.message : "Unknown provider error",
        },
      });
      throw error;
    }
    const confirmedAt = this.dependencies.clock.now();
    const persistedNumber = await this.dependencies.repository.updateTemporaryNumberIfState(number.id, "provisioning", {
      e164: provisioned.e164,
      providerId: provisioned.providerId,
      provisionedAt: number.provisionedAt ?? confirmedAt.toISOString(),
      earliestProviderReleaseAt:
        number.earliestProviderReleaseAt ?? this.minimumReleaseAt(confirmedAt),
      updatedAt: confirmedAt.toISOString(),
    });
    if (!persistedNumber) {
      const current = await this.requireNumber(number.id);
      if (current.state === "active") return this.finalizeActiveNumber(current);
      throw new ConflictError("This number changed while the provider result was being saved.");
    }
    if (provisioned.ready) {
      try {
        return await this.activateProvisionedNumber(persistedNumber, job, provisioned);
      } catch (error) {
        const current = await this.requireNumber(number.id);
        if (current.state === "active") throw error;
        await this.dependencies.audit.record({
          correlationId: job.correlationId,
          faxJobId: job.id,
          temporaryNumberId: number.id,
          source: "provider",
          type: "number.configuration_pending",
          resultingState: current.state,
          details: {
            e164: provisioned.e164,
            message: error instanceof Error ? error.message : "Fax configuration failed.",
          },
          rawPayload: provisioned.raw,
        });
        throw error;
      }
    }
    await this.dependencies.audit.record({
      correlationId: job.correlationId,
      faxJobId: job.id,
      temporaryNumberId: number.id,
      source: "provider",
      type: "number.provisioning",
      resultingState: "provisioning",
      details: { e164: provisioned.e164, ready: false },
      rawPayload: provisioned.raw,
    });
    return (await this.dependencies.repository.getTemporaryNumber(number.id))!;
  }

  async reconcileProvisioning(id: string): Promise<TemporaryNumber> {
    const number = await this.requireNumber(id);
    if (number.state === "active") return this.finalizeActiveNumber(number);
    if (!["requested", "provisioning", "activating"].includes(number.state) || !number.e164) {
      throw new ConflictError("This number request cannot be reconciled.");
    }
    const job = await this.requireJob(number.faxJobId!);
    const provisioned = await this.dependencies.provider.getNumber(number.e164);
    if (!provisioned) {
      await this.dependencies.audit.record({
        correlationId: job.correlationId,
        faxJobId: job.id,
        temporaryNumberId: number.id,
        source: "provider",
        type: "number.provisioning_not_found",
        resultingState: number.state,
        details: { e164: number.e164 },
      });
      return number;
    }
    const confirmedAt = this.dependencies.clock.now();
    const persistedNumber = await this.dependencies.repository.updateTemporaryNumberIfState(number.id, number.state, {
      ...(number.state === "requested" ? { state: "provisioning" as const } : {}),
      e164: provisioned.e164,
      providerId: provisioned.providerId,
      provisionedAt: number.provisionedAt ?? confirmedAt.toISOString(),
      earliestProviderReleaseAt:
        number.earliestProviderReleaseAt ?? this.minimumReleaseAt(confirmedAt),
      updatedAt: confirmedAt.toISOString(),
    });
    if (!persistedNumber) {
      const current = await this.requireNumber(number.id);
      if (current.state === "active") return this.finalizeActiveNumber(current);
      throw new ConflictError("This number changed while its provider status was being saved.");
    }
    if (!provisioned.ready) {
      if (persistedNumber.state === "activating") {
        await this.dependencies.repository.updateTemporaryNumberIfState(number.id, "activating", {
          state: "provisioning",
          updatedAt: confirmedAt.toISOString(),
        });
      }
      await this.dependencies.audit.record({
        correlationId: job.correlationId,
        faxJobId: job.id,
        temporaryNumberId: number.id,
        source: "provider",
        type: "number.provisioning",
        resultingState: "provisioning",
        details: { e164: provisioned.e164, ready: false },
        rawPayload: provisioned.raw,
      });
      return (await this.dependencies.repository.getTemporaryNumber(number.id))!;
    }
    return this.activateProvisionedNumber(persistedNumber, job, provisioned);
  }

  async failProvisioning(id: string, message: string): Promise<TemporaryNumber> {
    let number = await this.requireNumber(id);
    if (["provision_failed", "released"].includes(number.state)) return number;
    if (!["requested", "provisioning", "cleaning"].includes(number.state) || !number.e164) {
      throw new ConflictError("This number request cannot be failed safely.");
    }
    if (number.state !== "cleaning") {
      transitionNumber(number.state, "cleaning");
      const claimed = await this.dependencies.repository.updateTemporaryNumberIfState(
        number.id,
        number.state,
        { state: "cleaning", updatedAt: this.dependencies.clock.now().toISOString() },
      );
      if (!claimed) {
        throw new ConflictError("This number changed before provisioning cleanup could start.");
      }
      number = claimed;
    }
    const providerNumber = number.e164;
    if (!providerNumber) throw new ConflictError("This number request has no provider number to clean up.");
    const job = await this.requireJob(number.faxJobId!);
    const timestamp = this.dependencies.clock.now().toISOString();
    let routeCleanupError: string | null = null;
    let releaseError: string | null = null;
    const earliestReleaseAt =
      number.earliestProviderReleaseAt ?? this.minimumReleaseAt(this.dependencies.clock.now());
    const releaseDeferred = Boolean(earliestReleaseAt && earliestReleaseAt > timestamp);
    let releaseRaw: unknown;
    if (job.mode !== "send-only") {
      try {
        await this.dependencies.provider.removeInboundNumberRouting({
          e164: providerNumber,
          email: number.forwardingEmail,
          correlationId: job.correlationId,
        });
      } catch (error) {
        routeCleanupError = error instanceof Error ? error.message : "Email route cleanup failed.";
      }
    }
    if (releaseDeferred) {
      releaseError = `The provider will permit release on ${earliestReleaseAt}.`;
    } else {
      try {
        releaseRaw = (await this.dependencies.provider.releaseNumber(providerNumber, job.correlationId)).raw;
      } catch (error) {
        releaseError = error instanceof Error ? error.message : "Number release failed.";
      }
    }
    const nextNumberState = releaseError ? "release_failed" : "provision_failed";
    transitionNumber("cleaning", nextNumberState);
    const failed = await this.dependencies.repository.updateTemporaryNumberIfState(number.id, "cleaning", {
      state: nextNumberState,
      earliestProviderReleaseAt: earliestReleaseAt,
      ...(releaseError
        ? {
            releaseStartedAt: releaseDeferred ? null : timestamp,
            releaseAt: releaseDeferred ? earliestReleaseAt : timestamp,
            expiresAt: releaseDeferred ? earliestReleaseAt : timestamp,
          }
        : { e164: null, providerId: null, releasedAt: timestamp }),
      updatedAt: timestamp,
    });
    if (!failed) throw new ConflictError("This number request changed while cleanup was running.");
    await this.dependencies.repository.updateFaxJob(job.id, {
      state: "failed",
      failureCode: "number_provision_failed",
      failureMessage: message,
      completedAt: timestamp,
      updatedAt: timestamp,
    });
    await this.dependencies.audit.record({
      correlationId: job.correlationId,
      faxJobId: job.id,
      temporaryNumberId: number.id,
      source: "workflow",
      type: releaseDeferred
        ? "number.provision_cleanup_deferred"
        : releaseError
          ? "number.provision_cleanup_failed"
          : "number.provision_failed",
      resultingState: nextNumberState,
      details: {
        candidate: number.e164,
        message,
        routeCleanupError,
        releaseError,
        earliestReleaseAt,
        earliestProviderReleaseAt: earliestReleaseAt,
      },
      rawPayload: releaseRaw,
    });
    return (await this.dependencies.repository.getTemporaryNumber(number.id))!;
  }

  async extendNumber(id: string, months: number): Promise<TemporaryNumber> {
    const maxMonths = this.dependencies.maxRentalMonths ?? 12;
    if (!Number.isSafeInteger(months) || months <= 0 || months > maxMonths) {
      throw new ConflictError(`Extension must be between 1 and ${maxMonths} months.`);
    }
    const number = await this.requireNumber(id);
    if (!['active', 'expiring'].includes(number.state)) {
      throw new ConflictError("Only an active number can be extended.");
    }
    if ((number.releasePolicy ?? "scheduled") !== "scheduled") {
      throw new ConflictError("Only a number with a scheduled release can be extended.");
    }
    const timestamp = this.dependencies.clock.now();
    const currentRelease = number.releaseAt ?? number.expiresAt;
    const extensionBase = currentRelease && new Date(currentRelease) > timestamp
      ? new Date(currentRelease)
      : timestamp;
    const releaseAt = addUtcMonths(extensionBase, months).toISOString();
    const updated = await this.dependencies.repository.updateTemporaryNumberIfState(id, number.state, {
      state: "active",
      rentalMonths: (number.rentalMonths ?? 1) + months,
      releaseAt,
      expiresAt: releaseAt,
      updatedAt: timestamp.toISOString(),
    });
    if (!updated) throw new ConflictError("This number changed while the extension was being saved.");
    const job = number.faxJobId ? await this.requireJob(number.faxJobId) : null;
    await this.dependencies.audit.record({
      correlationId: job?.correlationId ?? id,
      faxJobId: number.faxJobId,
      temporaryNumberId: number.id,
      source: "user",
      type: "number.extended",
      resultingState: "active",
      details: { months, releaseAt, previousReleaseAt: currentRelease },
    });
    return (await this.dependencies.repository.getTemporaryNumber(id))!;
  }

  async updateForwardingEmail(id: string, forwardingEmail: string): Promise<TemporaryNumber> {
    const number = await this.requireNumber(id);
    if (!["active", "expiring"].includes(number.state) || number.mode === "send-only") {
      throw new ConflictError("Only an active receiving line can change its forwarding email.");
    }
    if (!number.e164) throw new ConflictError("The active number has no provider phone number.");
    if (number.providerName !== this.dependencies.provider.name) {
      const owner = number.providerName ?? "an unknown legacy provider";
      throw new ConflictError(
        `This number belongs to ${owner}, but the app is configured for ${this.dependencies.provider.name}.`,
      );
    }
    if (number.forwardingEmail === forwardingEmail) return number;

    const job = number.faxJobId ? await this.dependencies.repository.getFaxJob(number.faxJobId) : null;
    const correlationId = job?.correlationId ?? number.id;
    const callbackUrl = this.inboundCallbackUrl();
    let configuredNewRoute = false;
    let configuredRaw: unknown;
    let removedRaw: unknown;
    try {
      const configured = await this.dependencies.provider.configureInboundNumber({
        e164: number.e164,
        email: forwardingEmail,
        mode: number.mode,
        callbackUrl,
        correlationId,
      });
      configuredNewRoute = configured.configured;
      configuredRaw = configured.raw;
      const removed = await this.dependencies.provider.removeInboundNumberRouting({
        e164: number.e164,
        email: number.forwardingEmail,
        correlationId,
      });
      removedRaw = removed.raw;
      const updated = await this.dependencies.repository.updateTemporaryNumberIfState(id, number.state, {
        forwardingEmail,
        updatedAt: this.dependencies.clock.now().toISOString(),
      });
      if (!updated) throw new NotFoundError("Temporary number", id);
    } catch (error) {
      if (configuredNewRoute) {
        const rollback = await Promise.allSettled([
          this.dependencies.provider.configureInboundNumber({
            e164: number.e164,
            email: number.forwardingEmail,
            mode: number.mode,
            callbackUrl,
            correlationId,
          }),
          this.dependencies.provider.removeInboundNumberRouting({
            e164: number.e164,
            email: forwardingEmail,
            correlationId,
          }),
        ]);
        const rollbackErrors = rollback.flatMap((result) =>
          result.status === "rejected"
            ? [result.reason instanceof Error ? result.reason.message : String(result.reason)]
            : []
        );
        if (rollbackErrors.length) {
          console.error(JSON.stringify({
            event: "number.forwarding_update_rollback_failed",
            numberId: number.id,
            correlationId,
            rollbackErrors,
          }));
        }
      }
      throw error;
    }

    try {
      await this.dependencies.audit.record({
        correlationId,
        faxJobId: number.faxJobId,
        temporaryNumberId: number.id,
        source: "user",
        type: "number.forwarding_updated",
        resultingState: number.state,
        details: {
          previousForwardingEmail: number.forwardingEmail,
          forwardingEmail,
        },
        rawPayload: { configured: configuredRaw, removed: removedRaw },
      });
    } catch (error) {
      console.error(JSON.stringify({
        event: "number.forwarding_update_audit_failed",
        numberId: number.id,
        correlationId,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
    return (await this.dependencies.repository.getTemporaryNumber(id))!;
  }

  async cancelScheduledRelease(id: string): Promise<TemporaryNumber> {
    const number = await this.requireNumber(id);
    if (!["active", "expiring"].includes(number.state)) {
      throw new ConflictError("Only an active number can change its release schedule.");
    }
    if ((number.releasePolicy ?? "scheduled") !== "scheduled") return number;
    const timestamp = this.dependencies.clock.now().toISOString();
    const updated = await this.dependencies.repository.updateTemporaryNumberIfState(id, number.state, {
      state: "active",
      releasePolicy: "manual",
      releaseAt: null,
      expiresAt: null,
      updatedAt: timestamp,
    });
    if (!updated) throw new ConflictError("This number changed while its release schedule was being saved.");
    const job = number.faxJobId ? await this.requireJob(number.faxJobId) : null;
    await this.dependencies.audit.record({
      correlationId: job?.correlationId ?? id,
      faxJobId: number.faxJobId,
      temporaryNumberId: id,
      source: "user",
      type: "number.release_schedule_canceled",
      resultingState: "active",
      details: { previousReleaseAt: number.releaseAt ?? number.expiresAt },
    });
    return (await this.dependencies.repository.getTemporaryNumber(id))!;
  }

  async reconcileActiveNumber(id: string): Promise<TemporaryNumber> {
    let number = await this.requireNumber(id);
    if (!["active", "expiring"].includes(number.state)) return number;
    if (number.state === "active" && number.faxJobId) {
      const owner = await this.dependencies.repository.getFaxJob(number.faxJobId);
      if (owner?.state === "provisioning") {
        number = await this.finalizeActiveNumber(number);
      }
    }
    if (!number.e164) {
      throw new ConflictError("The active number has no provider phone number.");
    }
    if (number.providerName !== this.dependencies.provider.name) {
      const owner = number.providerName ?? "an unknown legacy provider";
      throw new ConflictError(
        `This number belongs to ${owner}, but the app is configured for ${this.dependencies.provider.name}.`,
      );
    }
    const providerNumber = await this.dependencies.provider.getNumber(number.e164);
    const timestamp = this.dependencies.clock.now().toISOString();
    const job = number.faxJobId ? await this.dependencies.repository.getFaxJob(number.faxJobId) : null;
    if (!providerNumber) {
      transitionNumber(number.state, "releasing");
      transitionNumber("releasing", "released");
      await this.dependencies.repository.updateTemporaryNumber(number.id, {
        state: "released",
        releasedAt: timestamp,
        updatedAt: timestamp,
      });
      return this.finalizeReleasedNumber(number.id, "number.provider_absent");
    }
    if (providerNumber.nextBilledAt !== number.nextBilledAt) {
      const releaseAt = this.reconciledReleaseAt(number, providerNumber.nextBilledAt, timestamp);
      await this.dependencies.repository.updateTemporaryNumber(number.id, {
        nextBilledAt: providerNumber.nextBilledAt,
        releaseAt,
        expiresAt: releaseAt,
        updatedAt: timestamp,
      });
      await this.dependencies.audit.record({
        correlationId: job?.correlationId ?? number.id,
        faxJobId: number.faxJobId,
        temporaryNumberId: number.id,
        source: "provider",
        type: "number.billing_reconciled",
        resultingState: number.state,
        details: {
          previousNextBilledAt: number.nextBilledAt,
          nextBilledAt: providerNumber.nextBilledAt,
          previousReleaseAt: number.releaseAt ?? number.expiresAt,
          releaseAt,
        },
        rawPayload: providerNumber.raw,
      });
    }
    return (await this.dependencies.repository.getTemporaryNumber(number.id))!;
  }

  async releaseNumber(id: string): Promise<TemporaryNumber> {
    const number = await this.requireNumber(id);
    if (number.state === "released") return this.finalizeReleasedNumber(id);
    if (number.state === "releasing") return number;
    if (!number.e164) throw new ConflictError("The number has not been provisioned.");
    if (number.providerName !== this.dependencies.provider.name) {
      const owner = number.providerName ?? "an unknown legacy provider";
      throw new ConflictError(
        `This number belongs to ${owner}, but the app is configured for ${this.dependencies.provider.name}. Release it with the original provider before marking it closed here.`,
      );
    }
    const job = number.faxJobId ? await this.requireJob(number.faxJobId) : null;
    const timestamp = this.dependencies.clock.now().toISOString();
    if (!["active", "expiring", "release_failed"].includes(number.state)) {
      throw new ConflictError("This number cannot be released from its current state.");
    }
    const earliestReleaseAt = number.earliestProviderReleaseAt;
    if (
      earliestReleaseAt &&
      earliestReleaseAt > timestamp
    ) {
      const nextState = number.state === "active" ? "expiring" : number.state;
      if (number.state === "active") transitionNumber(number.state, nextState);
      const releasePolicy = number.releasePolicy === "after-send" ? "after-send" : "scheduled";
      const deferred = await this.dependencies.repository.updateTemporaryNumberIfState(id, number.state, {
        state: nextState,
        releasePolicy,
        releaseAt: earliestReleaseAt,
        expiresAt: earliestReleaseAt,
        updatedAt: timestamp,
      });
      if (!deferred) return this.requireNumber(id);
      await this.dependencies.audit.record({
        correlationId: job?.correlationId ?? id,
        faxJobId: number.faxJobId,
        temporaryNumberId: id,
        source: "application",
        type: "number.release_deferred",
        resultingState: nextState,
        details: {
          requestedAt: timestamp,
          earliestReleaseAt,
          earliestProviderReleaseAt: earliestReleaseAt,
        },
      });
      return (await this.dependencies.repository.getTemporaryNumber(id))!;
    }
    if (
      number.releasePolicy === "after-send" &&
      job &&
      !["delivered", "failed", "canceled", "completed"].includes(job.state)
    ) {
      await this.dependencies.audit.record({
        correlationId: job.correlationId,
        faxJobId: job.id,
        temporaryNumberId: id,
        source: "application",
        type: "number.release_waiting_for_fax",
        resultingState: number.state,
        details: { faxState: job.state, releaseAt: number.releaseAt ?? number.expiresAt },
      });
      return number;
    }
    transitionNumber(number.state, "releasing");
    const claimed = await this.dependencies.repository.updateTemporaryNumberIfState(
      id,
      number.state,
      {
        state: "releasing",
        releaseStartedAt: timestamp,
        updatedAt: timestamp,
      },
    );
    if (!claimed) return this.requireNumber(id);
    let releaseRaw: unknown;
    try {
      if (number.mode !== "send-only") {
        await this.dependencies.provider.removeInboundNumberRouting({
          e164: number.e164,
          email: number.forwardingEmail,
          correlationId: job?.correlationId ?? id,
        });
      }
      const result = await this.dependencies.provider.releaseNumber(
        number.e164,
        job?.correlationId ?? id,
      );
      releaseRaw = result.raw;
      const remaining = await this.dependencies.provider.getNumber(number.e164);
      if (remaining) {
        throw new ConflictError("The provider still reports this number as active after the release request.", {
          released: result.released,
          providerId: remaining.providerId,
        });
      }
      const released = await this.dependencies.repository.updateTemporaryNumberIfState(id, "releasing", {
        state: "released",
        releasedAt: timestamp,
        updatedAt: timestamp,
      });
      if (!released) throw new ConflictError("The provider released the number, but its local lifecycle changed.");
    } catch (error) {
      await this.dependencies.repository.updateTemporaryNumberIfState(id, "releasing", {
        state: "release_failed",
        updatedAt: timestamp,
      });
      try {
        await this.dependencies.audit.record({
          correlationId: job?.correlationId ?? id,
          faxJobId: number.faxJobId,
          temporaryNumberId: id,
          source: "provider",
          type: "number.release_failed",
          resultingState: "release_failed",
          details: { message: error instanceof Error ? error.message : "Unknown provider error" },
        });
      } catch (auditError) {
        console.error(JSON.stringify({
          event: "number.release_failure_audit_failed",
          numberId: id,
          correlationId: job?.correlationId ?? id,
          error: auditError instanceof Error ? auditError.message : String(auditError),
        }));
      }
      throw error;
    }
    try {
      return await this.finalizeReleasedNumber(id, "number.released", releaseRaw);
    } catch (error) {
      console.error(JSON.stringify({
        event: "number.release_bookkeeping_failed",
        numberId: id,
        correlationId: job?.correlationId ?? id,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
    return (await this.dependencies.repository.getTemporaryNumber(id))!;
  }

  async finalizeReleasedNumber(
    id: string,
    eventType: "number.released" | "number.provider_absent" = "number.released",
    rawPayload?: unknown,
  ): Promise<TemporaryNumber> {
    const number = await this.requireNumber(id);
    if (number.state !== "released") return number;
    const job = number.faxJobId ? await this.dependencies.repository.getFaxJob(number.faxJobId) : null;
    const timestamp = this.dependencies.clock.now().toISOString();
    if (job?.mode === "receive-only" && job.state === "active") {
      await this.dependencies.repository.updateFaxJob(job.id, {
        state: "completed",
        completedAt: timestamp,
        updatedAt: timestamp,
      });
    }
    const alreadyRecorded = (await this.dependencies.repository.listEventsForNumber(id)).some(
      (event) => ["number.released", "number.provider_absent"].includes(event.type),
    );
    if (!alreadyRecorded) {
      await this.dependencies.audit.record({
        correlationId: job?.correlationId ?? id,
        faxJobId: number.faxJobId,
        temporaryNumberId: id,
        source: "provider",
        type: eventType,
        resultingState: "released",
        details: { e164: number.e164, providerConfirmedAbsent: true },
        ...(rawPayload === undefined ? {} : { rawPayload }),
      });
    }
    return (await this.dependencies.repository.getTemporaryNumber(id))!;
  }

  async retryStuckRelease(id: string): Promise<TemporaryNumber> {
    const number = await this.requireNumber(id);
    if (number.state !== "releasing") return this.releaseNumber(id);
    transitionNumber(number.state, "release_failed");
    const recovered = await this.dependencies.repository.updateTemporaryNumberIfState(
      id,
      "releasing",
      { state: "release_failed", updatedAt: this.dependencies.clock.now().toISOString() },
    );
    return recovered ? this.releaseNumber(id) : this.requireNumber(id);
  }

  async recoverStuckActivation(id: string): Promise<TemporaryNumber> {
    const number = await this.requireNumber(id);
    if (number.state !== "activating") return this.reconcileProvisioning(id);
    transitionNumber(number.state, "provisioning");
    const recovered = await this.dependencies.repository.updateTemporaryNumberIfState(
      id,
      "activating",
      { state: "provisioning", updatedAt: this.dependencies.clock.now().toISOString() },
    );
    return recovered ? this.reconcileProvisioning(id) : this.requireNumber(id);
  }

  private async requireJob(id: string): Promise<FaxJob> {
    const job = await this.dependencies.repository.getFaxJob(id);
    if (!job) throw new NotFoundError("Fax job", id);
    return job;
  }

  private async requireNumber(id: string): Promise<TemporaryNumber> {
    const number = await this.dependencies.repository.getTemporaryNumber(id);
    if (!number) throw new NotFoundError("Temporary number", id);
    return number;
  }

  private async activateProvisionedNumber(
    number: TemporaryNumber,
    job: FaxJob,
    provisioned: ProvisionedNumber,
  ): Promise<TemporaryNumber> {
    const timestamp = this.dependencies.clock.now();
    let activating = number;
    if (number.state === "provisioning") {
      transitionNumber(number.state, "activating");
      const claimed = await this.dependencies.repository.updateTemporaryNumberIfState(
        number.id,
        "provisioning",
        { state: "activating", updatedAt: timestamp.toISOString() },
      );
      if (!claimed) {
        const current = await this.requireNumber(number.id);
        if (current.state === "active") return this.finalizeActiveNumber(current);
        throw new ConflictError("This number changed before its fax route could be activated.");
      }
      activating = claimed;
    } else if (number.state === "activating") {
      return number;
    } else {
      throw new ConflictError("This number is not ready for activation.");
    }
    let routeConfigured = false;
    if (job.mode !== "send-only") {
      try {
        await this.dependencies.provider.configureInboundNumber({
          e164: provisioned.e164,
          email: activating.forwardingEmail,
          mode: job.mode,
          callbackUrl: this.inboundCallbackUrl(),
          correlationId: job.correlationId,
        });
        routeConfigured = true;
      } catch (error) {
        await this.dependencies.repository.updateTemporaryNumberIfState(number.id, "activating", {
          state: "provisioning",
          updatedAt: this.dependencies.clock.now().toISOString(),
        });
        throw error;
      }
    }
    const provisionedAt = number.provisionedAt ?? timestamp.toISOString();
    const earliestProviderReleaseAt =
      number.earliestProviderReleaseAt ?? this.minimumReleaseAt(timestamp);
    const releasePolicy = number.releasePolicy ?? (job.mode === "send-only" ? "after-send" : "scheduled");
    let releaseAt: string | null = releasePolicy === "after-send" ? earliestProviderReleaseAt : null;
    if (releasePolicy === "scheduled") {
      if (job.requestedTtlDays !== null && job.requestedRentalMonths === null) {
        releaseAt = new Date(timestamp.getTime() + job.requestedTtlDays * 86_400_000).toISOString();
      } else {
        const firstBillingBoundary = provisioned.nextBilledAt
          ? new Date(provisioned.nextBilledAt)
          : addUtcMonths(timestamp, 1);
        const finalBillingBoundary = addUtcMonths(
          firstBillingBoundary,
          Math.max(0, (number.rentalMonths ?? 1) - 1),
        );
        releaseAt = new Date(finalBillingBoundary.getTime() - 60 * 60_000).toISOString();
      }
      releaseAt = laterIsoDate(releaseAt, earliestProviderReleaseAt);
    }
    transitionNumber(activating.state, "active");
    let active: TemporaryNumber | null;
    try {
      active = await this.dependencies.repository.updateTemporaryNumberIfState(number.id, "activating", {
        e164: provisioned.e164,
        providerId: provisioned.providerId,
        state: "active",
        provisionedAt,
        earliestProviderReleaseAt,
        releasePolicy,
        nextBilledAt: provisioned.nextBilledAt,
        releaseAt,
        expiresAt: releaseAt,
        updatedAt: timestamp.toISOString(),
      });
    } catch (error) {
      const current = await this.dependencies.repository.getTemporaryNumber(number.id).catch(() => null);
      if (current?.state === "active") return this.finalizeActiveNumber(current);
      if (current && routeConfigured) await this.removeConfiguredRoute(activating, job);
      if (current?.state === "activating") {
        await this.dependencies.repository.updateTemporaryNumberIfState(number.id, "activating", {
          state: "provisioning",
          updatedAt: this.dependencies.clock.now().toISOString(),
        }).catch(() => null);
      }
      throw error;
    }
    if (!active) {
      const current = await this.requireNumber(number.id);
      if (current.state === "active") return this.finalizeActiveNumber(current);
      if (routeConfigured) await this.removeConfiguredRoute(activating, job);
      throw new ConflictError("This number changed while its active route was being saved.");
    }
    return this.finalizeActiveNumber(active, provisioned.raw);
  }

  private async finalizeActiveNumber(number: TemporaryNumber, rawPayload?: unknown): Promise<TemporaryNumber> {
    if (number.state !== "active" || !number.faxJobId || !number.e164) return number;
    const job = await this.requireJob(number.faxJobId);
    const nextFaxState = job.mode === "receive-only" ? "active" : "submitting";
    if (job.state === "provisioning") {
      transitionFax(job.state, nextFaxState);
      const updated = await this.dependencies.repository.updateFaxJobIfState(job.id, "provisioning", {
        state: nextFaxState,
        fromNumber: number.e164,
        updatedAt: this.dependencies.clock.now().toISOString(),
      });
      if (!updated) {
        const current = await this.requireJob(job.id);
        if (current.state !== nextFaxState) {
          throw new ConflictError("The fax changed while its active number was being attached.");
        }
      }
    } else if (job.state !== nextFaxState) {
      throw new ConflictError("The number is active, but its fax is no longer awaiting activation.", {
        faxState: job.state,
      });
    }
    const alreadyRecorded = (await this.dependencies.repository.listEventsForNumber(number.id)).some(
      (event) => event.type === "number.active",
    );
    if (!alreadyRecorded) {
      await this.dependencies.audit.record({
        correlationId: job.correlationId,
        faxJobId: job.id,
        temporaryNumberId: number.id,
        source: "provider",
        type: "number.active",
        resultingState: "active",
        details: {
          e164: number.e164,
          releasePolicy: number.releasePolicy,
          rentalMonths: number.rentalMonths,
          nextBilledAt: number.nextBilledAt,
          earliestProviderReleaseAt: number.earliestProviderReleaseAt,
          releaseAt: number.releaseAt,
          forwardingEmail: number.forwardingEmail,
        },
        ...(rawPayload === undefined ? {} : { rawPayload }),
      });
    }
    return (await this.dependencies.repository.getTemporaryNumber(number.id))!;
  }

  private async removeConfiguredRoute(number: TemporaryNumber, job: FaxJob): Promise<void> {
    if (job.mode === "send-only" || !number.e164) return;
    try {
      await this.dependencies.provider.removeInboundNumberRouting({
        e164: number.e164,
        email: number.forwardingEmail,
        correlationId: job.correlationId,
      });
    } catch (error) {
      console.error(JSON.stringify({
        event: "number.activation_route_compensation_failed",
        numberId: number.id,
        correlationId: job.correlationId,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }

  private minimumReleaseAt(provisionedAt: Date): string | null {
    const days = this.dependencies.minimumNumberHoldDays ?? 0;
    if (days <= 0) return null;
    return new Date(provisionedAt.getTime() + days * 86_400_000).toISOString();
  }

  private inboundCallbackUrl(): string {
    return this.dependencies.inboundCallbackUrl ??
      `https://fax.example.com/webhooks/${this.dependencies.provider.name}/incoming`;
  }

  private reconciledReleaseAt(
    number: TemporaryNumber,
    nextBilledAt: string | null,
    timestamp: string,
  ): string | null {
    const currentReleaseAt = number.releaseAt ?? number.expiresAt;
    if (number.releasePolicy !== "scheduled" || !currentReleaseAt || !nextBilledAt) {
      return currentReleaseAt;
    }
    const currentBoundary = number.nextBilledAt ?? (
      number.provisionedAt ? addUtcMonths(new Date(number.provisionedAt), 1).toISOString() : null
    );
    if (!currentBoundary || currentBoundary <= timestamp) return currentReleaseAt;
    const boundaryShift = new Date(nextBilledAt).getTime() - new Date(currentBoundary).getTime();
    const shiftedReleaseAt = new Date(new Date(currentReleaseAt).getTime() + boundaryShift).toISOString();
    return laterIsoDate(shiftedReleaseAt, number.earliestProviderReleaseAt);
  }
}

function addUtcMonths(value: Date, months: number): Date {
  const result = new Date(value.getTime());
  const day = result.getUTCDate();
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0)).getUTCDate();
  result.setUTCDate(Math.min(day, lastDay));
  return result;
}

function laterIsoDate(first: string | null, second: string | null): string | null {
  if (!first) return second;
  if (!second) return first;
  return first >= second ? first : second;
}
