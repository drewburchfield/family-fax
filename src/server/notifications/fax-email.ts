/// <reference types="@cloudflare/workers-types" />

import type { FaxNotificationKind } from "../../shared/contracts";

export interface FaxEmailNotification {
  kind: FaxNotificationKind;
  faxJobId: string;
  attempt: number;
  destinationEmail: string;
  fromNumber: string;
  toNumber: string;
  occurredAt: string;
  pageCount: number | null;
  providerName: string;
  providerFaxId: string | null;
  providerResult: string;
  filename: string;
  mimeType: string;
  bytes: ArrayBuffer;
}

export interface FaxEmailNotificationResult {
  messageId: string;
  attached: boolean;
}

export interface FaxEmailNotifier {
  send(input: FaxEmailNotification): Promise<FaxEmailNotificationResult>;
}

export class DemoFaxEmailNotifier implements FaxEmailNotifier {
  async send(input: FaxEmailNotification): Promise<FaxEmailNotificationResult> {
    if (input.toNumber.endsWith("0002") && input.attempt === 1) {
      throw new Error("Demo email delivery failed on the first attempt.");
    }
    return {
      messageId: `demo-${input.kind}-${input.faxJobId}`,
      attached: true,
    };
  }
}

interface EmailSender {
  send(message: EmailMessageBuilder): Promise<EmailSendResult>;
}

export class CloudflareFaxEmailNotifier implements FaxEmailNotifier {
  constructor(
    private readonly email: EmailSender,
    private readonly config: {
      fromAddress: string;
      appBaseUrl: string;
      maxAttachmentBytes: number;
    },
  ) {}

  async send(input: FaxEmailNotification): Promise<FaxEmailNotificationResult> {
    const attached = input.bytes.byteLength <= this.config.maxAttachmentBytes;
    const faxUrl = new URL(
      `/activity/${encodeURIComponent(input.faxJobId)}`,
      this.config.appBaseUrl,
    ).toString();
    const incoming = input.kind === "inbound_received";
    const subject = incoming
      ? `Fax received from ${input.fromNumber}`
      : `Fax delivered to ${input.toNumber}`;
    const summary = incoming
      ? `A fax was received from ${input.fromNumber} at ${input.toNumber}.`
      : `Your fax from ${input.fromNumber} was delivered to ${input.toNumber}.`;
    const attachmentNote = attached
      ? `The ${incoming ? "received fax" : "exact transmitted fax packet"} is attached as a PDF.`
      : `The PDF was too large to attach. Open the archived copy: ${faxUrl}`;

    const result = await this.email.send({
      from: this.config.fromAddress,
      to: input.destinationEmail,
      subject,
      text: [
        summary,
        `${incoming ? "Received" : "Delivered"}: ${input.occurredAt}`,
        `Pages: ${input.pageCount ?? "Unknown"}`,
        `Provider: ${providerLabel(input.providerName)}`,
        `Provider result: ${input.providerResult}`,
        `Provider fax ID: ${input.providerFaxId ?? "Not reported"}`,
        "",
        attachmentNote,
        `View details: ${faxUrl}`,
      ].join("\n"),
      attachments: attached
        ? [
            {
              disposition: "attachment",
              filename: input.filename,
              type: input.mimeType,
              content: input.bytes,
            },
          ]
        : [],
    });
    return { messageId: result.messageId, attached };
  }
}

function providerLabel(provider: string): string {
  if (provider === "signalwire") return "SignalWire";
  if (provider === "sinch") return "Sinch";
  if (provider === "demo") return "Demo";
  return provider;
}
