import { z } from "zod";

import type { ProviderDocument } from "../fax-provider";
import {
  assertWebhookBasicAuth,
  type FaxWebhookEvent,
} from "../webhook";
import { mapSinchFax } from "./schemas";

export { WebhookAuthError } from "../webhook";
export type SinchWebhookEvent = FaxWebhookEvent;

const eventSchema = z.object({
  event: z.string(),
  eventTime: z.string(),
  fax: z.unknown(),
  file: z.string().optional(),
  fileType: z.string().optional(),
});

export async function parseSinchWebhook(
  request: Request,
  credentials: { username: string; password: string },
): Promise<SinchWebhookEvent> {
  assertWebhookBasicAuth(request.headers.get("Authorization"), credentials);
  const contentType = request.headers.get("Content-Type") ?? "";
  let raw: Record<string, unknown>;
  let file: ProviderDocument | null = null;

  if (contentType.includes("application/json")) {
    raw = (await request.json()) as Record<string, unknown>;
    const encoded = typeof raw.file === "string" ? raw.file : null;
    if (encoded) {
      const bytes = base64Bytes(encoded);
      file = {
        body: new Blob([bytes]).stream(),
        contentType: raw.fileType === "PDF" ? "application/pdf" : "application/octet-stream",
        size: bytes.byteLength,
      };
    }
  } else if (contentType.includes("multipart/form-data")) {
    const form = await request.formData();
    const faxValue = form.get("fax");
    raw = {
      event: form.get("event"),
      eventTime: form.get("eventTime"),
      fax: typeof faxValue === "string" ? JSON.parse(faxValue) : faxValue,
    };
    const attachment = form.get("file");
    if (attachment instanceof Blob) {
      file = {
        body: attachment.stream(),
        contentType: attachment.type || "application/pdf",
        size: attachment.size,
      };
    }
  } else {
    throw new Error(`Unsupported Sinch webhook content type: ${contentType || "missing"}`);
  }

  const event = eventSchema.parse(raw);
  const fax = mapSinchFax(event.fax);
  const eventName = event.event.toUpperCase();
  if (!["INCOMING_FAX", "FAX_COMPLETED"].includes(eventName)) {
    throw new Error(`Unsupported Sinch webhook event: ${event.event}`);
  }
  const type = eventName === "INCOMING_FAX" ? "incoming" : "status";
  const { file: _encodedFile, ...safeRaw } = raw;
  return {
    provider: "sinch",
    type,
    eventKey: `${event.event}:${fax.id}:${event.eventTime}`,
    eventTime: event.eventTime,
    fax,
    file,
    raw: safeRaw,
  };
}

function base64Bytes(value: string): ArrayBuffer {
  const decoded = atob(value);
  const buffer = new ArrayBuffer(decoded.length);
  const bytes = new Uint8Array(buffer);
  for (let index = 0; index < decoded.length; index += 1) {
    bytes[index] = decoded.charCodeAt(index);
  }
  return buffer;
}
