import { parsePhoneNumberFromString, type CountryCode } from "libphonenumber-js";

import type { Clock } from "../../domain/clock";
import { ConflictError, NotFoundError } from "../../domain/errors";
import { transitionFax } from "../../domain/fax-state";
import { randomToken, sha256Hex } from "../../domain/crypto";
import type { FaxProvider, ProviderFax } from "../../providers/fax-provider";
import type { CoverSheetData, DocumentKind, FaxJob, FaxMode, FaxState } from "../../shared/contracts";
import { mapProviderFaxState } from "../../worker/workflows/workflow-policy";
import type { Repository } from "../repositories/types";
import type { DocumentStore } from "../storage/document-store";
import type { AuditService } from "./audit-service";

export class FaxService {
  private readonly idGenerator: () => string;

  constructor(
    private readonly dependencies: {
      repository: Repository;
      documents: DocumentStore;
      audit: AuditService;
      provider: FaxProvider;
      clock: Clock;
      defaultPhoneCountry: CountryCode;
      idGenerator?: () => string;
    },
  ) {
    this.idGenerator = dependencies.idGenerator ?? (() => crypto.randomUUID());
  }

  async createDraft(input: {
    mode: FaxMode;
    toNumber: string | null;
    requestedTtlDays?: number | null;
    requestedRentalMonths?: number | null;
    coverData: CoverSheetData | null;
  }): Promise<FaxJob> {
    if (input.mode !== "receive-only") {
      const parsed = input.toNumber
        ? parsePhoneNumberFromString(
            input.toNumber,
            this.dependencies.defaultPhoneCountry,
          )
        : undefined;
      if (!parsed?.isValid()) {
        throw new ConflictError("Enter a valid fax number.");
      }
      input.toNumber = parsed.number;
    }
    if (
      input.mode !== "send-only" &&
      input.requestedRentalMonths === undefined &&
      (!input.requestedTtlDays || input.requestedTtlDays <= 0)
    ) {
      throw new ConflictError("Choose a monthly receive term or keep the number until manual release.");
    }
    if (input.requestedRentalMonths !== undefined && input.requestedRentalMonths !== null) {
      if (!Number.isSafeInteger(input.requestedRentalMonths) || input.requestedRentalMonths <= 0) {
        throw new ConflictError("The monthly receive term must be a positive whole number.");
      }
    }
    const timestamp = this.dependencies.clock.now().toISOString();
    const id = this.idGenerator();
    const job: FaxJob = {
      id,
      mode: input.mode,
      direction: input.mode === "receive-only" ? "none" : "outbound",
      state: "draft",
      toNumber: input.toNumber,
      fromNumber: null,
      providerFaxId: null,
      providerProjectId: null,
      temporaryNumberId: null,
      correlationId: this.idGenerator(),
      finalDocumentId: null,
      pageCount: null,
      estimatedCost: null,
      reportedCost: null,
      requestedTtlDays: input.requestedTtlDays ?? null,
      requestedRentalMonths: input.requestedRentalMonths ?? null,
      coverData: input.coverData,
      failureCode: null,
      failureMessage: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      submittedAt: null,
      completedAt: null,
    };
    await this.dependencies.repository.createFaxJob(job);
    await this.dependencies.audit.record({
      correlationId: job.correlationId,
      faxJobId: job.id,
      source: "user",
      type: "fax.created",
      resultingState: job.state,
      details: {
        mode: job.mode,
        toNumber: job.toNumber,
        requestedRentalMonths: job.requestedRentalMonths,
      },
    });
    return job;
  }

  async registerDocument(
    faxJobId: string,
    input: {
      id: string;
      kind: DocumentKind;
      objectKey: string;
      mimeType: string;
      byteCount: number;
      pageCount: number | null;
      sha256: string;
      displayName: string;
    },
  ): Promise<void> {
    const job = await this.requireJob(faxJobId);
    await this.dependencies.repository.createDocument({
      ...input,
      faxJobId,
      temporaryNumberId: job.temporaryNumberId,
      createdAt: this.dependencies.clock.now().toISOString(),
    });
  }

