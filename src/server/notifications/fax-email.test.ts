import { describe, expect, it, vi } from "vitest";

import {
  CloudflareFaxEmailNotifier,
  DemoFaxEmailNotifier,
  type FaxEmailNotification,
} from "./fax-email";

describe("CloudflareFaxEmailNotifier", () => {
  it("attaches the exact outbound packet and reports provider facts", async () => {
    const email = { send: vi.fn().mockResolvedValue({ messageId: "message-1" }) };
    const notifier = createNotifier(email);

    await notifier.send(notification({ kind: "outbound_delivered" }));

    expect(email.send).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: "Fax delivered to +16155550123",
        text: expect.stringMatching(
          /Provider: SignalWire[\s\S]*Provider result: delivered[\s\S]*Provider fax ID: provider-fax-1/,
        ),
        attachments: [expect.objectContaining({ filename: "fax-packet.pdf" })],
      }),
    );
  });

  it("renders inbound facts and attaches the received PDF", async () => {
    const email = { send: vi.fn().mockResolvedValue({ messageId: "message-2" }) };
    const notifier = createNotifier(email);

    await notifier.send(
      notification({
        kind: "inbound_received",
        fromNumber: "+12025550123",
        filename: "fax-from-+12025550123.pdf",
      }),
    );

    expect(email.send).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: "Fax received from +12025550123",
        attachments: [expect.objectContaining({ filename: "fax-from-+12025550123.pdf" })],
      }),
    );
  });

  it("uses the private activity link when the attachment is too large", async () => {
    const email = { send: vi.fn().mockResolvedValue({ messageId: "message-3" }) };
    const notifier = new CloudflareFaxEmailNotifier(email, {
      fromAddress: "fax@example.com",
      appBaseUrl: "https://fax.example.com",
      maxAttachmentBytes: 1,
    });

    const result = await notifier.send(notification());

    expect(result).toEqual({ messageId: "message-3", attached: false });
    expect(email.send).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("https://fax.example.com/activity/fax-1"),
        attachments: [],
      }),
    );
  });
});

describe("DemoFaxEmailNotifier", () => {
  it("fails the first 0002 delivery attempt and accepts the explicit retry", async () => {
    const notifier = new DemoFaxEmailNotifier();
    const simulatedFailure = notification({ toNumber: "+16155550002" });

    await expect(notifier.send(simulatedFailure)).rejects.toThrow(/first attempt/i);
    await expect(notifier.send({ ...simulatedFailure, attempt: 2 })).resolves.toMatchObject({
      attached: true,
    });
  });
});

function createNotifier(email: {
  send(message: EmailMessageBuilder): Promise<EmailSendResult>;
}) {
  return new CloudflareFaxEmailNotifier(email, {
    fromAddress: "fax@example.com",
    appBaseUrl: "https://fax.example.com",
    maxAttachmentBytes: 18_000_000,
  });
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
