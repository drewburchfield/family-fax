import type { Clock } from "../../domain/clock";
import { ConflictError, NotFoundError } from "../../domain/errors";
import type {
  FaxJob,
  FaxNotification,
  FaxNotificationKind,
  TemporaryNumber,
} from "../../shared/contracts";
import type { FaxEmailNotification, FaxEmailNotifier } from "../notifications/fax-email";
import type { Repository } from "../repositories/types";
import type { DocumentStore } from "../storage/document-store";
import type { AuditService } from "./audit-service";

interface NotificationContext {
  fax: FaxJob;
  number: TemporaryNumber | null;
  destinationEmail: string;
}

interface PreparedNotification extends NotificationContext {
  message: FaxEmailNotification;
}

export class NotificationService {
  constructor(
    private readonly dependencies: {
      repository: Repository;
      documents: DocumentStore;
      audit: AuditService;
      notifier: FaxEmailNotifier | null;
      providerName: string;
      defaultDestinationEmail: string;
      clock: Clock;
    },
  ) {}

  async deliver(faxJobId: string, kind: FaxNotificationKind): Promise<FaxNotification> {
    const context = await this.context(faxJobId, kind);
    const timestamp = this.dependencies.clock.now().toISOString();
    const notification: FaxNotification = {
      faxJobId,
      kind,
      state: "sending",
      destinationEmail: context.destinationEmail,
      attempt: 1,
      messageId: null,
      attached: null,
      lastError: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      deliveredAt: null,
    };
    const claimed = await this.dependencies.repository.createFaxNotification(notification);
    if (!claimed) {
      const existing = await this.dependencies.repository.getFaxNotification(faxJobId, kind);
      if (!existing) throw new ConflictError("The email notification claim could not be read.");
      return existing;
    }
    return this.prepareAndSend(context, notification);
  }

  async retry(faxJobId: string): Promise<FaxNotification> {
    const fax = await this.requireFax(faxJobId);
    const kind = notificationKindForFax(fax);
    const existing = await this.dependencies.repository.getFaxNotification(fax.id, kind);
    if (!existing) return this.deliver(fax.id, kind);
    if (existing.state === "delivered") return existing;
    if (existing.state === "sending") {
      throw new ConflictError("Email delivery is already in progress or awaiting confirmation.");
    }
    const context = await this.context(fax.id, kind);
    const timestamp = this.dependencies.clock.now().toISOString();
    const claimed = await this.dependencies.repository.updateFaxNotificationIfState(
      fax.id,
      kind,
      existing.state,
      {
        state: "sending",
        attempt: existing.attempt + 1,
        messageId: null,
        attached: null,
        lastError: null,
        updatedAt: timestamp,
        deliveredAt: null,
      },
    );
    if (!claimed) throw new ConflictError("Another email retry already started.");
    return this.prepareAndSend(context, claimed);
  }

  async markStaleSendingUnknown(before: string): Promise<number> {
    const stuck = await this.dependencies.repository.listStuckFaxNotifications(before);
    let marked = 0;
    for (const notification of stuck) {
      const timestamp = this.dependencies.clock.now().toISOString();
      const updated = await this.dependencies.repository.updateFaxNotificationIfState(
        notification.faxJobId,
        notification.kind,
        "sending",
        {
          state: "delivery_unknown",
          lastError: "Email delivery was started, but durable acceptance could not be confirmed.",
          updatedAt: timestamp,
        },
      );
      if (!updated) continue;
      marked += 1;
      const fax = await this.dependencies.repository.getFaxJob(notification.faxJobId);
      if (fax) {
        await this.recordAudit(fax, null, {
          type: "fax.email_delivery_unknown",
          resultingState: "delivery_unknown",
          attempt: updated.attempt,
          details: {
            kind: updated.kind,
            destinationEmail: updated.destinationEmail,
            messageId: updated.messageId,
            attached: updated.attached,
            durationMs: null,
            finalState: "delivery_unknown",
          },
        });
      }
    }
    return marked;
  }

  private async prepareAndSend(
    context: NotificationContext,
    notification: FaxNotification,
  ): Promise<FaxNotification> {
    const startedAt = Date.now();
    let prepared: PreparedNotification;
    try {
      prepared = await this.prepare(context, notification.kind);
    } catch (error) {
      return this.failClaim(context, notification, error, startedAt);
    }
    return this.sendClaimed(prepared, notification, startedAt);
  }

