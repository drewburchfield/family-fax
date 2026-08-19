import { z } from "zod";

import { normalizeMoney } from "../../domain/money";
import type { NumberCandidate, ProviderFax, ProviderFaxStatus } from "../fax-provider";

const moneySchema = z
  .object({
    amount: z.union([z.string(), z.number()]),
    currencyCode: z.string().optional(),
    currency: z.string().optional(),
  })
  .passthrough();

const availableNumberSchema = z
  .object({
    phoneNumber: z.string(),
    regionCode: z.string().default("US"),
    type: z.string().default("LOCAL"),
    capability: z.array(z.string()).optional(),
    capabilities: z.array(z.string()).optional(),
    setupPrice: moneySchema.optional(),
    monthlyPrice: moneySchema.optional(),
    paymentIntervalMonths: z.number().optional(),
    supportingDocumentationRequired: z.boolean().optional(),
  })
  .passthrough();

export const availableNumbersResponseSchema = z
  .object({ availableNumbers: z.array(availableNumberSchema).default([]) })
  .passthrough();

export const activeNumberSchema = z
  .object({
    phoneNumber: z.string(),
    voiceConfiguration: z
      .object({ type: z.string(), serviceId: z.string().optional() })
      .passthrough()
      .optional(),
    scheduledVoiceProvisioning: z.unknown().optional(),
  })
  .passthrough();

export const faxSchema = z
  .object({
    id: z.string(),
    direction: z.string().default("OUTBOUND"),
    from: z.string().default(""),
    to: z.string().default(""),
    status: z.string().default("QUEUED"),
    numberOfPages: z.number().optional(),
    price: moneySchema.optional(),
    errorCode: z.union([z.string(), z.number()]).optional(),
    errorMessage: z.string().optional(),
    createTime: z.string().optional(),
    completedTime: z.string().optional(),
  })
  .passthrough();

const statusMap: Record<string, ProviderFaxStatus> = {
  QUEUED: "queued",
  IN_PROGRESS: "in_progress",
  COMPLETED: "completed",
  FAILURE: "failure",
};

export function mapSinchCandidate(value: unknown, requestedAreaCode: string): NumberCandidate {
  const parsed = availableNumberSchema.parse(value);
  return {
    e164: parsed.phoneNumber,
    areaCode: parsed.phoneNumber.startsWith("+1")
      ? parsed.phoneNumber.slice(2, 5)
      : requestedAreaCode,
    countryCode: parsed.regionCode,
    type: ["LOCAL", "TOLL_FREE", "MOBILE"].includes(parsed.type)
      ? (parsed.type as NumberCandidate["type"])
      : "LOCAL",
    capabilities: parsed.capability ?? parsed.capabilities ?? [],
    setupPrice: parsed.setupPrice
      ? normalizeMoney(
          parsed.setupPrice.amount,
          parsed.setupPrice.currencyCode ?? parsed.setupPrice.currency,
        )
      : null,
    monthlyPrice: parsed.monthlyPrice
      ? normalizeMoney(
          parsed.monthlyPrice.amount,
          parsed.monthlyPrice.currencyCode ?? parsed.monthlyPrice.currency,
          parsed.paymentIntervalMonths,
        )
      : null,
    supportingDocumentationRequired: parsed.supportingDocumentationRequired ?? false,
    raw: value,
  };
}

export function mapSinchFax(value: unknown): ProviderFax {
  const parsed = faxSchema.parse(value);
  return {
    id: parsed.id,
    direction: parsed.direction.toUpperCase() === "INBOUND" ? "inbound" : "outbound",
    from: parsed.from,
    to: parsed.to,
    status: statusMap[parsed.status.toUpperCase()] ?? "unknown",
    pageCount: parsed.numberOfPages ?? null,
    price: parsed.price
      ? normalizeMoney(parsed.price.amount, parsed.price.currencyCode ?? parsed.price.currency)
      : null,
    errorCode: parsed.errorCode === undefined ? null : String(parsed.errorCode),
    errorMessage: parsed.errorMessage ?? null,
    createdAt: parsed.createTime ?? new Date().toISOString(),
    completedAt: parsed.completedTime ?? null,
    raw: value,
  };
}
