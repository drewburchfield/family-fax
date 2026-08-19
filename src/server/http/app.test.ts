import { describe, expect, it, vi } from "vitest";

import { FixedClock } from "../../domain/clock";
import { parseRuntimeConfig } from "../../domain/config";
import { DemoFaxProvider } from "../../providers/demo-fax-provider";
import { MemoryRepository } from "../repositories/memory-repository";
import { AccessAuthenticator } from "../auth/access";
import { AuditService } from "../services/audit-service";
import { DiagnosticsService } from "../services/diagnostics-service";
import { FaxTerminalService } from "../services/fax-terminal-service";
import { FaxService } from "../services/fax-service";
import { NotificationService } from "../services/notification-service";
import { NumberService } from "../services/number-service";
import { DemoFaxEmailNotifier } from "../notifications/fax-email";
import { WebhookService } from "../services/webhook-service";
import { MemoryDocumentStore } from "../storage/document-store";
import { createApp, type HttpDependencies } from "./app";

const baseUrl = "https://fax.example.com";
const mutationHeaders = {
  Origin: baseUrl,
  "X-Family-Fax-Request": "1",
  "Content-Type": "application/json",
};

describe("Family Fax HTTP API", () => {
  it("defaults the household line preference to null in bootstrap", async () => {
    const app = createApp(async () => createDependencies());

    const response = await app.request(`${baseUrl}/api/bootstrap`, {}, {});

    expect(response.status).toBe(200);
    expect((await response.json()) as { config: { householdLineId: string | null } }).toMatchObject({
      config: { householdLineId: null },
    });
  });

  it("persists the selected household line with the other household preferences", async () => {
    const dependencies = createDependencies();
    const app = createApp(async () => dependencies);

    const response = await app.request(
      `${baseUrl}/api/settings`,
      {
        method: "PUT",
        headers: mutationHeaders,
        body: JSON.stringify({
          defaultForwardEmail: "family@example.com",
          preferredAreaCodes: ["615"],
          defaultRentalMonths: 1,
          householdLineId: "family-line",
        }),
      },
      {},
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ householdLineId: "family-line" });
    expect(await dependencies.repository.getSetting("preferences")).toMatchObject({
      householdLineId: "family-line",
    });
  });

  it("cancels an incomplete fax through the authenticated API", async () => {
    const dependencies = createDependencies();
    const app = createApp(async () => dependencies);
    const job = await dependencies.fax.createDraft({
      mode: "receive-only",
      toNumber: null,
      requestedTtlDays: 3,
      coverData: null,
    });

    const response = await app.request(
      `${baseUrl}/api/faxes/${job.id}/cancel`,
      {
        method: "POST",
        headers: mutationHeaders,
        body: JSON.stringify({ reason: "Number search failed." }),
      },
      {},
    );

    expect(response.status).toBe(200);
    expect((await response.json()) as { state: string }).toMatchObject({ state: "canceled" });
  });

  it("retries fax email only through an explicit confirmed mutation", async () => {
    const dependencies = createDependencies();
    const retry = vi.spyOn(dependencies.notifications, "retry").mockResolvedValue({
      faxJobId: "inbound-1",
      kind: "inbound_received",
      state: "delivered",
      destinationEmail: "fax@example.com",
      attempt: 2,
      messageId: "message-2",
      attached: true,
      lastError: null,
      createdAt: "2026-08-16T12:00:00.000Z",
      updatedAt: "2026-08-16T12:00:00.000Z",
      deliveredAt: "2026-08-16T12:00:00.000Z",
    });
    const app = createApp(async () => dependencies);

    const response = await app.request(
      `${baseUrl}/api/faxes/inbound-1/retry-email`,
      {
        method: "POST",
        headers: mutationHeaders,
        body: JSON.stringify({ confirmed: true }),
      },
      {},
    );

    expect(response.status).toBe(200);
    expect(retry).toHaveBeenCalledWith("inbound-1");
  });

  it("rejects receive durations beyond the configured maximum", async () => {
    const app = createApp(async () => createDependencies());
    const response = await app.request(
      `${baseUrl}/api/faxes`,
      {
        method: "POST",
        headers: mutationHeaders,
        body: JSON.stringify({
          mode: "receive-only",
          toNumber: null,
          requestedTtlDays: 366,
          coverData: null,
        }),
      },
      {},
    );

    expect(response.status).toBe(409);
    expect(await response.text()).toContain("cannot exceed 365 days");
  });

  it("supports the confirmed draft, upload, quote, and number-start sequence", async () => {
    const dependencies = createDependencies();
    const app = createApp(async () => dependencies);
    const bootstrap = await app.request(`${baseUrl}/api/bootstrap`, {}, {});
    expect(bootstrap.status).toBe(200);
    expect(((await bootstrap.json()) as { config: { isDemo: boolean } }).config.isDemo).toBe(true);

    const draftResponse = await app.request(
      `${baseUrl}/api/faxes`,
      {
        method: "POST",
        headers: mutationHeaders,
        body: JSON.stringify({
          mode: "send-only",
          toNumber: "+16155550123",
          requestedTtlDays: null,
          coverData: null,
        }),
      },
      {},
    );
    expect(draftResponse.status).toBe(201);
    const draft = (await draftResponse.json()) as { id: string };

    const bytes = new TextEncoder().encode("%PDF-1.7 demo");
    const upload = await app.request(
      `${baseUrl}/api/faxes/${draft.id}/documents/final-document`,
      {
        method: "PUT",
        headers: {
          Origin: baseUrl,
          "X-Family-Fax-Request": "1",
          "Content-Type": "application/pdf",
          "Content-Length": String(bytes.byteLength),
          "X-Document-Kind": "final-packet",
          "X-Document-Sha256": "browser-sha256",
          "X-Document-Name": "packet.pdf",
          "X-Document-Pages": "1",
        },
        body: bytes,
      },
      {},
    );
    expect(upload.status).toBe(201);

    const prepared = await app.request(
      `${baseUrl}/api/faxes/${draft.id}/prepare`,
      {
        method: "POST",
        headers: mutationHeaders,
        body: JSON.stringify({ finalDocumentId: "final-document", pageCount: 1 }),
      },
      {},
    );
    expect(prepared.status).toBe(200);

    const search = await app.request(
      `${baseUrl}/api/numbers/search`,
      {
        method: "POST",
        headers: mutationHeaders,
        body: JSON.stringify({ areaCodes: ["615"] }),
      },
      {},
    );
    const candidate = (await search.json() as { candidates: unknown[] }).candidates[0];
    const start = await app.request(
      `${baseUrl}/api/faxes/${draft.id}/start`,
      {
        method: "POST",
        headers: mutationHeaders,
        body: JSON.stringify({ candidate, forwardingEmail: "fax@example.com", confirmed: true }),
      },
      {},
    );
    expect(start.status).toBe(202);
    const started = (await start.json()) as { number: { id: string; workflowId: string } };
    expect(started.number.workflowId).toBe("workflow-1");
    const number = await app.request(`${baseUrl}/api/numbers/${started.number.id}`, {}, {});
    expect(number.status).toBe(200);
    expect(((await number.json()) as { id: string }).id).toBe(started.number.id);
    expect(dependencies.startNumberWorkflow).toHaveBeenCalledOnce();
  });

  it("rejects an upload whose streamed bytes do not match its declared size", async () => {
    const dependencies = createDependencies();
    const app = createApp(async () => dependencies);
    const job = await dependencies.fax.createDraft({
      mode: "send-only",
      toNumber: "+16155550123",
      requestedTtlDays: null,
      coverData: null,
    });
    const bytes = new TextEncoder().encode("%PDF-1.7 extra data");

    const response = await app.request(
      `${baseUrl}/api/faxes/${job.id}/documents/mismatched-document`,
      {
        method: "PUT",
        headers: {
          Origin: baseUrl,
          "X-Family-Fax-Request": "1",
          "Content-Type": "application/pdf",
          "Content-Length": String(bytes.byteLength - 1),
          "X-Document-Kind": "original",
          "X-Document-Sha256": "browser-sha256",
          "X-Document-Name": "packet.pdf",
          "X-Document-Pages": "1",
        },
        body: bytes,
      },
      {},
    );

    expect(response.status).toBe(409);
    expect(await response.text()).toContain("did not match its declared size");
    expect(await dependencies.repository.listDocumentsForFax(job.id)).toHaveLength(0);
  });

  it("requires explicit confirmation before provisioning", async () => {
    const dependencies = createDependencies();
    const app = createApp(async () => dependencies);
    const fax = await dependencies.fax.createDraft({
      mode: "receive-only",
      toNumber: null,
      requestedTtlDays: 3,
      coverData: null,
    });
    await dependencies.fax.prepare(fax.id, null, null);
    const candidate = (await dependencies.numbers.search(["615"], 1))[0];

    const response = await app.request(
      `${baseUrl}/api/faxes/${fax.id}/start`,
      {
        method: "POST",
        headers: mutationHeaders,
        body: JSON.stringify({ candidate, forwardingEmail: "fax@example.com", confirmed: false }),
      },
      {},
    );

    expect(response.status).toBe(409);
    expect(dependencies.startNumberWorkflow).not.toHaveBeenCalled();
  });

  it("accepts a confirmed fallback-area quote when rechecking its demo price", async () => {
    const dependencies = createDependencies();
    const app = createApp(async () => dependencies);
    const fax = await dependencies.fax.createDraft({
      mode: "receive-only",
      toNumber: null,
      requestedTtlDays: 3,
      coverData: null,
    });
    await dependencies.fax.prepare(fax.id, null, null);
    const candidates = await dependencies.numbers.search(["615", "629"], 1);
    const fallback = candidates.find((candidate) => candidate.areaCode === "629");

    const response = await app.request(
      `${baseUrl}/api/faxes/${fax.id}/start`,
      {
        method: "POST",
        headers: mutationHeaders,
        body: JSON.stringify({ candidate: fallback, forwardingEmail: "fax@example.com", confirmed: true }),
      },
      {},
    );

    expect(response.status).toBe(202);
    expect((await response.json()) as { number: { areaCode: string; monthlyPrice: { amount: string } } }).toMatchObject({
      number: { areaCode: "629", monthlyPrice: { amount: "2.00" } },
    });
  });

  it("keeps a reserved request recoverable when workflow creation is ambiguous", async () => {
    const dependencies = createDependencies();
    dependencies.startNumberWorkflow.mockRejectedValue(new Error("workflow unavailable"));
    const app = createApp(async () => dependencies);
    const fax = await dependencies.fax.createDraft({
      mode: "receive-only",
      toNumber: null,
      requestedTtlDays: 3,
      coverData: null,
    });
    await dependencies.fax.prepare(fax.id, null, null);
    const candidate = (await dependencies.numbers.search(["615"], 1))[0];

    const response = await app.request(
      `${baseUrl}/api/faxes/${fax.id}/start`,
      {
        method: "POST",
        headers: mutationHeaders,
        body: JSON.stringify({ candidate, forwardingEmail: "fax@example.com", confirmed: true }),
      },
      {},
    );

    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ workflowStartUnknown: true });
    expect(await dependencies.repository.getFaxJob(fax.id)).toMatchObject({
      state: "provisioning",
    });
    expect((await dependencies.repository.listActiveNumbers()).length).toBe(1);
  });

  it("returns the started workflow when post-start audit bookkeeping fails", async () => {
    const dependencies = createDependencies();
    const app = createApp(async () => dependencies);
    const fax = await dependencies.fax.createDraft({
      mode: "receive-only",
      toNumber: null,
      requestedTtlDays: 3,
      coverData: null,
    });
    await dependencies.fax.prepare(fax.id, null, null);
    const candidate = (await dependencies.numbers.search(["615"], 1))[0];
    const originalAppendEvent = dependencies.repository.appendEvent.bind(dependencies.repository);
    const appendEvent = vi.spyOn(dependencies.repository, "appendEvent");
    appendEvent
      .mockImplementationOnce(originalAppendEvent)
      .mockRejectedValueOnce(new Error("audit database unavailable"));

    const response = await app.request(
      `${baseUrl}/api/faxes/${fax.id}/start`,
      {
        method: "POST",
        headers: mutationHeaders,
        body: JSON.stringify({ candidate, forwardingEmail: "fax@example.com", confirmed: true }),
      },
      {},
    );

    expect(response.status).toBe(202);
    expect((await response.json()) as { number: { workflowId: string } }).toMatchObject({
      number: { workflowId: "workflow-1" },
    });
  });

  it("does not quote a number that is already active in this deployment", async () => {
    const dependencies = createDependencies();
    const app = createApp(async () => dependencies);
    const fax = await dependencies.fax.createDraft({
      mode: "receive-only",
      toNumber: null,
      requestedTtlDays: 3,
      coverData: null,
    });
    await dependencies.fax.prepare(fax.id, null, null);
    const first = (await dependencies.numbers.search(["615"], 1))[0]!;
    const requested = await dependencies.numbers.requestNumber(fax.id, first, "fax@example.com");
    await dependencies.numbers.provisionNumber(requested.id, first);

    const response = await app.request(
      `${baseUrl}/api/numbers/search`,
      {
        method: "POST",
        headers: mutationHeaders,
        body: JSON.stringify({ areaCodes: ["615"] }),
      },
      {},
    );
    const payload = (await response.json()) as { candidates: Array<{ e164: string }> };

    expect(payload.candidates.some((candidate) => candidate.e164 === first.e164)).toBe(false);
  });

  it("requires renewed confirmation if the configured estimate changed", async () => {
    const dependencies = createDependencies();
    const app = createApp(async () => dependencies);
    const fax = await dependencies.fax.createDraft({
      mode: "receive-only",
      toNumber: null,
      requestedTtlDays: 3,
      coverData: null,
    });
    await dependencies.fax.prepare(fax.id, null, null);
    const candidate = (await dependencies.numbers.search(["615"], 1))[0]!;

    const response = await app.request(
      `${baseUrl}/api/faxes/${fax.id}/start`,
      {
        method: "POST",
        headers: mutationHeaders,
        body: JSON.stringify({
          candidate: { ...candidate, monthlyPrice: { amount: "0.01", currency: "USD" } },
          forwardingEmail: "fax@example.com",
          confirmed: true,
        }),
      },
      {},
    );

    expect(response.status).toBe(409);
    expect(dependencies.startNumberWorkflow).not.toHaveBeenCalled();
  });

  it("stores preferences and templates and serves authorized diagnostic data", async () => {
    const dependencies = createDependencies();
    const app = createApp(async () => dependencies);
    const settings = await app.request(
      `${baseUrl}/api/settings`,
      {
        method: "PUT",
        headers: mutationHeaders,
        body: JSON.stringify({
          defaultForwardEmail: "new@example.com",
          preferredAreaCodes: ["629", "615"],
          defaultTtlDays: 7,
          defaultRentalMonths: 2,
        }),
      },
      {},
    );
    expect(settings.status).toBe(200);

    const template = await app.request(
      `${baseUrl}/api/templates`,
      {
        method: "POST",
        headers: mutationHeaders,
        body: JSON.stringify({
          id: "default-cover",
          name: "Family cover",
          isDefault: true,
          data: {
            recipient: "",
            sender: "The Family",
            subject: "",
            callbackNumber: "",
            note: "Please call with questions.",
            enabled: true,
          },
        }),
      },
      {},
    );
    expect(template.status).toBe(201);

    const diagnostics = await app.request(`${baseUrl}/api/diagnostics`, {}, {});
    expect(diagnostics.status).toBe(200);
    expect(await diagnostics.json()).toMatchObject({
      database: { ok: true },
      activeWorkflowCount: 0,
      overdueNumberCount: 0,
      lateFaxUpdateCount: 0,
      recentProvisioningFailures: 0,
      emailDeliveryFailures: 0,
      emailDeliveryUnknown: 0,
      staleEmailDeliveries: 0,
    });
    const health = await app.request(`${baseUrl}/api/health`, {}, {});
    expect(health.status).toBe(200);
    expect(((await health.json()) as { application: { version: string } }).application.version).toBe("development");
    expect((await app.request(`${baseUrl}/api/templates`, {}, {})).status).toBe(200);
  });

  it("streams only active provider content tokens", async () => {
    const dependencies = createDependencies();
    const app = createApp(async () => dependencies);
    const job = await dependencies.fax.createDraft({
      mode: "send-only",
      toNumber: "+16155550123",
      requestedTtlDays: null,
      coverData: null,
    });
    const content = new TextEncoder().encode("private fax");
    await dependencies.documents.put(`faxes/${job.id}/final.pdf`, content, {
      contentType: "application/pdf",
      sha256: "sha",
      uploadedAt: dependencies.clock.now().toISOString(),
    });
    await dependencies.fax.registerDocument(job.id, {
      id: "doc-1",
      kind: "final-packet",
      objectKey: `faxes/${job.id}/final.pdf`,
      mimeType: "application/pdf",
      byteCount: content.byteLength,
      pageCount: 1,
      sha256: "sha",
      displayName: "final.pdf",
    });
    await dependencies.fax.prepare(job.id, "doc-1", 1);
    await dependencies.repository.updateFaxJob(job.id, {
      state: "submitting",
      updatedAt: dependencies.clock.now().toISOString(),
    });
    const { token } = await dependencies.fax.createProviderContentToken(job.id, baseUrl);

    const response = await app.request(`${baseUrl}/provider-content/${token}`, {}, {});

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("private fax");
    expect((await app.request(`${baseUrl}/provider-content/not-valid`, {}, {})).status).toBe(404);
  });

  it("returns SignalWire receive instructions with an authenticated callback", async () => {
    const dependencies = createDependencies();
    dependencies.config = signalWireConfig();
    const app = createApp(async () => dependencies);
    const response = await app.request(
      `${baseUrl}/webhooks/signalwire/incoming`,
      { method: "POST", headers: signalWireWebhookHeaders() },
      {},
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("application/xml");
    expect(await response.text()).toContain(
      "https://webhook-user:webhook-password@fax.example.com/webhooks/signalwire/inbound",
    );
  });

  it("normalizes authenticated SignalWire fax callbacks", async () => {
    const dependencies = createDependencies();
    dependencies.config = signalWireConfig();
    const handle = vi
      .spyOn(dependencies.webhook, "handleProviderEvent")
      .mockResolvedValue({ duplicate: false, faxJobId: "fax-1" });
    const app = createApp(async () => dependencies);
    const response = await app.request(
      `${baseUrl}/webhooks/signalwire/fax`,
      {
        method: "POST",
        headers: {
          ...signalWireWebhookHeaders(),
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          FaxSid: "fax-1",
          FaxStatus: "delivered",
          From: "+16155550199",
          To: "+16155550123",
          NumPages: "2",
        }),
      },
      {},
    );

    expect(response.status).toBe(202);
    expect(handle).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "signalwire", type: "status" }),
    );
  });

  it("rejects unauthenticated SignalWire webhooks", async () => {
    const dependencies = createDependencies();
    dependencies.config = signalWireConfig();
    const app = createApp(async () => dependencies);
    const response = await app.request(
      `${baseUrl}/webhooks/signalwire/incoming`,
      { method: "POST" },
      {},
    );

    expect(response.status).toBe(401);
    expect(await dependencies.repository.getSetting("lastRejectedWebhook")).not.toBeNull();
  });

  it("stops before document registration when storage fails", async () => {
    const dependencies = createDependencies();
    const app = createApp(async () => dependencies);
    const job = await dependencies.fax.createDraft({
      mode: "send-only",
      toNumber: "+16155550123",
      requestedTtlDays: null,
      coverData: null,
    });
    vi.spyOn(dependencies.documents, "put").mockRejectedValueOnce(new Error("R2 unavailable"));
    const bytes = new TextEncoder().encode("%PDF-1.7 demo");

    const response = await app.request(
      `${baseUrl}/api/faxes/${job.id}/documents/document-failure`,
      {
        method: "PUT",
        headers: {
          Origin: baseUrl,
          "X-Family-Fax-Request": "1",
          "Content-Type": "application/pdf",
          "Content-Length": String(bytes.byteLength),
          "X-Document-Kind": "final-packet",
          "X-Document-Sha256": "browser-sha256",
          "X-Document-Name": "packet.pdf",
          "X-Document-Pages": "1",
        },
        body: bytes,
      },
      {},
    );

    expect(response.status).toBe(500);
    expect(await dependencies.repository.listDocumentsForFax(job.id)).toEqual([]);
    expect((await dependencies.repository.getFaxJob(job.id))?.state).toBe("draft");
  });

  it("preserves an existing document when a replacement upload fails validation", async () => {
    const dependencies = createDependencies();
    const app = createApp(async () => dependencies);
    const job = await dependencies.fax.createDraft({
      mode: "send-only",
      toNumber: "+16155550123",
      requestedTtlDays: null,
      coverData: null,
    });
    const existingKey = `faxes/${job.id}/document-existing-original.pdf`;
    const existingBytes = new TextEncoder().encode("%PDF-1.7 original");
    await dependencies.documents.put(existingKey, existingBytes, {
      contentType: "application/pdf",
      sha256: "existing-sha256",
      uploadedAt: "2026-08-16T12:00:00.000Z",
    });
    await dependencies.fax.registerDocument(job.id, {
      id: "document-existing",
      kind: "final-packet",
      objectKey: existingKey,
      mimeType: "application/pdf",
      byteCount: existingBytes.byteLength,
      pageCount: 1,
      sha256: "existing-sha256",
      displayName: "original.pdf",
    });
    const invalidBytes = new TextEncoder().encode("not a PDF");

    const response = await app.request(
      `${baseUrl}/api/faxes/${job.id}/documents/document-existing`,
      {
        method: "PUT",
        headers: {
          Origin: baseUrl,
          "X-Family-Fax-Request": "1",
          "Content-Type": "application/pdf",
          "Content-Length": String(invalidBytes.byteLength),
          "X-Document-Kind": "final-packet",
          "X-Document-Sha256": "replacement-sha256",
          "X-Document-Name": "replacement.pdf",
          "X-Document-Pages": "1",
        },
        body: invalidBytes,
      },
      {},
    );

    expect(response.status).toBe(409);
    expect(await dependencies.documents.get(existingKey)).not.toBeNull();
    expect(await dependencies.repository.getDocument("document-existing")).toMatchObject({
      objectKey: existingKey,
      sha256: "existing-sha256",
    });
  });

  it("blocks cross-origin API mutations", async () => {
    const app = createApp(async () => createDependencies());
    const response = await app.request(
      `${baseUrl}/api/faxes`,
      {
        method: "POST",
        headers: { ...mutationHeaders, Origin: "https://malicious.example.com" },
        body: "{}",
      },
      {},
    );

    expect(response.status).toBe(403);
  });
});

