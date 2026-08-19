import { z } from "zod";

import { normalizeMoney } from "../../domain/money";
import type { NumberCandidate, ProviderFax, ProviderFaxStatus, ProvisionedNumber } from "../fax-provider";

const availableNumberSchema = z
  .object({
    number: z.string().optional(),
    e164: z.string().optional(),
    region: z.string().nullish(),
    city: z.string().nullish(),
    capabilities: z.union([
      z.array(z.string()),
      z.object({
        voice: z.boolean().optional(),
        sms: z.boolean().optional(),
        mms: z.boolean().optional(),
        fax: z.boolean().optional(),
      }),
    ]).default({}),
  })
  .passthrough()
  .refine((value) => Boolean(value.number ?? value.e164), {
    message: "SignalWire inventory number is missing",
  });

export const availableNumbersSchema = z
  .object({ data: z.array(availableNumberSchema) })
  .passthrough();

export const signalWireNumberSchema = z
  .object({
    id: z.string(),
    number: z.string(),
    capabilities: z.union([z.array(z.string()), z.record(z.string(), z.boolean())]).default([]),
    number_type: z.string().nullish(),
    next_billed_at: z.string().nullish(),
    call_handler: z.string().nullish(),
    call_receive_mode: z.string().nullish(),
    call_request_url: z.string().nullish(),
  })
  .passthrough();

export const signalWireNumberListSchema = z
  .object({ data: z.array(signalWireNumberSchema) })
  .passthrough();

export const signalWireFaxSchema = z
  .object({
    sid: z.string(),
    direction: z.string().default("outbound"),
    from: z.string().default(""),
    to: z.string().default(""),
    status: z.string().default("queued"),
    num_pages: z.union([z.string(), z.number()]).nullish(),
    price: z.union([z.string(), z.number()]).nullish(),
    price_unit: z.string().default("USD"),
    date_created: z.string().optional(),
    date_updated: z.string().optional(),
    error_code: z.union([z.string(), z.number()]).nullish(),
    error_message: z.string().nullish(),
    media_url: z.string().url().nullish(),
    media_sid: z.string().nullish(),
  })
  .passthrough();

export const signalWireFaxListSchema = z
  .object({ faxes: z.array(signalWireFaxSchema) })
  .passthrough();

export const signalWireFaxMediaListSchema = z
  .object({
    media: z
      .array(
        z
          .object({
            sid: z.string(),
            content_type: z.string().default("application/pdf"),
            url: z.string().optional(),
            uri: z.string().optional(),
          })
          .passthrough(),
      )
      .default([]),
  })
  .passthrough();

const faxStatusMap: Record<string, ProviderFaxStatus> = {
  queued: "queued",
  processing: "in_progress",
  sending: "in_progress",
  ringing: "in_progress",
  answered: "in_progress",
  delivered: "completed",
  received: "completed",
  completed: "completed",
  failed: "failure",
  canceled: "failure",
  busy: "failure",
  "no-answer": "failure",
};

export function normalizeSignalWireFaxStatus(value: string): ProviderFaxStatus {
  return faxStatusMap[value.toLowerCase()] ?? "unknown";
}

export function mapSignalWireCandidate(
  input: unknown,
  requestedAreaCode: string,
  monthlyPrice: string,
): NumberCandidate | null {
  const parsed = availableNumberSchema.parse(input);
  const e164 = parsed.number ?? parsed.e164;
  if (!e164) return null;
  const capabilities = Array.isArray(parsed.capabilities)
    ? parsed.capabilities.map((name) => name.toUpperCase())
    : Object.entries(parsed.capabilities)
        .filter(([, enabled]) => enabled)
        .map(([name]) => name.toUpperCase());
  if (!capabilities.includes("FAX")) return null;
  return {
    e164,
    areaCode: e164.startsWith("+1") ? e164.slice(2, 5) : requestedAreaCode,
    countryCode: "US",
    type: "LOCAL",
    capabilities,
    setupPrice: null,
    monthlyPrice: normalizeMoney(monthlyPrice, "USD", 1),
    supportingDocumentationRequired: false,
    raw: input,
  };
}

export function mapSignalWireNumber(input: unknown): ProvisionedNumber {
  const parsed = signalWireNumberSchema.parse(input);
  return {
    e164: parsed.number,
    providerId: parsed.id,
    ready: true,
    nextBilledAt: parsed.next_billed_at ?? null,
    raw: input,
  };
}

export function mapSignalWireFax(input: unknown): ProviderFax {
  const parsed = signalWireFaxSchema.parse(input);
  const status = normalizeSignalWireFaxStatus(parsed.status);
  const createdAt = parsed.date_created ?? new Date().toISOString();
  return {
    id: parsed.sid,
    direction: parsed.direction.toLowerCase() === "inbound" ? "inbound" : "outbound",
    from: parsed.from,
    to: parsed.to,
    status,
    pageCount: strictPageCount(parsed.num_pages),
    price: parsed.price === null || parsed.price === undefined
      ? null
      : normalizeMoney(parsed.price, parsed.price_unit),
    errorCode: parsed.error_code === null || parsed.error_code === undefined ? null : String(parsed.error_code),
    errorMessage: parsed.error_message ?? null,
    createdAt,
    completedAt: ["completed", "failure"].includes(status) ? (parsed.date_updated ?? createdAt) : null,
    raw: input,
  };
}

function strictPageCount(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" && !/^\d+$/.test(value)) {
    throw new Error(`Invalid SignalWire page count: ${value}`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`Invalid SignalWire page count: ${String(value)}`);
  }
  return parsed;
}
