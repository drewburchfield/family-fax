import type {
  CoverSheetData,
  FaxDocument,
  FaxEvent,
  FaxJob,
  FaxNotification,
  Money,
  PublicAppConfig,
  TemporaryNumber,
} from "../../shared/contracts";
import type { CoverTemplate } from "../../server/repositories/types";

export interface NumberCandidate {
  e164: string;
  areaCode: string;
  countryCode: string;
  type: "LOCAL" | "TOLL_FREE" | "MOBILE";
  capabilities: string[];
  setupPrice: Money | null;
  monthlyPrice: Money | null;
  supportingDocumentationRequired: boolean;
  raw?: unknown;
}

export interface Preferences {
  defaultForwardEmail: string;
  preferredAreaCodes: string[];
  defaultTtlDays: number;
  defaultRentalMonths: number;
  householdLineId: string | null;
}

export interface BootstrapResponse {
  config: PublicAppConfig & Preferences;
  identity: { email: string; subject: string };
  activeNumbers: TemporaryNumber[];
  recentFaxes: FaxJob[];
  templates: CoverTemplate[];
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly correlationId?: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export const api = {
  bootstrap: () => request<BootstrapResponse>("/api/bootstrap"),
  listFaxes: (search = "", signal?: AbortSignal) =>
    request<{ faxes: FaxJob[] }>(`/api/faxes?search=${encodeURIComponent(search)}`, { signal }),
  getFax: (id: string, signal?: AbortSignal) =>
    request<{ fax: FaxJob; documents: FaxDocument[]; events: FaxEvent[]; notifications: FaxNotification[] }>(`/api/faxes/${id}`, { signal }),
  createFax: (input: {
    mode: FaxJob["mode"];
    toNumber: string | null;
    requestedTtlDays?: number | null;
    requestedRentalMonths?: number | null;
    coverData: CoverSheetData | null;
  }) => request<FaxJob>("/api/faxes", jsonMutation("POST", input)),
  uploadDocument: async (
    faxJobId: string,
    documentId: string,
    body: Blob,
    metadata: {
      kind: "original" | "cover" | "final-packet";
      sha256: string;
      displayName: string;
      pageCount: number | null;
    },
  ) =>
    request<{ id: string }>(`/api/faxes/${faxJobId}/documents/${documentId}`, {
      method: "PUT",
      headers: {
        "X-Family-Fax-Request": "1",
        "Content-Type": body.type,
        "X-Document-Kind": metadata.kind,
        "X-Document-Sha256": metadata.sha256,
        "X-Document-Name": encodeURIComponent(metadata.displayName),
        ...(metadata.pageCount ? { "X-Document-Pages": String(metadata.pageCount) } : {}),
      },
      body,
    }),
  prepareFax: (id: string, finalDocumentId: string | null, pageCount: number | null) =>
    request<FaxJob>(`/api/faxes/${id}/prepare`,
      jsonMutation("POST", { finalDocumentId, pageCount })),
  cancelFax: (id: string, reason: string) =>
    request<FaxJob>(`/api/faxes/${id}/cancel`, jsonMutation("POST", { reason })),
  searchNumbers: (areaCodes: string[]) =>
    request<{ candidates: NumberCandidate[] }>("/api/numbers/search", jsonMutation("POST", { areaCodes })),
  startFax: (id: string, candidate: NumberCandidate, forwardingEmail: string) =>
    request<{ number: TemporaryNumber }>(
      `/api/faxes/${id}/start`,
      jsonMutation("POST", { candidate, forwardingEmail, confirmed: true }),
    ),
  startFaxWithExistingNumber: (id: string, temporaryNumberId: string) =>
    request<{ fax: FaxJob; workflowId: string }>(
      `/api/faxes/${id}/start-existing`,
      jsonMutation("POST", { temporaryNumberId, confirmed: true }),
    ),
  getNumber: (id: string) => request<TemporaryNumber>(`/api/numbers/${id}`),
  extendNumber: (id: string, months: number) =>
    request<TemporaryNumber>(`/api/numbers/${id}/extend`, jsonMutation("POST", { months, confirmed: true })),
  cancelNumberRelease: (id: string) =>
    request<TemporaryNumber>(`/api/numbers/${id}/cancel-release`, jsonMutation("POST", { confirmed: true })),
  updateNumberForwardingEmail: (id: string, forwardingEmail: string) =>
    request<TemporaryNumber>(`/api/numbers/${id}/forwarding-email`, jsonMutation("PUT", { forwardingEmail })),
  releaseNumber: (id: string) =>
    request<TemporaryNumber>(`/api/numbers/${id}/release`, jsonMutation("POST", { confirmed: true })),
  saveSettings: (preferences: Preferences) =>
    request<Preferences>("/api/settings", jsonMutation("PUT", preferences)),
  listTemplates: () => request<{ templates: CoverTemplate[] }>("/api/templates"),
  saveTemplate: (template: Pick<CoverTemplate, "id" | "name" | "data" | "isDefault">) =>
    request<CoverTemplate>("/api/templates", jsonMutation("POST", template)),
  diagnostics: (signal?: AbortSignal) => request<Record<string, unknown>>("/api/diagnostics", { signal }),
  diagnosticBundle: (id: string) => request<Record<string, unknown>>(`/api/faxes/${id}/diagnostics`),
  retryEmail: (id: string) =>
    request<FaxNotification>(`/api/faxes/${id}/retry-email`, jsonMutation("POST", { confirmed: true })),
  simulateIncoming: (toNumber: string, fromNumber: string) =>
    request<{ faxJobId: string }>(
      "/api/demo/incoming",
      jsonMutation("POST", { toNumber, fromNumber }),
    ),
};

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { credentials: "same-origin", ...init });
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as {
      error?: { message?: string; code?: string; correlationId?: string; details?: Record<string, unknown> };
    } | null;
    throw new ApiError(
      payload?.error?.message ?? `Request failed with status ${response.status}.`,
      payload?.error?.code ?? "request_failed",
      payload?.error?.correlationId,
      payload?.error?.details,
    );
  }
  return (await response.json()) as T;
}

function jsonMutation(method: "POST" | "PUT", body: unknown): RequestInit {
  return {
    method,
    headers: { "Content-Type": "application/json", "X-Family-Fax-Request": "1" },
    body: JSON.stringify(body),
  };
}