  async prepare(
    faxJobId: string,
    finalDocumentId: string | null,
    pageCount: number | null,
  ): Promise<FaxJob> {
    const job = await this.requireJob(faxJobId);
    if (job.state !== "draft") throw new ConflictError("Only a draft fax can be prepared.");
    if (job.mode !== "receive-only") {
      if (!finalDocumentId || !pageCount) {
        throw new ConflictError("A final PDF packet is required before sending.");
      }
      const document = await this.dependencies.repository.getDocument(finalDocumentId);
      if (document?.faxJobId !== job.id || document.kind !== "final-packet") {
        throw new ConflictError("The selected final packet does not belong to this fax.");
      }
    }
    transitionFax(job.state, "preparing");
    const timestamp = this.dependencies.clock.now().toISOString();
    const preparing = await this.dependencies.repository.updateFaxJobIfState(job.id, "draft", {
      state: "preparing",
      updatedAt: timestamp,
    });
    if (!preparing) throw new ConflictError("This fax changed while it was being prepared.");
    const prepared = await this.dependencies.repository.updateFaxJobIfState(job.id, "preparing", {
      state: "prepared",
      finalDocumentId,
      pageCount,
      updatedAt: timestamp,
    });
    if (!prepared) throw new ConflictError("This fax changed while it was being prepared.");
    await this.dependencies.audit.record({
      correlationId: job.correlationId,
      faxJobId: job.id,
      source: "application",
      type: "fax.prepared",
      resultingState: "prepared",
      details: { finalDocumentId, pageCount },
    });
    return (await this.dependencies.repository.getFaxJob(job.id))!;
  }

