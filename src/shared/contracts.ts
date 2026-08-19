import type { CountryCode } from "libphonenumber-js";

export type FaxMode = "send-only" | "receive-only" | "send-and-receive";
export type FaxDirection = "outbound" | "inbound" | "none";
export type NumberReleasePolicy = "after-send" | "scheduled" | "manual";

export type FaxState =
  | "draft"
  | "preparing"
  | "prepared"
  | "provisioning"
  | "active"
  | "submitting"
  | "submitted"
  | "sending"
  | "delivered"
  | "failed"
  | "canceled"
  | "status_unknown"
  | "completed";

export type TemporaryNumberState =
  | "requested"
  | "provisioning"
  | "activating"
  | "cleaning"
  | "active"
  | "expiring"
  | "releasing"
  | "released"
  | "provision_failed"
  | "release_failed";

export type DocumentKind = "original" | "cover" | "final-packet" | "inbound";
export type AuditSource = "user" | "application" | "provider" | "workflow" | "webhook" | "scheduled";
export type FaxNotificationKind = "inbound_received" | "outbound_delivered";
export type FaxNotificationState = "sending" | "delivered" | "failed" | "delivery_unknown";

export interface Money {
  amount: string;
  currency: string;
  intervalMonths?: number;
}

export interface FaxDocument {
  id: string;
  faxJobId: string | null;
  temporaryNumberId: string | null;
  kind: DocumentKind;
  objectKey: string;
  mimeType: string;
  byteCount: number;
  pageCount: number | null;
  sha256: string;
  displayName: string;
  createdAt: string;
}

export interface FaxJob {
  id: string;
  mode: FaxMode;
  direction: FaxDirection;
  state: FaxState;
  toNumber: string | null;
  fromNumber: string | null;
  providerFaxId: string | null;
  providerProjectId: string | null;
  temporaryNumberId: string | null;
  correlationId: string;
  finalDocumentId: string | null;
  pageCount: number | null;
  estimatedCost: Money | null;
  reportedCost: Money | null;
  requestedTtlDays: number | null;
  requestedRentalMonths?: number | null;
  coverData: CoverSheetData | null;
  failureCode: string | null;
  failureMessage: string | null;
  createdAt: string;
  updatedAt: string;
  submittedAt: string | null;
  completedAt: string | null;
}

export interface TemporaryNumber {
  id: string;
  faxJobId: string | null;
  e164: string | null;
  areaCode: string;
  providerId: string | null;
  providerName?: "demo" | "sinch" | "signalwire";
  state: TemporaryNumberState;
  mode: FaxMode;
  forwardingEmail: string;
  setupPrice: Money | null;
  monthlyPrice: Money | null;
  provisionedAt: string | null;
  earliestProviderReleaseAt: string | null;
  releasePolicy?: NumberReleasePolicy;
  rentalMonths?: number | null;
  nextBilledAt?: string | null;
  releaseAt?: string | null;
  expiresAt: string | null;
  releaseStartedAt: string | null;
  releasedAt: string | null;
  workflowId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface FaxEvent {
  id: string;
  correlationId: string;
  faxJobId: string | null;
  temporaryNumberId: string | null;
  source: AuditSource;
  type: string;
  resultingState: string | null;
  attempt: number | null;
  durationMs: number | null;
  details: Record<string, unknown>;
  rawPayloadKey: string | null;
  createdAt: string;
}

export interface FaxNotification {
  faxJobId: string;
  kind: FaxNotificationKind;
  state: FaxNotificationState;
  destinationEmail: string;
  attempt: number;
  messageId: string | null;
  attached: boolean | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  deliveredAt: string | null;
}

export interface CoverSheetData {
  recipient: string;
  sender: string;
  subject: string;
  callbackNumber: string;
  note: string;
  enabled: boolean;
}

export interface PublicAppConfig {
  appName: string;
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
  minimumNumberHoldDays: number;
  retention: { mode: "forever" };
  logDetail: "full";
  limits: {
    maxUploadBytes: number;
    maxFaxPages: number;
  };
}
