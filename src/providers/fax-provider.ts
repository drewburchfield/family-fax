import type { Money } from "../shared/contracts";
import type { FaxMode } from "../shared/contracts";

export interface NumberSearchRequest {
  areaCodes: string[];
  countryCode: string;
  limitPerAreaCode: number;
}

export interface NumberCandidate {
  e164: string;
  areaCode: string;
  countryCode: string;
  type: "LOCAL" | "TOLL_FREE" | "MOBILE";
  capabilities: string[];
  setupPrice: Money | null;
  monthlyPrice: Money | null;
  supportingDocumentationRequired: boolean;
  raw: unknown;
}

export interface ProvisionedNumber {
  e164: string;
  providerId: string;
  ready: boolean;
  nextBilledAt: string | null;
  raw: unknown;
}

export type ProviderFaxStatus = "queued" | "in_progress" | "completed" | "failure" | "unknown";

export interface ProviderFax {
  id: string;
  direction: "inbound" | "outbound";
  from: string;
  to: string;
  status: ProviderFaxStatus;
  pageCount: number | null;
  price: Money | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  completedAt: string | null;
  raw: unknown;
}

export interface ProviderDocument {
  body: ReadableStream;
  contentType: string;
  size?: number;
}

export interface FaxProvider {
  readonly name: "demo" | "sinch" | "signalwire";
  searchNumbers(request: NumberSearchRequest): Promise<NumberCandidate[]>;
  provisionNumber(input: {
    candidate: NumberCandidate;
    correlationId: string;
  }): Promise<ProvisionedNumber>;
  getNumber(e164: string): Promise<ProvisionedNumber | null>;
  configureInboundNumber(input: {
    e164: string;
    email: string;
    mode: FaxMode;
    callbackUrl: string;
    correlationId: string;
  }): Promise<{ configured: boolean; raw: unknown }>;
  removeInboundNumberRouting(input: {
    e164: string;
    email: string;
    correlationId: string;
  }): Promise<{ removed: boolean; raw: unknown }>;
  sendFax(input: {
    from: string;
    to: string;
    contentUrl: string;
    callbackUrl: string;
    correlationId: string;
  }): Promise<ProviderFax>;
  getFax(id: string): Promise<ProviderFax>;
  downloadFax(id: string): Promise<ProviderDocument>;
  releaseNumber(e164: string, correlationId: string): Promise<{ released: boolean; raw: unknown }>;
  health(): Promise<{ ok: boolean; detail: string; raw?: unknown }>;
}
