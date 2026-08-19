import type { FaxProvider } from "../../providers/fax-provider";
import type { Repository } from "../repositories/types";
import type { DocumentStore } from "../storage/document-store";
import { sanitizeDiagnosticValue } from "./audit-service";

export class DiagnosticsService {
  constructor(
    private readonly repository: Repository,
    private readonly provider: FaxProvider,
    private readonly documents?: DocumentStore,
    private readonly application: {
      version: string;
      deployment: WorkerVersionMetadata | null;
      configuration?: Record<string, unknown>;
    } = { version: "development", deployment: null },
  ) {}

  async health() {
    const now = new Date();
    const stuckBefore = new Date(now.getTime() - 15 * 60_000).toISOString();
    const [provider, storage, databaseSnapshot] = await Promise.all([
      this.provider.health().catch((error) => ({ ok: false, detail: errorDetail(error, "Provider health check failed.") })),
      (this.documents?.health() ?? Promise.resolve({ ok: true, detail: "Storage check unavailable." }))
        .catch((error) => ({ ok: false, detail: errorDetail(error, "Storage health check failed.") })),
      this.loadDatabaseSnapshot(stuckBefore),
    ]);
    const { database, activeNumbers, events, stuckFaxes, notificationAttention, settings } = databaseSnapshot;
    const releaseFailures = activeNumbers.filter((number) => number.state === "release_failed");
    const failedProvisioning = events.filter((event) =>
      ["number.provision_failed", "number.provision_cleanup_failed", "number.workflow_start_failed"].includes(event.type),
    );
    const emailDeliveryFailures = notificationAttention.filter((item) => item.state === "failed").length;
    const emailDeliveryUnknown = notificationAttention.filter((item) => item.state === "delivery_unknown").length;
    const staleEmailDeliveries = notificationAttention.filter((item) => item.state === "sending").length;
    return {
      ok: provider.ok && database.ok && storage.ok && releaseFailures.length === 0 &&
        emailDeliveryFailures === 0 && emailDeliveryUnknown === 0 && staleEmailDeliveries === 0,
      provider: sanitizeDiagnosticValue(provider),
      database,
      storage,
      application: this.applicationDetails(),
      activeNumberCount: activeNumbers.length,
      activeWorkflowCount: activeNumbers.filter((number) => number.workflowId).length,
      overdueNumberCount: activeNumbers.filter((number) => {
        const releaseAt = number.releaseAt ?? number.expiresAt;
        return Boolean(releaseAt && releaseAt <= now.toISOString());
      }).length,
      lateFaxUpdateCount: stuckFaxes.length,
      recentProvisioningFailures: failedProvisioning.length,
      emailDeliveryFailures,
      emailDeliveryUnknown,
      staleEmailDeliveries,
      releaseFailures: releaseFailures.length,
      lastScheduledSweep: settings.lastScheduledSweep,
      lastWebhook: events.find((event) => event.source === "webhook")?.createdAt ?? null,
      lastAuthenticatedWebhook: settings.lastAuthenticatedWebhook,
      lastRejectedWebhook: settings.lastRejectedWebhook,
    };
  }

  private async loadDatabaseSnapshot(stuckBefore: string) {
    try {
      const database = await this.repository.health();
      const [activeNumbers, events, stuckFaxes, notificationAttention, lastScheduledSweep, lastAuthenticatedWebhook, lastRejectedWebhook] =
        await Promise.all([
          this.repository.listActiveNumbers(),
          this.repository.listRecentEvents(25),
          this.repository.listStuckFaxJobs(stuckBefore),
          this.repository.listFaxNotificationsNeedingAttention(stuckBefore),
          this.repository.getSetting<string>("lastScheduledSweep"),
          this.repository.getSetting<string>("lastAuthenticatedWebhook"),
          this.repository.getSetting<string>("lastRejectedWebhook"),
        ]);
      return {
        database,
        activeNumbers,
        events,
        stuckFaxes,
        notificationAttention,
        settings: { lastScheduledSweep, lastAuthenticatedWebhook, lastRejectedWebhook },
      };
    } catch (error) {
      return {
        database: { ok: false, detail: errorDetail(error, "Database health check failed.") },
        activeNumbers: [],
        events: [],
        stuckFaxes: [],
        notificationAttention: [],
        settings: {
          lastScheduledSweep: null,
          lastAuthenticatedWebhook: null,
          lastRejectedWebhook: null,
        },
      };
    }
  }

  async faxBundle(faxJobId: string) {
    const [fax, documents, events, notifications] = await Promise.all([
      this.repository.getFaxJob(faxJobId),
      this.repository.listDocumentsForFax(faxJobId),
      this.repository.listEventsForFax(faxJobId),
      this.repository.listFaxNotificationsForFax(faxJobId),
    ]);
    const rawPayloads: Record<string, unknown> = {};
    if (this.documents) {
      for (const event of events.filter((item) => item.rawPayloadKey)) {
        const stored = await this.documents.get(event.rawPayloadKey!);
        if (!stored) continue;
        const text = await new Response(stored.body).text();
        try {
          rawPayloads[event.id] = JSON.parse(text);
        } catch {
          rawPayloads[event.id] = text;
        }
      }
    }
    return {
      generatedAt: new Date().toISOString(),
      application: this.applicationDetails(),
      fax,
      documents,
      events,
      notifications,
      rawPayloads,
    };
  }

  private applicationDetails() {
    return {
      version: this.application.version,
      deploymentId: this.application.deployment?.id ?? null,
      deploymentTag: this.application.deployment?.tag ?? null,
      deployedAt: this.application.deployment?.timestamp ?? null,
      configuration: sanitizeDiagnosticValue(this.application.configuration ?? {}),
    };
  }
}

function errorDetail(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}
