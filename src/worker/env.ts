/// <reference types="@cloudflare/workers-types" />

import type { Money } from "../shared/contracts";

export interface WorkflowNumberCandidate {
  e164: string;
  areaCode: string;
  countryCode: string;
  type: "LOCAL" | "TOLL_FREE" | "MOBILE";
  capabilities: string[];
  setupPrice: Money | null;
  monthlyPrice: Money | null;
  supportingDocumentationRequired: boolean;
}

export interface NumberLifecycleWorkflowParams {
  numberId: string;
  candidate: WorkflowNumberCandidate;
  appBaseUrl: string;
}

export interface OutboundFaxWorkflowParams {
  faxJobId: string;
  temporaryNumberId: string;
  appBaseUrl: string;
}

export interface WorkerEnv {
  DB: D1Database;
  DOCUMENTS: R2Bucket;
  OUTBOUND_FAX_WORKFLOW: Workflow<OutboundFaxWorkflowParams>;
  NUMBER_LIFECYCLE_WORKFLOW: Workflow<NumberLifecycleWorkflowParams>;
  EMAIL?: SendEmail;
  CF_VERSION_METADATA?: WorkerVersionMetadata;
  APP_NAME: string;
  APP_VERSION: string;
  AUTH_MODE: string;
  FAX_PROVIDER: string;
  DEFAULT_PHONE_COUNTRY?: string;
  DEFAULT_FORWARD_EMAIL: string;
  PREFERRED_AREA_CODES: string;
  DEFAULT_TTL_DAYS: string;
  TTL_PRESETS: string;
  MAX_TTL_DAYS: string;
  DEFAULT_RENTAL_MONTHS: string;
  RENTAL_MONTH_PRESETS: string;
  MAX_RENTAL_MONTHS: string;
  DEFAULT_RETENTION: string;
  LOG_DETAIL: string;
  MAX_UPLOAD_BYTES: string;
  MAX_FAX_PAGES: string;
  MAX_EMAIL_ATTACHMENT_BYTES?: string;
  APP_BASE_URL?: string;
  CF_ACCESS_AUD?: string;
  CF_ACCESS_TEAM_DOMAIN?: string;
  WEBHOOK_BASE_URL?: string;
  WEBHOOK_USERNAME?: string;
  WEBHOOK_PASSWORD?: string;
  SINCH_PROJECT_ID?: string;
  SINCH_SERVICE_ID?: string;
  SINCH_REGION?: string;
  SINCH_KEY_ID?: string;
  SINCH_KEY_SECRET?: string;
  SIGNALWIRE_PROJECT_ID?: string;
  SIGNALWIRE_API_TOKEN?: string;
  SIGNALWIRE_SPACE_URL?: string;
  SIGNALWIRE_LOCAL_NUMBER_MONTHLY_PRICE?: string;
  SIGNALWIRE_ACCOUNT_MODE?: string;
  SIGNALWIRE_MINIMUM_NUMBER_HOLD_DAYS?: string;
  EMAIL_FROM_ADDRESS?: string;
}