  private async sendClaimed(
    prepared: PreparedNotification,
    notification: FaxNotification,
    startedAt: number,
  ): Promise<FaxNotification> {
    const notifier = this.dependencies.notifier;
    if (!notifier) {
      return this.failClaim(
        prepared,
        notification,
        new ConflictError("Email confirmation is unavailable in this deployment."),
        startedAt,
      );
    }
    await this.recordAudit(prepared.fax, prepared.number, {
      type: "fax.email_sending",
      resultingState: "sending",
      attempt: notification.attempt,
      details: {
        kind: notification.kind,
        destinationEmail: notification.destinationEmail,
        byteCount: prepared.message.bytes.byteLength,
        attached: null,
        finalState: null,
      },
    });
    let result: Awaited<ReturnType<FaxEmailNotifier["send"]>>;
    try {
      result = await notifier.send({ ...prepared.message, attempt: notification.attempt });
    } catch (error) {
      return this.failClaim(prepared, notification, error, startedAt);
    }
    const timestamp = this.dependencies.clock.now().toISOString();
    let delivered: FaxNotification | null;
    try {
      delivered = await this.dependencies.repository.updateFaxNotificationIfState(
        notification.faxJobId,
        notification.kind,
        "sending",
        {
          state: "delivered",
          messageId: result.messageId,
          attached: result.attached,
          lastError: null,
          updatedAt: timestamp,
          deliveredAt: timestamp,
        },
      );
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "fax.email_delivery_persistence_failed",
          faxJobId: notification.faxJobId,
          kind: notification.kind,
          correlationId: prepared.fax.correlationId,
          destinationEmail: notification.destinationEmail,
          attempt: notification.attempt,
          messageId: result.messageId,
          attached: result.attached,
          byteCount: prepared.message.bytes.byteLength,
          durationMs: Date.now() - startedAt,
          finalState: "sending",
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      return notification;
    }
    if (!delivered) {
      console.error(
        JSON.stringify({
          event: "fax.email_delivery_state_conflict",
          faxJobId: notification.faxJobId,
          correlationId: prepared.fax.correlationId,
          kind: notification.kind,
          destinationEmail: notification.destinationEmail,
          attempt: notification.attempt,
          messageId: result.messageId,
          attached: result.attached,
          byteCount: prepared.message.bytes.byteLength,
          durationMs: Date.now() - startedAt,
          finalState: "sending",
        }),
      );
      return (await this.dependencies.repository.getFaxNotification(
        notification.faxJobId,
        notification.kind,
      )) ?? notification;
    }
    await this.recordAudit(prepared.fax, prepared.number, {
      type: "fax.email_delivered",
      resultingState: "delivered",
      attempt: delivered.attempt,
      durationMs: Date.now() - startedAt,
      details: {
        kind: delivered.kind,
        destinationEmail: delivered.destinationEmail,
        messageId: delivered.messageId,
        attached: delivered.attached,
        byteCount: prepared.message.bytes.byteLength,
        finalState: "delivered",
      },
    });
    return delivered;
  }

  private async failClaim(
    context: NotificationContext,
    notification: FaxNotification,
    error: unknown,
    startedAt: number,
  ): Promise<FaxNotification> {
    const timestamp = this.dependencies.clock.now().toISOString();
    const message = error instanceof Error ? error.message : String(error);
    let failed: FaxNotification | null = null;
    try {
      failed = await this.dependencies.repository.updateFaxNotificationIfState(
        notification.faxJobId,
        notification.kind,
        "sending",
        { state: "failed", lastError: message, updatedAt: timestamp },
      );
    } catch (persistenceError) {
      console.error(
        JSON.stringify({
          event: "fax.email_failure_persistence_failed",
          faxJobId: notification.faxJobId,
          correlationId: context.fax.correlationId,
          kind: notification.kind,
          destinationEmail: notification.destinationEmail,
          attempt: notification.attempt,
          attached: null,
          byteCount: "message" in context
            ? (context as PreparedNotification).message.bytes.byteLength
            : null,
          durationMs: Date.now() - startedAt,
          finalState: "sending",
          error: persistenceError instanceof Error ? persistenceError.message : String(persistenceError),
        }),
      );
    }
    const outcome = failed ?? notification;
    await this.recordAudit(context.fax, context.number, {
      type: "fax.email_failed",
      resultingState: outcome.state,
      attempt: notification.attempt,
      durationMs: Date.now() - startedAt,
      details: {
        kind: notification.kind,
        destinationEmail: notification.destinationEmail,
        attached: null,
        byteCount: "message" in context
          ? (context as PreparedNotification).message.bytes.byteLength
          : null,
        finalState: outcome.state,
        error: message,
      },
    });
    return outcome;
  }