function createDependencies() {
  const clock = new FixedClock(new Date("2026-08-16T12:00:00.000Z"));
  const config = parseRuntimeConfig({
    APP_NAME: "Family Fax",
    AUTH_MODE: "dev",
    FAX_PROVIDER: "demo",
    DEFAULT_FORWARD_EMAIL: "fax@example.com",
    PREFERRED_AREA_CODES: "615,629",
    DEFAULT_TTL_DAYS: "3",
    TTL_PRESETS: "1,3,7,14",
    MAX_TTL_DAYS: "365",
    DEFAULT_RETENTION: "forever",
    LOG_DETAIL: "full",
    MAX_UPLOAD_BYTES: "26214400",
    MAX_FAX_PAGES: "100",
  });
  const provider = new DemoFaxProvider();
  const repository = new MemoryRepository();
  const documents = new MemoryDocumentStore();
  const audit = new AuditService(repository, documents, clock);
  const fax = new FaxService({
    repository,
    documents,
    audit,
    provider,
    clock,
    defaultPhoneCountry: "US",
  });
  const numbers = new NumberService({ repository, audit, provider, clock, maxTtlDays: 365 });
  const notifications = new NotificationService({
    repository,
    documents,
    audit,
    notifier: new DemoFaxEmailNotifier(),
    providerName: provider.name,
    defaultDestinationEmail: config.defaultForwardEmail,
    clock,
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
    clock,
  });
  return {
    config,
    provider,
    repository,
    documents,
    audit,
    fax,
    numbers,
    notifications,
    terminal,
    webhook,
    diagnostics: new DiagnosticsService(repository, provider, documents),
    auth: new AccessAuthenticator(config.auth, { allowRemoteDevelopment: true }),
    clock,
    startNumberWorkflow: vi.fn().mockResolvedValue("workflow-1"),
    startOutboundWorkflow: vi.fn().mockResolvedValue("outbound-workflow-1"),
  } satisfies HttpDependencies;
}