  async startWithExistingNumber(faxJobId: string, temporaryNumberId: string): Promise<FaxJob> {
    const [job, number] = await Promise.all([
      this.requireJob(faxJobId),
      this.dependencies.repository.getTemporaryNumber(temporaryNumberId),
    ]);
    if (!number) throw new NotFoundError("Temporary number", temporaryNumberId);
    if (job.state !== "prepared") {
      throw new ConflictError("Only a prepared fax can use an existing number.");
    }
    if (number.state !== "active" || !number.e164) {
      throw new ConflictError("Choose an active fax number.");
    }
    if (!["scheduled", "manual"].includes(number.releasePolicy ?? "scheduled")) {
      throw new ConflictError("Choose a retained fax number that will remain active during this send.");
    }
    if (number.providerName !== this.dependencies.provider.name) {
      throw new ConflictError("The selected number belongs to a different fax provider.");
    }
    transitionFax(job.state, "submitting");
    const timestamp = this.dependencies.clock.now().toISOString();
    const claimed = await this.dependencies.repository.compareAndSetFaxState(
      job.id,
      "prepared",
      "submitting",
      timestamp,
    );
    if (!claimed) throw new ConflictError("This fax has already started.");
    const updated = await this.dependencies.repository.updateFaxJob(job.id, {
      temporaryNumberId: number.id,
      fromNumber: number.e164,
      updatedAt: timestamp,
    });
    try {
      await this.dependencies.audit.record({
        correlationId: job.correlationId,
        faxJobId: job.id,
        temporaryNumberId: number.id,
        source: "user",
        type: "fax.existing_number_selected",
        resultingState: "submitting",
        details: { e164: number.e164, providerName: number.providerName },
      });
    } catch (error) {
      console.error(JSON.stringify({
        event: "fax.existing_number_audit_failed",
        faxJobId: job.id,
        temporaryNumberId: number.id,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
    return updated!;
  }

  async cancelDraft(faxJobId: string, reason: string): Promise<FaxJob> {
    const job = await this.requireJob(faxJobId);
    if (!["draft", "preparing", "prepared"].includes(job.state)) {
      throw new ConflictError("Only an unconfirmed fax can be canceled.", { state: job.state });
    }
    transitionFax(job.state, "canceled");
    const timestamp = this.dependencies.clock.now().toISOString();
    const canceled = await this.dependencies.repository.updateFaxJobIfState(job.id, job.state, {
      state: "canceled",
      failureCode: "preparation_abandoned",
      failureMessage: reason,
      completedAt: timestamp,
      updatedAt: timestamp,
    });
    if (!canceled) throw new ConflictError("This fax changed before cancellation completed.");
    await this.dependencies.repository.revokeContentTokensForFax(job.id, timestamp);
    await this.dependencies.audit.record({
      correlationId: job.correlationId,
      faxJobId: job.id,
      source: "application",
      type: "fax.preparation_abandoned",
      resultingState: "canceled",
      details: { reason },
    });
    return (await this.dependencies.repository.getFaxJob(job.id))!;
  }

  async createProviderContentToken(
    faxJobId: string,
    baseUrl: string,
    ttlMinutes = 60,
  ): Promise<{ token: string; url: string }> {
    const job = await this.requireJob(faxJobId);
    if (job.state !== "submitting") {
      throw new ConflictError("Provider content is available only while a fax is being submitted.");
    }
    if (!job.finalDocumentId) throw new ConflictError("The fax has no final packet.");
    const document = await this.dependencies.repository.getDocument(job.finalDocumentId);
    if (document?.faxJobId !== job.id || document.kind !== "final-packet") {
      throw new ConflictError("The final packet does not belong to this fax.");
    }
    const token = randomToken();
    const tokenHash = await sha256Hex(token);
    const createdAt = this.dependencies.clock.now();
    await this.dependencies.repository.createContentToken({
      tokenHash,
      faxJobId,
      documentId: job.finalDocumentId,
      createdAt: createdAt.toISOString(),
      expiresAt: new Date(createdAt.getTime() + ttlMinutes * 60_000).toISOString(),
      revokedAt: null,
    });
    return { token, url: `${baseUrl.replace(/\/$/, "")}/provider-content/${token}` };
  }

  async submitOutbound(
    faxJobId: string,
    input: { contentUrl: string; callbackUrl: string },
  ): Promise<FaxJob> {
    const job = await this.requireJob(faxJobId);
    if (job.state !== "submitting") {
      throw new ConflictError("This fax is not eligible for submission.", { state: job.state });
    }
    if (!job.fromNumber || !job.toNumber) {
      throw new ConflictError("The fax is missing a sending or destination number.");
    }
    const started = this.dependencies.clock.now().getTime();
    await this.dependencies.audit.record({
      correlationId: job.correlationId,
      faxJobId: job.id,
      temporaryNumberId: job.temporaryNumberId,
      source: "workflow",
      type: "fax.submission_intent",
      resultingState: "submitting",
      details: { from: job.fromNumber, to: job.toNumber },
    });
    const submissionStartedAt = this.dependencies.clock.now().toISOString();
    transitionFax(job.state, "status_unknown");
    const submissionMarker = await this.dependencies.repository.updateFaxJobIfState(
      job.id,
      "submitting",
      {
        state: "status_unknown",
        failureCode: "submission_in_progress",
        failureMessage: "Provider submission started; final status is not yet confirmed.",
        updatedAt: submissionStartedAt,
      },
    );
    if (!submissionMarker) {
      const current = await this.requireJob(job.id);
      throw new ConflictError("This fax submission has already started.", { state: current.state });
    }

    let providerFax: ProviderFax;
    try {
      providerFax = await this.dependencies.provider.sendFax({
        from: job.fromNumber,
        to: job.toNumber,
        contentUrl: input.contentUrl,
        callbackUrl: input.callbackUrl,
        correlationId: job.correlationId,
      });
    } catch (error) {
      const updatedAt = this.dependencies.clock.now().toISOString();
      const message = error instanceof Error ? error.message : "Provider submission did not return.";
      const ambiguous = await this.dependencies.repository.updateFaxJobIfState(job.id, "status_unknown", {
        state: "status_unknown",
        failureCode: "ambiguous_submission",
        failureMessage: message,
        updatedAt,
      });
      if (ambiguous) {
        await this.dependencies.audit.record({
          correlationId: job.correlationId,
          faxJobId: job.id,
          temporaryNumberId: job.temporaryNumberId,
          source: "provider",
          type: "fax.status_unknown",
          resultingState: "status_unknown",
          durationMs: this.dependencies.clock.now().getTime() - started,
          details: { message },
        });
      }
      return ambiguous ?? this.requireJob(job.id);
    }

    await this.storeSubmissionRecovery(job, providerFax);
    return this.applyProviderFax(submissionMarker, providerFax, started);
  }

  async reconcileOutbound(faxJobId: string): Promise<FaxJob> {
    const job = await this.requireJob(faxJobId);
    const providerFaxId = job.providerFaxId ?? await this.recoveredProviderFaxId(job);
    if (!providerFaxId) throw new ConflictError("The fax has no provider identifier.");
    const started = this.dependencies.clock.now().getTime();
    const providerFax = await this.dependencies.provider.getFax(providerFaxId);
    return this.applyProviderFax(job, providerFax, started);
  }

  async applyProviderUpdate(providerFax: ProviderFax): Promise<FaxJob | null> {
    const job = await this.dependencies.repository.getFaxJobByProviderId(providerFax.id);
    if (!job) return null;
    return this.applyProviderFax(job, providerFax, this.dependencies.clock.now().getTime());
  }

  private async applyProviderFax(
    job: FaxJob,
    providerFax: ProviderFax,
    startedAt: number,
  ): Promise<FaxJob> {
    const nextState = mapProviderFaxState(providerFax.status);
    const terminalStates: FaxState[] = ["delivered", "failed", "canceled", "completed"];
    if (terminalStates.includes(job.state)) {
      if (job.state !== nextState) return job;
      if (["delivered", "failed"].includes(job.state)) {
        await this.dependencies.repository.revokeContentTokensForFax(
          job.id,
          job.completedAt ?? this.dependencies.clock.now().toISOString(),
        );
      }
      const eventType = `fax.${job.state}`;
      const alreadyRecorded = (await this.dependencies.repository.listEventsForFax(job.id)).some(
        (event) => event.type === eventType && event.details.providerFaxId === providerFax.id,
      );
      if (!alreadyRecorded) {
        await this.safeRecordProviderFaxEvent(job, providerFax, job.state, startedAt);
      }
      return (await this.dependencies.repository.getFaxJob(job.id))!;
    }
    const updatedAt = this.dependencies.clock.now().toISOString();
    if (job.state !== nextState) transitionFax(job.state, nextState);
    const updated = await this.dependencies.repository.updateFaxJobIfState(job.id, job.state, {
      state: nextState,
      providerFaxId: providerFax.id,
      fromNumber: providerFax.from || job.fromNumber,
      toNumber: providerFax.to || job.toNumber,
      pageCount: providerFax.pageCount ?? job.pageCount,
      reportedCost: providerFax.price,
      failureCode: providerFax.errorCode,
      failureMessage: providerFax.errorMessage,
      submittedAt: job.submittedAt ?? updatedAt,
      ...(["delivered", "failed"].includes(nextState) ? { completedAt: updatedAt } : {}),
      updatedAt,
    });
    if (!updated) {
      const current = await this.requireJob(job.id);
      return this.applyProviderFax(current, providerFax, startedAt);
    }
    if (["delivered", "failed"].includes(nextState)) {
      await this.dependencies.repository.revokeContentTokensForFax(job.id, updatedAt);
    }
    await this.safeRecordProviderFaxEvent(updated, providerFax, nextState, startedAt);
    return (await this.dependencies.repository.getFaxJob(job.id))!;
  }

  private async safeRecordProviderFaxEvent(
    job: FaxJob,
    providerFax: ProviderFax,
    resultingState: FaxState,
    startedAt: number,
  ): Promise<void> {
    try {
      await this.recordProviderFaxEvent(job, providerFax, resultingState, startedAt);
    } catch (error) {
      console.error(JSON.stringify({
        event: "fax.provider_event_audit_failed",
        faxJobId: job.id,
        correlationId: job.correlationId,
        temporaryNumberId: job.temporaryNumberId,
        providerFaxId: providerFax.id,
        resultingState,
        durationMs: this.dependencies.clock.now().getTime() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }

  private async storeSubmissionRecovery(job: FaxJob, providerFax: ProviderFax): Promise<void> {
    const payload = JSON.stringify({
      faxJobId: job.id,
      correlationId: job.correlationId,
      providerFaxId: providerFax.id,
      recordedAt: this.dependencies.clock.now().toISOString(),
    });
    try {
      await this.dependencies.documents.put(submissionRecoveryKey(job.id), payload, {
        contentType: "application/json",
        sha256: await sha256Hex(payload),
        uploadedAt: this.dependencies.clock.now().toISOString(),
      });
    } catch (error) {
      console.error(JSON.stringify({
        event: "fax.submission_recovery_storage_failed",
        faxJobId: job.id,
        correlationId: job.correlationId,
        providerFaxId: providerFax.id,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }

  private async recoveredProviderFaxId(job: FaxJob): Promise<string | null> {
    const stored = await this.dependencies.documents.get(submissionRecoveryKey(job.id));
    if (!stored) return null;
    try {
      const value = JSON.parse(await new Response(stored.body).text()) as Record<string, unknown>;
      return value.faxJobId === job.id && typeof value.providerFaxId === "string"
        ? value.providerFaxId
        : null;
    } catch {
      return null;
    }
  }

  private async recordProviderFaxEvent(
    job: FaxJob,
    providerFax: ProviderFax,
    resultingState: FaxState,
    startedAt: number,
  ): Promise<void> {
    await this.dependencies.audit.record({
      correlationId: job.correlationId,
      faxJobId: job.id,
      temporaryNumberId: job.temporaryNumberId,
      source: "provider",
      type: `fax.${resultingState}`,
      resultingState,
      durationMs: this.dependencies.clock.now().getTime() - startedAt,
      details: {
        providerFaxId: providerFax.id,
        status: providerFax.status,
        pageCount: providerFax.pageCount,
        errorCode: providerFax.errorCode,
      },
      rawPayload: providerFax.raw,
    });
  }

  private async requireJob(id: string): Promise<FaxJob> {
    const job = await this.dependencies.repository.getFaxJob(id);
    if (!job) throw new NotFoundError("Fax job", id);
    return job;
  }
}

function submissionRecoveryKey(faxJobId: string): string {
  return `diagnostics/submissions/${faxJobId}.json`;
}
