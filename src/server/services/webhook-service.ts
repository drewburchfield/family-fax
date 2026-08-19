import type { Clock } from "../../domain/clock";
import { sha256Hex } from "../../domain/crypto";
import { ConflictError, NotFoundError } from "../../domain/errors";
import type { FaxProvider } from "../../providers/fax-provider";
import type { FaxWebhookEvent } from "../../providers/webhook";
import type { FaxJob, TemporaryNumber } from "../../shared/contracts";
import type { Repository } from "../repositories/types";
import type { DocumentStore } from "../storage/document-store";
import type { AuditService } from "./audit-service";
import type { FaxTerminalService } from "./fax-terminal-service";
import type { FaxService } from "./fax-service";
import type { NotificationService } from "./notification-service";

export class WebhookService {
  private readonly idGenerator: () => string;

  constructor(
    private readonly dependencies: {
      repository: Repository;
      documents: DocumentStore;
      audit: AuditService;
      fax: FaxService;
      provider: FaxProvider;
      notifications: NotificationService;
      terminal: FaxTerminalService;
      clock: Clock;
      idGenerator?: () => string;
    },
  ) {
    this.idGenerator = dependencies.idGenerator ?? (() => crypto.randomUUID());
  }

  async handleProviderEvent(
    event: FaxWebhookEvent,
  ): Promise<{ duplicate: boolean; faxJobId: string | null }> {
    const claimed = await this.dependencies.repository.claimWebhook(
      event.provider,
      event.eventKey,
      this.dependencies.clock.now().toISOString(),
    );
    if (!claimed) {
      const faxJobId = event.type === "incoming"
        ? await this.resumeMissingInboundNotification(event)
        : null;
      return { duplicate: true, faxJobId };
    }
    if (event.type === "status") {
      try {
        const job = await this.dependencies.fax.applyProviderUpdate(event.fax);
        if (!job) throw new NotFoundError("Fax job for provider fax", event.fax.id);
        await this.dependencies.terminal.complete(job.id);
        return { duplicate: false, faxJobId: job.id };
      } catch (error) {
        await this.dependencies.repository.releaseWebhookClaim(event.provider, event.eventKey);
        throw error;
      }
    }
    let faxJobId: string;
    try {
      faxJobId = await this.archiveInbound(event);
    } catch (error) {
      await this.dependencies.repository.releaseWebhookClaim(event.provider, event.eventKey);
      throw error;
    }
    await this.dependencies.notifications.deliver(faxJobId, "inbound_received");
    return { duplicate: false, faxJobId };
  }

  private async archiveInbound(event: FaxWebhookEvent): Promise<string> {
    const number = await this.dependencies.repository.getTemporaryNumberByE164(event.fax.to);
    if (!number) throw new NotFoundError("Active temporary number", event.fax.to);
    if (!["active", "expiring", "releasing", "release_failed"].includes(number.state)) {
      throw new ConflictError("This fax number is not currently accepting inbound documents.", {
        temporaryNumberId: number.id,
        numberState: number.state,
      });
    }
    const timestamp = this.dependencies.clock.now().toISOString();
    let job = await this.dependencies.repository.getFaxJobByProviderId(event.fax.id);
    if (!job) {
      job = this.inboundJob(event, number, timestamp);
      await this.dependencies.repository.createFaxJob(job);
    }
    let [document] = (await this.dependencies.repository.listDocumentsForFax(job.id)).filter(
      (item) => item.kind === "inbound",
    );
    if (!document) {
      const providerDocument = event.file ?? (await this.dependencies.provider.downloadFax(event.fax.id));
      const bytes = await new Response(providerDocument.body).arrayBuffer();
      const documentId = this.idGenerator();
      const objectKey = `faxes/${job.id}/inbound.pdf`;
      const digest = await sha256Hex(bytes);
      await this.dependencies.documents.put(objectKey, bytes, {
        contentType: providerDocument.contentType,
        sha256: digest,
        uploadedAt: timestamp,
      });
      document = {
        id: documentId,
        faxJobId: job.id,
        temporaryNumberId: number.id,
        kind: "inbound",
        objectKey,
        mimeType: providerDocument.contentType,
        byteCount: providerDocument.size ?? bytes.byteLength,
        pageCount: event.fax.pageCount,
        sha256: digest,
        displayName: `fax-from-${event.fax.from}.pdf`,
        createdAt: timestamp,
      };
      await this.dependencies.repository.createDocument(document);
    }
    if (job.finalDocumentId !== document.id) {
      await this.dependencies.repository.updateFaxJob(job.id, { finalDocumentId: document.id, updatedAt: timestamp });
      job = (await this.dependencies.repository.getFaxJob(job.id))!;
    }
    const alreadyAudited = (await this.dependencies.repository.listEventsForFax(job.id)).some(
      (item) => item.type === "fax.received",
    );
    if (!alreadyAudited) {
      await this.dependencies.audit.record({
        correlationId: job.correlationId,
        faxJobId: job.id,
        temporaryNumberId: number.id,
        source: "webhook",
        type: "fax.received",
        resultingState: "delivered",
        details: {
          providerFaxId: event.fax.id,
          from: event.fax.from,
          to: event.fax.to,
          pages: event.fax.pageCount,
          forwardingEmail: number.forwardingEmail,
        },
        rawPayload: event.raw,
      });
    }
    return job.id;
  }

  private async resumeMissingInboundNotification(event: FaxWebhookEvent): Promise<string | null> {
    const job = await this.dependencies.repository.getFaxJobByProviderId(event.fax.id);
    if (!job || job.direction !== "inbound" || job.state !== "delivered" || !job.finalDocumentId) {
      return job?.id ?? null;
    }
    const existing = await this.dependencies.repository.getFaxNotification(job.id, "inbound_received");
    if (!existing) await this.dependencies.notifications.deliver(job.id, "inbound_received");
    return job.id;
  }

  private inboundJob(
    event: FaxWebhookEvent,
    number: TemporaryNumber,
    timestamp: string,
  ): FaxJob {
    return {
      id: this.idGenerator(),
      mode: number.mode,
      direction: "inbound",
      state: "delivered",
      toNumber: event.fax.to,
      fromNumber: event.fax.from,
      providerFaxId: event.fax.id,
      providerProjectId: null,
      temporaryNumberId: number.id,
      correlationId: this.idGenerator(),
      finalDocumentId: null,
      pageCount: event.fax.pageCount,
      estimatedCost: null,
      reportedCost: event.fax.price,
      requestedTtlDays: null,
      coverData: null,
      failureCode: event.fax.errorCode,
      failureMessage: event.fax.errorMessage,
      createdAt: event.fax.createdAt,
      updatedAt: timestamp,
      submittedAt: null,
      completedAt: event.fax.completedAt ?? timestamp,
    };
  }
}