function signalWireConfig() {
  return parseRuntimeConfig({
    APP_NAME: "Family Fax",
    AUTH_MODE: "dev",
    FAX_PROVIDER: "signalwire",
    DEFAULT_FORWARD_EMAIL: "fax@example.com",
    PREFERRED_AREA_CODES: "615,629",
    DEFAULT_TTL_DAYS: "3",
    TTL_PRESETS: "1,3,7,14",
    MAX_TTL_DAYS: "365",
    DEFAULT_RETENTION: "forever",
    LOG_DETAIL: "full",
    MAX_UPLOAD_BYTES: "26214400",
    MAX_FAX_PAGES: "100",
    APP_BASE_URL: baseUrl,
    WEBHOOK_BASE_URL: baseUrl,
    WEBHOOK_USERNAME: "webhook-user",
    WEBHOOK_PASSWORD: "webhook-password",
    SIGNALWIRE_PROJECT_ID: "project-id",
    SIGNALWIRE_API_TOKEN: "api-token",
    SIGNALWIRE_SPACE_URL: "family-fax.signalwire.com",
    SIGNALWIRE_LOCAL_NUMBER_MONTHLY_PRICE: "0.50",
    EMAIL_FROM_ADDRESS: "fax@example.com",
  });
}

function signalWireWebhookHeaders() {
  return { Authorization: `Basic ${btoa("webhook-user:webhook-password")}` };
}
