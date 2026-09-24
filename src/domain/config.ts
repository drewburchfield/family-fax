import { z } from "zod";
import { isSupportedCountry, type CountryCode } from "libphonenumber-js";

import type { PublicAppConfig } from "../shared/contracts";

const areaCodePattern = /^\d{3}$/;

const rawConfigSchema = z.object({
  APP_NAME: z.string().trim().min(1).default("Family Fax"),
  APP_VERSION: z.string().trim().min(1).default("0.1.0"),
  AUTH_MODE: z.enum(["dev", "access"]).default("access"),
  FAX_PROVIDER: z.enum(["demo", "sinch", "signalwire"]).default("demo"),
  DEFAULT_PHONE_COUNTRY: z.string().trim().length(2).default("US"),
  DEFAULT_FORWARD_EMAIL: z.email(),
  PREFERRED_AREA_CODES: z.string().min(1),
  DEFAULT_TTL_DAYS: z.string().regex(/^\d+$/),
  TTL_PRESETS: z.string().min(1),
  MAX_TTL_DAYS: z.string().regex(/^\d+$/),
  DEFAULT_RENTAL_MONTHS: z.string().regex(/^\d+$/).default("1"),
  RENTAL_MONTH_PRESETS: z.string().min(1).default("1,2,3"),
  MAX_RENTAL_MONTHS: z.string().regex(/^\d+$/).default("12"),
  DEFAULT_RETENTION: z.literal("forever").default("forever"),
  LOG_DETAIL: z.literal("full").default("full"),
  MAX_UPLOAD_BYTES: z.string().regex(/^\d+$/),
  MAX_FAX_PAGES: z.string().regex(/^\d+$/),
  MAX_EMAIL_ATTACHMENT_BYTES: z.string().regex(/^\d+$/).default("18000000"),
  APP_BASE_URL: z.url().optional(),
  CF_ACCESS_AUD: z.string().min(1).optional(),
  CF_ACCESS_TEAM_DOMAIN: z.string().min(1).optional(),
  WEBHOOK_BASE_URL: z.url().optional(),
  WEBHOOK_USERNAME: z.string().min(1).optional(),
  WEBHOOK_PASSWORD: z.string().min(1).optional(),
  SINCH_PROJECT_ID: z.string().min(1).optional(),
  SINCH_SERVICE_ID: z.string().min(1).optional(),
  SINCH_REGION: z.string().min(1).default("global"),
  SINCH_KEY_ID: z.string().min(1).optional(),
  SINCH_KEY_SECRET: z.string().min(1).optional(),
  SIGNALWIRE_PROJECT_ID: z.string().min(1).optional(),
  SIGNALWIRE_API_TOKEN: z.string().min(1).optional(),
  SIGNALWIRE_SPACE_URL: z.string().min(1).optional(),
  SIGNALWIRE_LOCAL_NUMBER_MONTHLY_PRICE: z.string().regex(/^\d+(?:\.\d+)?$/).optional(),
  SIGNALWIRE_ACCOUNT_MODE: z.enum(["trial", "funded"]).default("trial"),
  SIGNALWIRE_MINIMUM_NUMBER_HOLD_DAYS: z.string().regex(/^\d+$/).optional(),
  EMAIL_FROM_ADDRESS: z.email().optional(),
});

export interface RuntimeConfig {
  appName: string;
  appVersion: string;
  auth:
    | { mode: "dev" }
    | { mode: "access"; audience: string; teamDomain: string };
  provider: "demo" | "sinch" | "signalwire";
  isDemo: boolean;
  defaultPhoneCountry: CountryCode;
  defaultForwardEmail: string;
  preferredAreaCodes: string[];
  defaultTtlDays: number;
  ttlPresets: number[];
  maxTtlDays: number;
  defaultRentalMonths: number;
  rentalMonthPresets: number[];
  maxRentalMonths: number;
  retention: { mode: "forever" };
  logDetail: "full";
  maxUploadBytes: number;
  maxFaxPages: number;
  maxEmailAttachmentBytes: number;
  appBaseUrl?: string;
  webhook?: { baseUrl: string; username: string; password: string };
  sinch?: {
    projectId: string;
    serviceId: string;
    region: string;
    keyId: string;
    keySecret: string;
  };
  signalwire?: {
    projectId: string;
    apiToken: string;
    spaceUrl: string;
    localNumberMonthlyPrice: string;
    accountMode: "trial" | "funded";
    minimumNumberHoldDays: number;
  };
  email?: { fromAddress: string };
}

