import { z } from "zod";

import { ConflictError } from "../../domain/errors";

export const coverSheetSchema = z.object({
  recipient: z.string().max(160),
  sender: z.string().max(160),
  subject: z.string().max(200),
  callbackNumber: z.string().max(40),
  note: z.string().max(2_000),
  enabled: z.boolean(),
});

export const moneySchema = z.object({
  amount: z.string(),
  currency: z.string().length(3),
  intervalMonths: z.number().int().positive().optional(),
});

export const numberCandidateSchema = z.object({
  e164: z.string().regex(/^\+[1-9]\d{7,14}$/),
  areaCode: z.string().regex(/^\d{3}$/),
  countryCode: z.string().length(2),
  type: z.enum(["LOCAL", "TOLL_FREE", "MOBILE"]),
  capabilities: z.array(z.string()),
  setupPrice: moneySchema.nullable(),
  monthlyPrice: moneySchema.nullable(),
  supportingDocumentationRequired: z.boolean(),
  raw: z.unknown().optional(),
});

export const draftSchema = z.object({
  mode: z.enum(["send-only", "receive-only", "send-and-receive"]),
  toNumber: z.string().nullable(),
  requestedTtlDays: z.number().int().positive().nullable().optional(),
  requestedRentalMonths: z.number().int().positive().nullable().optional(),
  coverData: coverSheetSchema.nullable(),
});

export const prepareSchema = z.object({
  finalDocumentId: z.string().min(1).nullable(),
  pageCount: z.number().int().positive().nullable(),
});

export const cancelSchema = z.object({
  reason: z.string().trim().min(1).max(500),
});

export const startSchema = z.object({
  candidate: numberCandidateSchema,
  forwardingEmail: z.email(),
  confirmed: z.boolean(),
});

export const preferencesSchema = z.object({
  defaultForwardEmail: z.email(),
  preferredAreaCodes: z.array(z.string().regex(/^\d{3}$/)).min(1).max(10),
  defaultTtlDays: z.number().int().positive().optional(),
  defaultRentalMonths: z.number().int().positive(),
  householdLineId: z.string().min(1).nullable().optional().default(null),
});

export const templateSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]+$/).optional(),
  name: z.string().trim().min(1).max(120),
  data: coverSheetSchema,
  isDefault: z.boolean(),
});

export async function parseJson<T>(request: Request, schema: z.ZodType<T>): Promise<T> {
  let value: unknown;
  try {
    value = await request.json();
  } catch {
    throw new ConflictError("The request body must contain valid JSON.");
  }
  return schema.parse(value);
}
