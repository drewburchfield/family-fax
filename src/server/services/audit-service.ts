import type { Clock } from "../../domain/clock";
import { sha256Hex } from "../../domain/crypto";
import type { AuditSource, FaxEvent } from "../../shared/contracts";
import type { Repository } from "../repositories/types";
import type { DocumentStore } from "../storage/document-store";

export interface AuditInput {
  correlationId: string;
  faxJobId?: string | null;
  temporaryNumberId?: string | null;
  source: AuditSource;
  type: string;
  resultingState?: string | null;
  attempt?: number | null;
  durationMs?: number | null;
  details?: Record<string, unknown>;
  rawPayload?: unknown;
}

export class AuditService {
  constructor(
    private readonly repository: Repository,
    private readonly documents: DocumentStore,
    private readonly clock: Clock,
    private readonly idGenerator: () => string = () => crypto.randomUUID(),
  ) {}

  async record(input: AuditInput): Promise<FaxEvent> {
    const id = this.idGenerator();
    const createdAt = this.clock.now().toISOString();
    let rawPayloadKey: string | null = null;
    let diagnosticPayloadStorage: Record<string, unknown> | undefined;
    if (input.rawPayload !== undefined) {
      const content = JSON.stringify(sanitizeDiagnosticValue(input.rawPayload), null, 2);
      rawPayloadKey = `diagnostics/${createdAt.slice(0, 10)}/${id}.json`;
      try {
        await this.documents.put(rawPayloadKey, content, {
          contentType: "application/json",
          sha256: await sha256Hex(content),
          uploadedAt: createdAt,
        });
      } catch (error) {
        rawPayloadKey = null;
        diagnosticPayloadStorage = {
          stored: false,
          error: error instanceof Error ? error.message : "Diagnostic payload storage failed.",
        };
      }
    }
    const event: FaxEvent = {
      id,
      correlationId: input.correlationId,
      faxJobId: input.faxJobId ?? null,
      temporaryNumberId: input.temporaryNumberId ?? null,
      source: input.source,
      type: input.type,
      resultingState: input.resultingState ?? null,
      attempt: input.attempt ?? null,
      durationMs: input.durationMs ?? null,
      details: sanitizeDiagnosticValue({
        ...input.details,
        ...(diagnosticPayloadStorage && { diagnosticPayloadStorage }),
      }) as Record<string, unknown>,
      rawPayloadKey,
      createdAt,
    };
    await this.repository.appendEvent(event);
    return event;
  }
}

const secretKeyPattern = /authorization|cookie|password|passwd|secret|token|api.?key|access.?key|private.?key/i;

export function sanitizeDiagnosticValue(value: unknown, key = ""): unknown {
  if (secretKeyPattern.test(key)) return "[secret omitted]";
  if (typeof value === "string") return sanitizeDiagnosticString(value);
  if (Array.isArray(value)) return value.map((item) => sanitizeDiagnosticValue(item));
  if (value && typeof value === "object") {
    if (value instanceof Date) return value.toISOString();
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entryValue]) => [
        entryKey,
        sanitizeDiagnosticValue(entryValue, entryKey),
      ]),
    );
  }
  return value;
}

function sanitizeDiagnosticString(value: string): string {
  const redacted = value.replace(
    /(\bauthorization\s*[:=]\s*)(?:basic|bearer)\s+[^\s,;]+/gi,
    "$1[secret omitted]",
  );
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(redacted)) return redacted;
  try {
    const url = new URL(redacted);
    url.username = "";
    url.password = "";
    for (const key of url.searchParams.keys()) {
      if (secretKeyPattern.test(key)) url.searchParams.set(key, "[secret omitted]");
    }
    const segments = url.pathname.split("/");
    const contentTokenIndex = segments.indexOf("provider-content");
    if (contentTokenIndex >= 0 && segments[contentTokenIndex + 1]) {
      segments[contentTokenIndex + 1] = "[secret omitted]";
      url.pathname = segments.join("/");
    }
    return url.toString();
  } catch {
    return redacted;
  }
}