export class ConfigError extends Error {
  constructor(readonly issues: string[]) {
    super(`Invalid runtime configuration: ${issues.join("; ")}`);
    this.name = "ConfigError";
  }
}

function requiredValue(
  value: string | undefined,
  name: string,
  issues: string[],
): string {
  if (!value) {
    issues.push(`${name} is required`);
    return "";
  }

  return value;
}

function parsePositiveInteger(value: string, name: string, issues: string[]): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    issues.push(`${name} must be a positive integer`);
  }
  return parsed;
}

export function parseRuntimeConfig(input: unknown): RuntimeConfig {
  const parsed = rawConfigSchema.safeParse(input);
  if (!parsed.success) {
    throw new ConfigError(parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`));
  }

  const raw = parsed.data;
  const issues: string[] = [];
  const defaultPhoneCountry = raw.DEFAULT_PHONE_COUNTRY.toUpperCase();
  if (!isSupportedCountry(defaultPhoneCountry)) {
    issues.push("DEFAULT_PHONE_COUNTRY must be a supported two-letter country code");
  }
  const preferredAreaCodes = raw.PREFERRED_AREA_CODES.split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  if (preferredAreaCodes.length === 0 || preferredAreaCodes.some((value) => !areaCodePattern.test(value))) {
    issues.push("PREFERRED_AREA_CODES must contain comma-separated three-digit area codes");
  }

  const ttlPresets = raw.TTL_PRESETS.split(",").map((value) =>
    parsePositiveInteger(value.trim(), "TTL_PRESETS", issues),
  );
  const defaultTtlDays = parsePositiveInteger(raw.DEFAULT_TTL_DAYS, "DEFAULT_TTL_DAYS", issues);
  const maxTtlDays = parsePositiveInteger(raw.MAX_TTL_DAYS, "MAX_TTL_DAYS", issues);
  const defaultRentalMonths = parsePositiveInteger(
    raw.DEFAULT_RENTAL_MONTHS,
    "DEFAULT_RENTAL_MONTHS",
    issues,
  );
  const rentalMonthPresets = raw.RENTAL_MONTH_PRESETS.split(",").map((value) =>
    parsePositiveInteger(value.trim(), "RENTAL_MONTH_PRESETS", issues),
  );
  const maxRentalMonths = parsePositiveInteger(raw.MAX_RENTAL_MONTHS, "MAX_RENTAL_MONTHS", issues);
  const maxUploadBytes = parsePositiveInteger(raw.MAX_UPLOAD_BYTES, "MAX_UPLOAD_BYTES", issues);
  const maxFaxPages = parsePositiveInteger(raw.MAX_FAX_PAGES, "MAX_FAX_PAGES", issues);
  const maxEmailAttachmentBytes = parsePositiveInteger(
    raw.MAX_EMAIL_ATTACHMENT_BYTES,
    "MAX_EMAIL_ATTACHMENT_BYTES",
    issues,
  );

  if (defaultTtlDays > maxTtlDays || ttlPresets.some((days) => days > maxTtlDays)) {
    issues.push("TTL values cannot exceed MAX_TTL_DAYS");
  }
  if (
    defaultRentalMonths > maxRentalMonths ||
    rentalMonthPresets.some((months) => months > maxRentalMonths)
  ) {
    issues.push("Rental month values cannot exceed MAX_RENTAL_MONTHS");
  }

  let auth: RuntimeConfig["auth"] = { mode: "dev" };
  if (raw.AUTH_MODE === "access") {
    auth = {
      mode: "access",
      audience: requiredValue(raw.CF_ACCESS_AUD, "CF_ACCESS_AUD", issues),
      teamDomain: requiredValue(raw.CF_ACCESS_TEAM_DOMAIN, "CF_ACCESS_TEAM_DOMAIN", issues),
    };
  }

  let sinch: RuntimeConfig["sinch"];
  let signalwire: RuntimeConfig["signalwire"];
  let email: RuntimeConfig["email"];
  let webhook: RuntimeConfig["webhook"];
  if (raw.FAX_PROVIDER === "sinch" || raw.FAX_PROVIDER === "signalwire") {
    requiredValue(raw.APP_BASE_URL, "APP_BASE_URL", issues);
    webhook = {
      baseUrl: requiredValue(raw.WEBHOOK_BASE_URL, "WEBHOOK_BASE_URL", issues),
      username: requiredValue(raw.WEBHOOK_USERNAME, "WEBHOOK_USERNAME", issues),
      password: requiredValue(raw.WEBHOOK_PASSWORD, "WEBHOOK_PASSWORD", issues),
    };
    email = {
      fromAddress: requiredValue(raw.EMAIL_FROM_ADDRESS, "EMAIL_FROM_ADDRESS", issues),
    };
    if (raw.FAX_PROVIDER === "sinch") {
      sinch = {
        projectId: requiredValue(raw.SINCH_PROJECT_ID, "SINCH_PROJECT_ID", issues),
        serviceId: requiredValue(raw.SINCH_SERVICE_ID, "SINCH_SERVICE_ID", issues),
        region: raw.SINCH_REGION,
        keyId: requiredValue(raw.SINCH_KEY_ID, "SINCH_KEY_ID", issues),
        keySecret: requiredValue(raw.SINCH_KEY_SECRET, "SINCH_KEY_SECRET", issues),
      };
    } else {
      signalwire = {
        projectId: requiredValue(raw.SIGNALWIRE_PROJECT_ID, "SIGNALWIRE_PROJECT_ID", issues),
        apiToken: requiredValue(raw.SIGNALWIRE_API_TOKEN, "SIGNALWIRE_API_TOKEN", issues),
        spaceUrl: requiredValue(raw.SIGNALWIRE_SPACE_URL, "SIGNALWIRE_SPACE_URL", issues)
          .replace(/^https?:\/\//, "")
          .replace(/\/$/, ""),
        localNumberMonthlyPrice: requiredValue(
          raw.SIGNALWIRE_LOCAL_NUMBER_MONTHLY_PRICE,
          "SIGNALWIRE_LOCAL_NUMBER_MONTHLY_PRICE",
          issues,
        ),
        accountMode: raw.SIGNALWIRE_ACCOUNT_MODE,
        minimumNumberHoldDays: raw.SIGNALWIRE_MINIMUM_NUMBER_HOLD_DAYS
          ? parsePositiveInteger(
              raw.SIGNALWIRE_MINIMUM_NUMBER_HOLD_DAYS,
              "SIGNALWIRE_MINIMUM_NUMBER_HOLD_DAYS",
              issues,
            )
          : raw.SIGNALWIRE_ACCOUNT_MODE === "trial"
            ? 30
            : 14,
      };
    }
  }

  if (issues.length > 0) {
    throw new ConfigError([...new Set(issues)]);
  }

  return {
    appName: raw.APP_NAME,
    appVersion: raw.APP_VERSION,
    auth,
    provider: raw.FAX_PROVIDER,
    isDemo: raw.FAX_PROVIDER === "demo",
    defaultPhoneCountry: defaultPhoneCountry as CountryCode,
    defaultForwardEmail: raw.DEFAULT_FORWARD_EMAIL,
    preferredAreaCodes,
    defaultTtlDays,
    ttlPresets,
    maxTtlDays,
    defaultRentalMonths,
    rentalMonthPresets,
    maxRentalMonths,
    retention: { mode: "forever" },
    logDetail: raw.LOG_DETAIL,
    maxUploadBytes,
    maxFaxPages,
    maxEmailAttachmentBytes,
    ...(raw.APP_BASE_URL ? { appBaseUrl: raw.APP_BASE_URL } : {}),
    ...(webhook ? { webhook } : {}),
    ...(sinch ? { sinch } : {}),
    ...(signalwire ? { signalwire } : {}),
    ...(email ? { email } : {}),
  };
}

export function toPublicConfig(config: RuntimeConfig): PublicAppConfig {
  return {
    appName: config.appName,
    provider: config.provider,
    isDemo: config.isDemo,
    defaultPhoneCountry: config.defaultPhoneCountry,
    defaultForwardEmail: config.defaultForwardEmail,
    preferredAreaCodes: config.preferredAreaCodes,
    defaultTtlDays: config.defaultTtlDays,
    ttlPresets: config.ttlPresets,
    maxTtlDays: config.maxTtlDays,
    defaultRentalMonths: config.defaultRentalMonths,
    rentalMonthPresets: config.rentalMonthPresets,
    maxRentalMonths: config.maxRentalMonths,
    minimumNumberHoldDays: config.signalwire?.minimumNumberHoldDays ?? 0,
    retention: config.retention,
    logDetail: config.logDetail,
    limits: {
      maxUploadBytes: config.maxUploadBytes,
      maxFaxPages: config.maxFaxPages,
    },
  };
}
