import { Hono, type Context } from "hono";
import { z } from "zod";

import { systemClock, type Clock } from "../../domain/clock";
import { toPublicConfig, type RuntimeConfig } from "../../domain/config";
import { ConflictError, NotFoundError } from "../../domain/errors";
import { sha256Hex } from "../../domain/crypto";
import { DemoFaxProvider } from "../../providers/demo-fax-provider";
import type { FaxProvider } from "../../providers/fax-provider";
import {
  parseSignalWireFaxWebhook,
  signalWireReceiveXml,
} from "../../providers/signalwire/webhook";
import { parseSinchWebhook, WebhookAuthError } from "../../providers/sinch/webhook";
import { assertWebhookBasicAuth } from "../../providers/webhook";
import type { CoverTemplate } from "../repositories/types";
import type { Repository } from "../repositories/types";
import { AccessAuthenticator, assertSameOriginMutation, type AuthenticatedIdentity } from "../auth/access";
import { createServiceContainer } from "../../worker/services";
import type { AuditService } from "../services/audit-service";
import type { DiagnosticsService } from "../services/diagnostics-service";
import type { FaxService } from "../services/fax-service";
import type { FaxTerminalService } from "../services/fax-terminal-service";
import type { NumberService } from "../services/number-service";
import type { NotificationService } from "../services/notification-service";
import type { WebhookService } from "../services/webhook-service";
import type { DocumentStore } from "../storage/document-store";
import type {
  NumberLifecycleWorkflowParams,
  WorkerEnv,
  WorkflowNumberCandidate,
} from "../../worker/env";
import { problemResponse } from "./responses";
import {
  cancelSchema,
  draftSchema,
  numberCandidateSchema,
  parseJson,
  preferencesSchema,
  prepareSchema,
  startSchema,
  templateSchema,
} from "./validation";

export interface HttpDependencies {
  config: RuntimeConfig;
  repository: Repository;
  documents: DocumentStore;
  provider: FaxProvider;
  audit: AuditService;
  fax: FaxService;
  terminal: FaxTerminalService;
  numbers: NumberService;
  notifications: NotificationService;
  webhook: WebhookService;
  diagnostics: DiagnosticsService;
  auth: AccessAuthenticator;
  clock: Clock;
  startNumberWorkflow(input: NumberLifecycleWorkflowParams): Promise<string>;
  startOutboundWorkflow(input: {
    faxJobId: string;
    temporaryNumberId: string;
    appBaseUrl: string;
  }): Promise<string>;
}

type Variables = {
  dependencies: HttpDependencies;
  identity: AuthenticatedIdentity;
  correlationId: string;
};

type AppEnvironment = { Bindings: WorkerEnv; Variables: Variables };
type DependencyResolver = (env: WorkerEnv) => Promise<HttpDependencies> | HttpDependencies;

