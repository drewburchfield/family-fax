import { parseRuntimeConfig } from "../domain/config";
import { systemClock } from "../domain/clock";
import { createFaxProvider } from "../providers/provider-factory";
import { D1Repository } from "../server/repositories/d1-repository";
import {
  CloudflareFaxEmailNotifier,
  DemoFaxEmailNotifier,
} from "../server/notifications/fax-email";
import { AuditService } from "../server/services/audit-service";
import { DiagnosticsService } from "../server/services/diagnostics-service";
import { FaxService } from "../server/services/fax-service";
import { FaxTerminalService } from "../server/services/fax-terminal-service";
import { NotificationService } from "../server/services/notification-service";
import { NumberService } from "../server/services/number-service";
import { WebhookService } from "../server/services/webhook-service";
import { R2DocumentStore } from "../server/storage/document-store";
import type { WorkerEnv } from "./env";

export function createServiceContainer(env: WorkerEnv) {
  const config = parseRuntimeConfig(env);
  const repository = new D1Repository(env.DB);
  const documents = new R2DocumentStore(env.DOCUMENTS);
  const provider = createFaxProvider(config);
  const audit = new AuditService(repository, documents, systemClock);
  const fax = new FaxService({
    repository,
    documents,
    audit,
    provider,
    clock: systemClock,
    defaultPhoneCountry: config.defaultPhoneCountry,
  });
  const notifier = !config.isDemo
    ? new CloudflareFaxEmailNotifier(requireEmailBinding(env), {
        fromAddress: requireEmailConfig(config),
        appBaseUrl: config.appBaseUrl!,
        maxAttachmentBytes: config.maxEmailAttachmentBytes,
      })
    : new DemoFaxEmailNotifier();
  const notifications = new NotificationService({
    repository,
    documents,
    audit,
    notifier,
    providerName: provider.name,
    defaultDestinationEmail: config.defaultForwardEmail,
    clock: systemClock,
  });
  const numbers = new NumberService({
    repository,
    audit,
    provider,
    clock: systemClock,
    maxTtlDays: config.maxTtlDays,
    maxRentalMonths: config.maxRentalMonths,
    minimumNumberHoldDays: config.signalwire?.minimumNumberHoldDays ?? 0,
    ...(config.webhook
      ? { inboundCallbackUrl: authenticatedWebhookUrl(config.webhook, provider.name, "incoming") }
      : {}),
  });
  const terminal = new FaxTerminalService({ repository, notifications, numbers });
  const webhook = new WebhookService({
    repository,
    documents,
    audit,
    fax,
    provider,
    notifications,
    terminal,
    clock: systemClock,
  });
  const diagnostics = new DiagnosticsService(repository, provider, documents, {
    version: config.appVersion,
    deployment: env.CF_VERSION_METADATA ?? null,
    configuration: {
      provider: config.provider,
      retention: config.retention,
      logDetail: config.logDetail,
      maxUploadBytes: config.maxUploadBytes,
      maxFaxPages: config.maxFaxPages,
      maxTtlDays: config.maxTtlDays,
      preferredAreaCodes: config.preferredAreaCodes,
    },
  });
  return {
    config,
    repository,
    documents,
    provider,
    audit,
    fax,
    numbers,
    notifications,
    terminal,
    webhook,
    diagnostics,
  };
}

function requireEmailBinding(env: WorkerEnv): SendEmail {
  if (!env.EMAIL) {
    throw new Error("The EMAIL send binding is required for a live fax provider.");
  }
  return env.EMAIL;
}

function requireEmailConfig(config: ReturnType<typeof parseRuntimeConfig>): string {
  if (!config.email) {
    throw new Error("EMAIL_FROM_ADDRESS is required for a live fax provider.");
  }
  return config.email.fromAddress;
}

function authenticatedWebhookUrl(
  webhook: { baseUrl: string; username: string; password: string },
  provider: string,
  kind: string,
): string {
  const path = provider === "signalwire" ? `/webhooks/${provider}/${kind}` : "/webhooks/sinch";
  const url = new URL(path, webhook.baseUrl);
  url.username = webhook.username;
  url.password = webhook.password;
  return url.toString();
}

export type ServiceContainer = ReturnType<typeof createServiceContainer>;
