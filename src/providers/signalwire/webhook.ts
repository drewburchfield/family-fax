import { z } from "zod";

import { normalizeMoney } from "../../domain/money";
import {
  assertWebhookBasicAuth,
  type FaxWebhookEvent,
} from "../webhook";
import { normalizeSignalWireFaxStatus } from "./schemas";

const faxCallbackSchema = z
  .object({
    FaxSid: z.string().min(1),
    FaxStatus: z.string().default("unknown"),
    From: z.string().default(""),
    To: z.string().default(""),
    NumPages: z.string().regex(/^\d+$/).optional(),
    Price: z.string().optional(),
    PriceUnit: z.string().default("USD"),
    ErrorCode: z.string().optional(),
    ErrorMessage: z.string().optional(),
    MediaSid: z.string().optional(),
    MediaUrl: z.string().optional(),
    DateCreated: z.string().optional(),
    Timestamp: z.string().optional(),
  })
  .passthrough();

export async function parseSignalWireFaxWebhook(
  request: Request,
  credentials: { username: string; password: string },
  direction: "inbound" | "outbound",
): Promise<FaxWebhookEvent> {
  assertWebhookBasicAuth(request.headers.get("Authorization"), credentials);
  const contentType = request.headers.get("Content-Type") ?? "";
  if (!contentType.includes("application/x-www-form-urlencoded")) {
    throw new Error(`Unsupported SignalWire webhook content type: ${contentType || "missing"}`);
  }
  const body = new URLSearchParams(await request.text());
  const raw = Object.fromEntries(body.entries());
  const parsed = faxCallbackSchema.parse(raw);
  const eventTime = parsed.Timestamp ?? parsed.DateCreated ?? new Date().toISOString();
  const stableEventTime = parsed.Timestamp ?? parsed.DateCreated ?? "no-timestamp";
  const status = normalizeSignalWireFaxStatus(parsed.FaxStatus);
  const pageCount = parsed.NumPages ? Number.parseInt(parsed.NumPages, 10) : null;
  return {
    provider: "signalwire",
    type: direction === "inbound" ? "incoming" : "status",
    eventKey: [direction, parsed.FaxSid, parsed.FaxStatus, parsed.MediaSid ?? "none", stableEventTime].join(":"),
    eventTime,
    fax: {
      id: parsed.FaxSid,
      direction,
      from: parsed.From,
      to: parsed.To,
      status,
      pageCount,
      price: parsed.Price ? normalizeMoney(parsed.Price, parsed.PriceUnit) : null,
      errorCode: parsed.ErrorCode ?? null,
      errorMessage: parsed.ErrorMessage ?? null,
      createdAt: parsed.DateCreated ?? eventTime,
      completedAt: ["completed", "failure"].includes(status) ? eventTime : null,
      raw,
    },
    file: null,
    raw,
  };
}

export function signalWireReceiveXml(actionUrl: string): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    "<Response>",
    `  <Receive action="${escapeXml(actionUrl)}" method="POST" mediaType="application/pdf" />`,
    "</Response>",
  ].join("\n");
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