  private async context(
    faxJobId: string,
    kind: FaxNotificationKind,
  ): Promise<NotificationContext> {
    const fax = await this.requireFax(faxJobId);
    assertNotificationReady(fax, kind);
    const number = fax.temporaryNumberId
      ? await this.dependencies.repository.getTemporaryNumber(fax.temporaryNumberId)
      : null;
    return {
      fax,
      number,
      destinationEmail: number?.forwardingEmail ?? this.dependencies.defaultDestinationEmail,
    };
  }

  private async prepare(
    context: NotificationContext,
    kind: FaxNotificationKind,
  ): Promise<PreparedNotification> {
    const { fax, number } = context;
    const documents = await this.dependencies.repository.listDocumentsForFax(fax.id);
    const expectedKind = kind === "inbound_received" ? "inbound" : "final-packet";
    const document =
      (fax.finalDocumentId
        ? documents.find((item) => item.id === fax.finalDocumentId)
        : undefined) ?? documents.find((item) => item.kind === expectedKind);
    if (!document) throw new NotFoundError("Fax notification document", fax.id);
    const stored = await this.dependencies.documents.get(document.objectKey);
    if (!stored) throw new NotFoundError("Stored fax notification document", document.objectKey);
    const bytes = await new Response(stored.body).arrayBuffer();
    return {
      fax,
      number,
      destinationEmail: context.destinationEmail,
      message: {
        kind,
        faxJobId: fax.id,
        attempt: 0,
        destinationEmail: context.destinationEmail,
        fromNumber: fax.fromNumber ?? number?.e164 ?? "Unknown sender",
        toNumber: fax.toNumber ?? number?.e164 ?? "Unknown destination",
        occurredAt: fax.completedAt ?? fax.updatedAt,
        pageCount: fax.pageCount ?? document.pageCount,
        providerName: number?.providerName ?? this.dependencies.providerName,
        providerFaxId: fax.providerFaxId,
        providerResult: fax.state,
        filename: document.displayName,
        mimeType: document.mimeType,
        bytes,
      },
    };
  }

  private async requireFax(faxJobId: string): Promise<FaxJob> {
    const fax = await this.dependencies.repository.getFaxJob(faxJobId);
    if (!fax) throw new NotFoundError("Fax job", faxJobId);
    return fax;
  }

  private async recordAudit(
    fax: FaxJob,
    number: TemporaryNumber | null,
    input: {
      type: string;
      resultingState: string;
      attempt?: number;
      durationMs?: number;
      details: Record<string, unknown>;
    },
  ): Promise<void> {
    try {
      await this.dependencies.audit.record({
        correlationId: fax.correlationId,
        faxJobId: fax.id,
        temporaryNumberId: number?.id ?? fax.temporaryNumberId,
        source: "application",
        ...input,
      });
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "fax.email_audit_failed",
          faxJobId: fax.id,
          correlationId: fax.correlationId,
          temporaryNumberId: number?.id ?? fax.temporaryNumberId,
          type: input.type,
          resultingState: input.resultingState,
          attempt: input.attempt ?? null,
          durationMs: input.durationMs ?? null,
          details: input.details,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }
}

function notificationKindForFax(fax: FaxJob): FaxNotificationKind {
  if (fax.direction === "inbound" && fax.state === "delivered") return "inbound_received";
  if (fax.direction === "outbound" && fax.state === "delivered") return "outbound_delivered";
  throw new ConflictError("Email confirmation is available only for a delivered fax.");
}

function assertNotificationReady(fax: FaxJob, kind: FaxNotificationKind): void {
  const expected = notificationKindForFax(fax);
  if (kind !== expected) {
    throw new ConflictError("The requested email notification does not match this fax.");
  }
}