export function createApp(resolveDependencies: DependencyResolver = defaultDependencies) {
  const app = new Hono<AppEnvironment>();

  app.use("*", async (context, next) => {
    const correlationId = context.req.header("X-Correlation-ID") ?? crypto.randomUUID();
    context.set("correlationId", correlationId);
    context.set("dependencies", await resolveDependencies(context.env));
    await next();
    context.res.headers.set("X-Correlation-ID", correlationId);
  });

  app.use("/api/*", async (context, next) => {
    const dependencies = context.get("dependencies");
    context.set("identity", await dependencies.auth.authenticate(context.req.raw));
    assertSameOriginMutation(context.req.raw);
    await next();
  });

  app.get("/api/bootstrap", async (context) => {
    const dependencies = context.get("dependencies");
    const preferences = await getPreferences(dependencies);
    const [activeNumbers, recentFaxes, templates] = await Promise.all([
      dependencies.repository.listActiveNumbers(),
      dependencies.repository.listFaxJobs({ limit: 20 }),
      dependencies.repository.listCoverTemplates(),
    ]);
    return context.json({
      config: { ...toPublicConfig(dependencies.config), ...preferences },
      identity: context.get("identity"),
      activeNumbers,
      recentFaxes,
      templates,
    });
  });

  app.get("/api/faxes", async (context) => {
    const search = context.req.query("search")?.trim();
    const limit = Math.min(Number.parseInt(context.req.query("limit") ?? "100", 10) || 100, 250);
    return context.json({ faxes: await context.get("dependencies").repository.listFaxJobs({ search, limit }) });
  });

  app.get("/api/faxes/:id", async (context) => {
    const { repository } = context.get("dependencies");
    const fax = await repository.getFaxJob(context.req.param("id"));
    if (!fax) throw new NotFoundError("Fax job", context.req.param("id"));
    const [documents, events, notifications] = await Promise.all([
      repository.listDocumentsForFax(fax.id),
      repository.listEventsForFax(fax.id),
      repository.listFaxNotificationsForFax(fax.id),
    ]);
    return context.json({ fax, documents, events, notifications });
  });

  app.post("/api/faxes", async (context) => {
    const input = await parseJson(context.req.raw, draftSchema);
    const dependencies = context.get("dependencies");
    if (
      input.mode !== "send-only" &&
      input.requestedTtlDays !== null &&
      input.requestedTtlDays !== undefined &&
      input.requestedTtlDays > dependencies.config.maxTtlDays
    ) {
      throw new ConflictError(`The receive duration cannot exceed ${dependencies.config.maxTtlDays} days.`);
    }
    if (
      input.requestedRentalMonths !== null &&
      input.requestedRentalMonths !== undefined &&
      input.requestedRentalMonths > dependencies.config.maxRentalMonths
    ) {
      throw new ConflictError(`The receive term cannot exceed ${dependencies.config.maxRentalMonths} months.`);
    }
    const fax = await dependencies.fax.createDraft(input);
    return context.json(fax, 201);
  });

  app.put("/api/faxes/:id/documents/:documentId", async (context) => {
    const dependencies = context.get("dependencies");
    const faxJobId = safeIdentifier(context.req.param("id"));
    const documentId = safeIdentifier(context.req.param("documentId"));
    if (!(await dependencies.repository.getFaxJob(faxJobId))) {
      throw new NotFoundError("Fax job", faxJobId);
    }
    const mimeType = (context.req.header("Content-Type") ?? "").split(";")[0]!.toLowerCase();
    const kind = z.enum(["original", "cover", "final-packet"]).parse(context.req.header("X-Document-Kind"));
    if (kind === "final-packet" && mimeType !== "application/pdf") {
      throw new ConflictError("The final fax packet must be a PDF.");
    }
    const byteCount = Number.parseInt(context.req.header("Content-Length") ?? "", 10);
    if (!Number.isSafeInteger(byteCount) || byteCount <= 0 || byteCount > dependencies.config.maxUploadBytes) {
      throw new ConflictError(`Documents must be smaller than ${dependencies.config.maxUploadBytes} bytes.`);
    }
    const pageHeader = context.req.header("X-Document-Pages");
    const pageCount = pageHeader && /^\d+$/.test(pageHeader) ? Number(pageHeader) : null;
    if (pageHeader && pageCount === null) throw new ConflictError("Document page metadata must be an integer.");
    if (pageCount !== null && (!Number.isSafeInteger(pageCount) || pageCount <= 0 || pageCount > dependencies.config.maxFaxPages)) {
      throw new ConflictError(`Documents cannot exceed ${dependencies.config.maxFaxPages} pages.`);
    }
    const digest = context.req.header("X-Document-Sha256");
    if (!digest) throw new ConflictError("Document SHA-256 metadata is required.");
    const encodedDisplayName = context.req.header("X-Document-Name") ?? `${documentId}.pdf`;
    let decodedDisplayName: string;
    try {
      decodedDisplayName = decodeURIComponent(encodedDisplayName);
    } catch {
      throw new ConflictError("Document name metadata is invalid.");
    }
    const displayName = sanitizeFilename(decodedDisplayName);
    if (!context.req.raw.body) throw new ConflictError("The document body is empty.");
    const { storageBody, validation } = validateDocumentStream(
      context.req.raw.body,
      mimeType,
      dependencies.config.maxUploadBytes,
      byteCount,
    );
    const objectKey = `faxes/${faxJobId}/${documentId}-${crypto.randomUUID()}-${displayName}`;
    const uploadedAt = dependencies.clock.now().toISOString();
    const [storageResult, validationResult] = await Promise.allSettled([
      dependencies.documents.put(objectKey, storageBody, {
        contentType: mimeType,
        sha256: digest,
        uploadedAt,
      }),
      validation,
    ]);
    if (storageResult.status === "rejected" || validationResult.status === "rejected") {
      await dependencies.documents.delete(objectKey).catch(() => undefined);
      if (validationResult.status === "rejected") throw validationResult.reason;
      if (storageResult.status === "rejected") throw storageResult.reason;
    }
    try {
      await dependencies.fax.registerDocument(faxJobId, {
        id: documentId,
        kind,
        objectKey,
        mimeType,
        byteCount,
        pageCount,
        sha256: digest,
        displayName,
      });
    } catch (error) {
      await dependencies.documents.delete(objectKey).catch(() => undefined);
      throw error;
    }
    return context.json({ id: documentId, objectKey, byteCount, pageCount }, 201);
  });

  app.post("/api/faxes/:id/prepare", async (context) => {
    const input = await parseJson(context.req.raw, prepareSchema);
    return context.json(
      await context.get("dependencies").fax.prepare(
        context.req.param("id"),
        input.finalDocumentId,
        input.pageCount,
      ),
    );
  });

  app.post("/api/faxes/:id/cancel", async (context) => {
    const input = await parseJson(context.req.raw, cancelSchema);
    return context.json(await context.get("dependencies").fax.cancelDraft(context.req.param("id"), input.reason));
  });

  app.post("/api/numbers/search", async (context) => {
    const schema = z.object({ areaCodes: z.array(z.string().regex(/^\d{3}$/)).min(1).max(10) });
    const { areaCodes } = await parseJson(context.req.raw, schema);
    const dependencies = context.get("dependencies");
    const [providerCandidates, activeNumbers] = await Promise.all([
      dependencies.numbers.search([...new Set(areaCodes)]),
      dependencies.repository.listActiveNumbers(),
    ]);
    const assigned = new Set(activeNumbers.map((number) => number.e164).filter(Boolean));
    const candidates = providerCandidates.filter((candidate) => !assigned.has(candidate.e164));
    return context.json({ candidates });
  });

  app.post("/api/faxes/:id/start", async (context) => {
    const dependencies = context.get("dependencies");
    const input = await parseJson(context.req.raw, startSchema);
    if (!input.confirmed) {
      throw new ConflictError("Confirm the displayed provider price before provisioning a number.");
    }
    const candidate = numberCandidateSchema.parse(input.candidate);
    const currentCandidate = (
      await dependencies.numbers.search([candidate.areaCode], 10)
    ).find((item) => item.e164 === candidate.e164);
    if (!currentCandidate) {
      throw new ConflictError("That number is no longer available. Choose another number.");
    }
    if (
      JSON.stringify(currentCandidate.setupPrice) !== JSON.stringify(candidate.setupPrice) ||
      JSON.stringify(currentCandidate.monthlyPrice) !== JSON.stringify(candidate.monthlyPrice)
    ) {
      throw new ConflictError("The provider price changed. Review the refreshed quote before continuing.", {
        quoted: { setupPrice: candidate.setupPrice, monthlyPrice: candidate.monthlyPrice },
        current: {
          setupPrice: currentCandidate.setupPrice,
          monthlyPrice: currentCandidate.monthlyPrice,
        },
      });
    }
    const number = await dependencies.numbers.requestNumber(
      context.req.param("id"),
      currentCandidate,
      input.forwardingEmail,
    );
    const { raw: _raw, ...workflowCandidate } = currentCandidate;
    let workflowId: string;
    try {
      workflowId = await dependencies.startNumberWorkflow({
        numberId: number.id,
        candidate: workflowCandidate satisfies WorkflowNumberCandidate,
        appBaseUrl: new URL(context.req.url).origin,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "The number workflow start could not be confirmed.";
      try {
        const fax = await dependencies.repository.getFaxJob(context.req.param("id"));
        await dependencies.audit.record({
          correlationId: fax?.correlationId ?? context.get("correlationId"),
          faxJobId: fax?.id ?? context.req.param("id"),
          temporaryNumberId: number.id,
          source: "workflow",
          type: "number.workflow_start_unknown",
          resultingState: number.state,
          details: { message },
        });
      } catch (auditError) {
        console.error(JSON.stringify({
          event: "number.workflow_start_unknown_audit_failed",
          numberId: number.id,
          error: auditError instanceof Error ? auditError.message : String(auditError),
        }));
      }
      return context.json({ number, workflowStartUnknown: true }, 202);
    }
    const [numberUpdate, auditUpdate] = await Promise.allSettled([
      dependencies.repository.updateTemporaryNumber(number.id, { workflowId }),
      (async () => {
        const fax = await dependencies.repository.getFaxJob(context.req.param("id"));
        if (!fax) throw new NotFoundError("Fax job", context.req.param("id"));
        return dependencies.audit.record({
          correlationId: fax.correlationId,
          faxJobId: fax.id,
          temporaryNumberId: number.id,
          source: "workflow",
          type: "number.workflow_started",
          resultingState: number.state,
          details: { workflowId },
        });
      })(),
    ]);
    if (numberUpdate.status === "rejected" || auditUpdate.status === "rejected") {
      console.error(JSON.stringify({
        event: "number.workflow_bookkeeping_failed",
        numberId: number.id,
        workflowId,
        errors: [numberUpdate, auditUpdate].flatMap((result) =>
          result.status === "rejected"
            ? [result.reason instanceof Error ? result.reason.message : String(result.reason)]
            : [],
        ),
      }));
    }
    const updated = numberUpdate.status === "fulfilled" && numberUpdate.value
      ? numberUpdate.value
      : { ...number, workflowId };
    return context.json({ number: updated }, 202);
  });

  app.post("/api/faxes/:id/start-existing", async (context) => {
    const dependencies = context.get("dependencies");
    const input = await parseJson(
      context.req.raw,
      z.object({ temporaryNumberId: z.string().min(1), confirmed: z.literal(true) }),
    );
    const job = await dependencies.fax.startWithExistingNumber(
      context.req.param("id"),
      input.temporaryNumberId,
    );
    try {
      const workflowId = await dependencies.startOutboundWorkflow({
        faxJobId: job.id,
        temporaryNumberId: input.temporaryNumberId,
        appBaseUrl: new URL(context.req.url).origin,
      });
      return context.json({ fax: job, workflowId }, 202);
    } catch (error) {
      const timestamp = dependencies.clock.now().toISOString();
      await dependencies.repository.updateFaxJob(job.id, {
        state: "failed",
        failureCode: "outbound_workflow_start_failed",
        failureMessage: error instanceof Error ? error.message : String(error),
        completedAt: timestamp,
        updatedAt: timestamp,
      });
      throw error;
    }
  });

  app.post("/api/numbers/:id/extend", async (context) => {
    const input = await parseJson(
      context.req.raw,
      z.object({ months: z.number().int().positive(), confirmed: z.literal(true) }),
    );
    return context.json(await context.get("dependencies").numbers.extendNumber(context.req.param("id"), input.months));
  });

  app.post("/api/numbers/:id/cancel-release", async (context) => {
    await parseJson(context.req.raw, z.object({ confirmed: z.literal(true) }));
    return context.json(
      await context.get("dependencies").numbers.cancelScheduledRelease(context.req.param("id")),
    );
  });

  app.put("/api/numbers/:id/forwarding-email", async (context) => {
    const input = await parseJson(context.req.raw, z.object({ forwardingEmail: z.email() }));
    return context.json(
      await context.get("dependencies").numbers.updateForwardingEmail(
        context.req.param("id"),
        input.forwardingEmail,
      ),
    );
  });

  app.get("/api/numbers/:id", async (context) => {
    const number = await context
      .get("dependencies")
      .repository.getTemporaryNumber(context.req.param("id"));
    if (!number) throw new NotFoundError("Temporary number", context.req.param("id"));
    return context.json(number);
  });

  app.post("/api/numbers/:id/release", async (context) => {
    await parseJson(context.req.raw, z.object({ confirmed: z.literal(true) }));
    return context.json(await context.get("dependencies").numbers.releaseNumber(context.req.param("id")));
  });

  app.post("/api/faxes/:id/retry-email", async (context) => {
    await parseJson(context.req.raw, z.object({ confirmed: z.literal(true) }));
    return context.json(await context.get("dependencies").notifications.retry(context.req.param("id")));
  });

  app.get("/api/documents/:id", async (context) => {
    const { repository, documents } = context.get("dependencies");
    const metadata = await repository.getDocument(context.req.param("id"));
    if (!metadata) throw new NotFoundError("Document", context.req.param("id"));
    const object = await documents.get(metadata.objectKey);
    if (!object) throw new NotFoundError("Stored document", metadata.id);
    return streamDocument(object.body, metadata.mimeType, metadata.displayName, object.size);
  });

  app.get("/api/settings", async (context) => context.json(await getPreferences(context.get("dependencies"))));

  app.put("/api/settings", async (context) => {
    const dependencies = context.get("dependencies");
    const preferences = await parseJson(context.req.raw, preferencesSchema);
    if (
      preferences.defaultTtlDays !== undefined &&
      preferences.defaultTtlDays > dependencies.config.maxTtlDays
    ) {
      throw new ConflictError(`The default duration cannot exceed ${dependencies.config.maxTtlDays} days.`);
    }
    if (preferences.defaultRentalMonths > dependencies.config.maxRentalMonths) {
      throw new ConflictError(`The default term cannot exceed ${dependencies.config.maxRentalMonths} months.`);
    }
    await dependencies.repository.setSetting("preferences", preferences, dependencies.clock.now().toISOString());
    await dependencies.audit.record({
      correlationId: context.get("correlationId"),
      source: "user",
      type: "settings.updated",
      details: preferences,
    });
    return context.json(preferences);
  });

  app.get("/api/templates", async (context) =>
    context.json({ templates: await context.get("dependencies").repository.listCoverTemplates() }),
  );

  app.post("/api/templates", async (context) => {
    const dependencies = context.get("dependencies");
    const input = await parseJson(context.req.raw, templateSchema);
    const timestamp = dependencies.clock.now().toISOString();
    const existing = input.id ? (await dependencies.repository.listCoverTemplates()).find((item) => item.id === input.id) : null;
    const template: CoverTemplate = {
      id: input.id ?? crypto.randomUUID(),
      name: input.name,
      data: input.data,
      isDefault: input.isDefault,
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
    };
    await dependencies.repository.upsertCoverTemplate(template);
    await dependencies.audit.record({
      correlationId: context.get("correlationId"),
      source: "user",
      type: "cover_template.saved",
      details: { templateId: template.id, name: template.name, isDefault: template.isDefault },
    });
    return context.json(template, 201);
  });

  app.get("/api/diagnostics", async (context) =>
    context.json(await context.get("dependencies").diagnostics.health()),
  );

  app.get("/api/health", async (context) =>
    context.json(await context.get("dependencies").diagnostics.health()),
  );

  app.get("/api/faxes/:id/diagnostics", async (context) => {
    const dependencies = context.get("dependencies");
    return context.json({
      ...(await dependencies.diagnostics.faxBundle(context.req.param("id"))),
      config: toPublicConfig(dependencies.config),
    });
  });

  app.post("/api/demo/incoming", async (context) => {
    const dependencies = context.get("dependencies");
    if (!(dependencies.provider instanceof DemoFaxProvider)) {
      throw new ConflictError("Incoming fax simulation is available only in demo mode.");
    }
    const input = await parseJson(
      context.req.raw,
      z.object({
        toNumber: z.string().regex(/^\+[1-9]\d{7,14}$/),
        fromNumber: z.string().regex(/^\+[1-9]\d{7,14}$/),
        contentBase64: z.string().optional(),
      }),
    );
    const id = `demo-inbound-${crypto.randomUUID()}`;
    const bytes = decodeBase64(input.contentBase64 ?? btoa("%PDF-1.7 demo inbound"));
    const fax = dependencies.provider.injectInboundFax({ id, from: input.fromNumber, to: input.toNumber, bytes });
    const result = await dependencies.webhook.handleProviderEvent({
      provider: "demo",
      type: "incoming",
      eventKey: `INCOMING_FAX:${id}`,
      eventTime: dependencies.clock.now().toISOString(),
      fax,
      file: null,
      raw: { demo: true, id },
    });
    return context.json(result, 201);
  });

  app.post("/api/demo/faxes/:id/terminal", async (context) => {
    const dependencies = context.get("dependencies");
    if (!(dependencies.provider instanceof DemoFaxProvider)) {
      throw new ConflictError("Terminal fax simulation is available only in demo mode.");
    }
    return context.json(await dependencies.terminal.complete(context.req.param("id")));
  });

  app.post("/webhooks/sinch", async (context) => {
    const dependencies = context.get("dependencies");
    if (!dependencies.config.webhook) throw new NotFoundError("Webhook", "sinch");
    try {
      const event = await parseSinchWebhook(context.req.raw, dependencies.config.webhook);
      const result = await dependencies.webhook.handleProviderEvent(event);
      const timestamp = dependencies.clock.now().toISOString();
      await dependencies.repository.setSetting("lastAuthenticatedWebhook", timestamp, timestamp);
      return context.json({ accepted: true, duplicate: result.duplicate }, 202);
    } catch (error) {
      if (error instanceof WebhookAuthError) {
        const timestamp = dependencies.clock.now().toISOString();
        await dependencies.repository.setSetting("lastRejectedWebhook", timestamp, timestamp);
      }
      throw error;
    }
  });

  app.post("/webhooks/signalwire/incoming", async (context) => {
    const dependencies = context.get("dependencies");
    if (!dependencies.config.webhook) throw new NotFoundError("Webhook", "signalwire");
    try {
      assertWebhookBasicAuth(
        context.req.header("Authorization") ?? null,
        dependencies.config.webhook,
      );
      const actionUrl = authenticatedWebhookUrl(
        dependencies.config.webhook,
        "/webhooks/signalwire/inbound",
      );
      const timestamp = dependencies.clock.now().toISOString();
      await dependencies.repository.setSetting("lastAuthenticatedWebhook", timestamp, timestamp);
      return context.body(signalWireReceiveXml(actionUrl), 200, {
        "Content-Type": "application/xml; charset=utf-8",
      });
    } catch (error) {
      if (error instanceof WebhookAuthError) {
        const timestamp = dependencies.clock.now().toISOString();
        await dependencies.repository.setSetting("lastRejectedWebhook", timestamp, timestamp);
      }
      throw error;
    }
  });

  app.post("/webhooks/signalwire/inbound", async (context) => {
    return handleSignalWireWebhook(context, "inbound");
  });

  app.post("/webhooks/signalwire/fax", async (context) => {
    return handleSignalWireWebhook(context, "outbound");
  });

  app.get("/provider-content/:token", async (context) => {
    const dependencies = context.get("dependencies");
    const tokenHash = await sha256Hex(context.req.param("token"));
    const token = await dependencies.repository.getActiveContentToken(
      tokenHash,
      dependencies.clock.now().toISOString(),
    );
    if (!token) throw new NotFoundError("Provider content", "token");
    const metadata = await dependencies.repository.getDocument(token.documentId);
    if (!metadata || metadata.faxJobId !== token.faxJobId) {
      throw new NotFoundError("Provider document", token.documentId);
    }
    const object = await dependencies.documents.get(metadata.objectKey);
    if (!object) throw new NotFoundError("Stored document", metadata.id);
    return new Response(object.body, {
      headers: {
        "Content-Type": metadata.mimeType,
        "Content-Length": String(object.size),
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  });

  app.onError((error, context) => {
    const correlationId = context.get("correlationId") ?? crypto.randomUUID();
    console.error(
      JSON.stringify({
        event: "http.request_failed",
        correlationId,
        method: context.req.method,
        path: new URL(context.req.url).pathname,
        error: error instanceof Error ? { name: error.name, message: error.message } : { message: "Unknown error" },
      }),
    );
    if (error instanceof WebhookAuthError) {
      return Response.json({ error: { code: "invalid_webhook_auth", correlationId } }, { status: 401 });
    }
    return problemResponse(error, correlationId);
  });

  async function handleSignalWireWebhook(
    context: Context<AppEnvironment>,
    direction: "inbound" | "outbound",
  ) {
    const dependencies = context.get("dependencies");
    if (!dependencies.config.webhook) throw new NotFoundError("Webhook", "signalwire");
    try {
      const event = await parseSignalWireFaxWebhook(
        context.req.raw,
        dependencies.config.webhook,
        direction,
      );
      const result = await dependencies.webhook.handleProviderEvent(event);
      const timestamp = dependencies.clock.now().toISOString();
      await dependencies.repository.setSetting("lastAuthenticatedWebhook", timestamp, timestamp);
      return context.json({ accepted: true, duplicate: result.duplicate }, 202);
    } catch (error) {
      if (error instanceof WebhookAuthError) {
        const timestamp = dependencies.clock.now().toISOString();
        await dependencies.repository.setSetting("lastRejectedWebhook", timestamp, timestamp);
      }
      throw error;
    }
  }

  function authenticatedWebhookUrl(
    webhook: { baseUrl: string; username: string; password: string },
    path: string,
  ): string {
    const url = new URL(path, webhook.baseUrl);
    url.username = webhook.username;
    url.password = webhook.password;
    return url.toString();
  }

  app.notFound((context) => problemResponse(new NotFoundError("Route", new URL(context.req.url).pathname), context.get("correlationId")));
  return app;
}

async function defaultDependencies(env: WorkerEnv): Promise<HttpDependencies> {
  const services = createServiceContainer(env);
  return {
    ...services,
    auth: new AccessAuthenticator(services.config.auth),
    clock: systemClock,
    startNumberWorkflow: async (params) => {
      const instance = await env.NUMBER_LIFECYCLE_WORKFLOW.create({
        id: `number-${params.numberId}`,
        params,
        retention: { successRetention: "30 days", errorRetention: "30 days" },
      });
      return instance.id;
    },
    startOutboundWorkflow: async (params) => {
      const instance = await env.OUTBOUND_FAX_WORKFLOW.create({
        id: `outbound-${params.faxJobId}`,
        params,
        retention: { successRetention: "30 days", errorRetention: "30 days" },
      });
      return instance.id;
    },
  };
}

async function getPreferences(dependencies: HttpDependencies) {
  const stored = await dependencies.repository.getSetting<Partial<z.infer<typeof preferencesSchema>>>("preferences");
  return {
    defaultForwardEmail: stored?.defaultForwardEmail ?? dependencies.config.defaultForwardEmail,
    preferredAreaCodes: stored?.preferredAreaCodes ?? dependencies.config.preferredAreaCodes,
    defaultTtlDays: stored?.defaultTtlDays ?? dependencies.config.defaultTtlDays,
    defaultRentalMonths: stored?.defaultRentalMonths ?? dependencies.config.defaultRentalMonths,
    householdLineId: stored?.householdLineId ?? null,
  };
}

function safeIdentifier(value: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new ConflictError("Invalid resource identifier.");
  return value;
}

function sanitizeFilename(value: string): string {
  const sanitized = value.replace(/[^A-Za-z0-9._ -]/g, "_").slice(0, 180).trim();
  return sanitized || "document";
}

function validateDocumentStream(
  body: ReadableStream<Uint8Array>,
  mimeType: string,
  maxBytes: number,
  expectedBytes: number,
) {
  const supported = ["application/pdf", "image/jpeg", "image/png"];
  if (!supported.includes(mimeType)) throw new ConflictError("Only PDF, JPEG, and PNG documents are supported.");
  const [probe, storageBody] = body.tee();
  const validation = (async () => {
    const reader = probe.getReader();
    const prefix = new Uint8Array(8);
    let offset = 0;
    let byteCount = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteCount += value.byteLength;
      if (byteCount > maxBytes) {
        await reader.cancel();
        throw new ConflictError(`Documents must be smaller than ${maxBytes} bytes.`);
      }
      if (offset < prefix.length) {
        const length = Math.min(value.byteLength, prefix.length - offset);
        prefix.set(value.subarray(0, length), offset);
        offset += length;
      }
    }
    const valid =
      (mimeType === "application/pdf" && new TextDecoder().decode(prefix.subarray(0, 5)) === "%PDF-") ||
      (mimeType === "image/jpeg" && prefix[0] === 0xff && prefix[1] === 0xd8 && prefix[2] === 0xff) ||
      (mimeType === "image/png" && prefix.slice(0, 8).every((value, index) => value === [137, 80, 78, 71, 13, 10, 26, 10][index]));
    if (!valid) throw new ConflictError("The document signature does not match its file type.");
    if (byteCount !== expectedBytes) {
      throw new ConflictError("The uploaded document size did not match its declared size.");
    }
  })();
  return { storageBody, validation };
}

function streamDocument(body: ReadableStream, mimeType: string, displayName: string, size: number) {
  return new Response(body, {
    headers: {
      "Content-Type": mimeType,
      "Content-Length": String(size),
      "Content-Disposition": `attachment; filename="${sanitizeFilename(displayName).replaceAll('"', "")}"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
