import { describe, expect, it, vi } from "vitest";

import { CloudflareFaxEmailNotifier } from "../server/notifications/fax-email";
import type {
  FaxEmailNotification,
  FaxEmailNotifier,
} from "../server/notifications/fax-email";
import type { WorkerEnv } from "./env";
import { createServiceContainer } from "./services";

describe("createServiceContainer", () => {
  it("wires SignalWire fax confirmations into the notification service", () => {
    const email = { send: vi.fn() };

    const services = createServiceContainer(signalWireEnv(email));
    const notificationDependencies = services.notifications as unknown as {
      dependencies: { notifier: FaxEmailNotifier | null };
    };

    expect(notificationDependencies.dependencies.notifier).toBeInstanceOf(
      CloudflareFaxEmailNotifier,
    );
  });

  it("requires the Cloudflare email binding for SignalWire", () => {
    expect(() => createServiceContainer(signalWireEnv())).toThrow(/email send binding/i);
  });

  it("applies the configured email attachment limit", async () => {
    const email = { send: vi.fn().mockResolvedValue({ messageId: "message-1" }) };
    const services = createServiceContainer({
      ...signalWireEnv(email),
      MAX_EMAIL_ATTACHMENT_BYTES: "1234",
    });
    const notificationDependencies = services.notifications as unknown as {
      dependencies: { notifier: FaxEmailNotifier };
    };

    await notificationDependencies.dependencies.notifier.send(notification({
      bytes: new ArrayBuffer(1235),
    }));

    expect(email.send).toHaveBeenCalledWith(expect.objectContaining({ attachments: [] }));
  });
});

function signalWireEnv(email?: { send: ReturnType<typeof vi.fn> }): WorkerEnv {
  return {
    DB: {} as D1Database,
    DOCUMENTS: {} as R2Bucket,
    OUTBOUND_FAX_WORKFLOW: {} as Workflow,
    NUMBER_LIFECYCLE_WORKFLOW: {} as Workflow,
    ...(email ? { EMAIL: email as unknown as SendEmail } : {}),
    APP_NAME: "Family Fax",
    APP_VERSION: "0.1.0",
    AUTH_MODE: "dev",
    FAX_PROVIDER: "signalwire",
    DEFAULT_FORWARD_EMAIL: "fax@example.com",
    PREFERRED_AREA_CODES: "615,629",
    DEFAULT_TTL_DAYS: "3",
    TTL_PRESETS: "1,3,7,14",
    MAX_TTL_DAYS: "365",
    DEFAULT_RENTAL_MONTHS: "1",
    RENTAL_MONTH_PRESETS: "1,2,3",
    MAX_RENTAL_MONTHS: "12",
    DEFAULT_RETENTION: "forever",
    LOG_DETAIL: "full",
    MAX_UPLOAD_BYTES: "26214400",
    MAX_FAX_PAGES: "100",
    APP_BASE_URL: "https://fax.example.com",
    WEBHOOK_BASE_URL: "https://fax-events.example.com",
    WEBHOOK_USERNAME: "webhook-user",
    WEBHOOK_PASSWORD: "webhook-password",
    SIGNALWIRE_PROJECT_ID: "project-id",
    SIGNALWIRE_API_TOKEN: "api-token",
    SIGNALWIRE_SPACE_URL: "family.signalwire.com",
    SIGNALWIRE_LOCAL_NUMBER_MONTHLY_PRICE: "0.50",
    SIGNALWIRE_ACCOUNT_MODE: "trial",
    EMAIL_FROM_ADDRESS: "fax@example.com",
  };
}

function notification(overrides: Partial<FaxEmailNotification> = {}): FaxEmailNotification {
  return {
    kind: "outbound_delivered",
    faxJobId: "fax-1",
    attempt: 1,
    destinationEmail: "family@example.com",
    fromNumber: "+16155550199",
    toNumber: "+16155550123",
    occurredAt: "2026-08-18T03:47:05.000Z",
    pageCount: 2,
    providerName: "signalwire",
    providerFaxId: "provider-fax-1",
    providerResult: "delivered",
    filename: "fax-packet.pdf",
    mimeType: "application/pdf",
    bytes: new ArrayBuffer(20),
    ...overrides,
  };
}
