/// <reference types="@cloudflare/workers-types" />

import type {
  CoverSheetData,
  FaxDocument,
  FaxEvent,
  FaxJob,
  FaxNotification,
  FaxNotificationKind,
  FaxNotificationState,
  FaxState,
  Money,
  TemporaryNumber,
  TemporaryNumberState,
} from "../../shared/contracts";
import type {
  ContentToken,
  CoverTemplate,
  FaxListOptions,
  FaxNotificationPatch,
  Repository,
  TemporaryNumberPatch,
} from "./types";

type Row = Record<string, unknown>;

const json = (value: unknown): string | null => (value === null || value === undefined ? null : JSON.stringify(value));
const parseJson = <T>(value: unknown): T | null =>
  typeof value === "string" && value.length > 0 ? (JSON.parse(value) as T) : null;
const text = (row: Row, key: string): string => String(row[key]);
const nullableText = (row: Row, key: string): string | null =>
  row[key] === null || row[key] === undefined ? null : String(row[key]);
const nullableNumber = (row: Row, key: string): number | null =>
  row[key] === null || row[key] === undefined ? null : Number(row[key]);

export function mapFaxJobRow(row: Row): FaxJob {
  return {
    id: text(row, "id"),
    mode: text(row, "mode") as FaxJob["mode"],
    direction: text(row, "direction") as FaxJob["direction"],
    state: text(row, "state") as FaxState,
    toNumber: nullableText(row, "to_number"),
    fromNumber: nullableText(row, "from_number"),
    providerFaxId: nullableText(row, "provider_fax_id"),
    providerProjectId: nullableText(row, "provider_project_id"),
    temporaryNumberId: nullableText(row, "temporary_number_id"),
    correlationId: text(row, "correlation_id"),
    finalDocumentId: nullableText(row, "final_document_id"),
    pageCount: nullableNumber(row, "page_count"),
    estimatedCost: parseJson<Money>(row.estimated_cost_json),
    reportedCost: parseJson<Money>(row.reported_cost_json),
    requestedTtlDays: nullableNumber(row, "requested_ttl_days"),
    requestedRentalMonths: nullableNumber(row, "requested_rental_months"),
    coverData: parseJson<CoverSheetData>(row.cover_data_json),
    failureCode: nullableText(row, "failure_code"),
    failureMessage: nullableText(row, "failure_message"),
    createdAt: text(row, "created_at"),
    updatedAt: text(row, "updated_at"),
    submittedAt: nullableText(row, "submitted_at"),
    completedAt: nullableText(row, "completed_at"),
  };
}

export function mapTemporaryNumberRow(row: Row): TemporaryNumber {
  const providerName = nullableText(row, "provider_name");
  const releasePolicy = nullableText(row, "release_policy");
  return {
    id: text(row, "id"),
    faxJobId: nullableText(row, "fax_job_id"),
    e164: nullableText(row, "e164"),
    areaCode: text(row, "area_code"),
    providerId: nullableText(row, "provider_id"),
    ...(providerName === "demo" || providerName === "sinch" || providerName === "signalwire"
      ? { providerName }
      : {}),
    state: text(row, "state") as TemporaryNumberState,
    mode: text(row, "mode") as TemporaryNumber["mode"],
    forwardingEmail: text(row, "forwarding_email"),
    setupPrice: parseJson<Money>(row.setup_price_json),
    monthlyPrice: parseJson<Money>(row.monthly_price_json),
    provisionedAt: nullableText(row, "provisioned_at"),
    earliestProviderReleaseAt: nullableText(row, "earliest_provider_release_at"),
    releasePolicy: releasePolicy === "after-send" || releasePolicy === "manual" ? releasePolicy : "scheduled",
    rentalMonths: nullableNumber(row, "rental_months"),
    nextBilledAt: nullableText(row, "next_billed_at"),
    releaseAt: nullableText(row, "release_at") ?? nullableText(row, "expires_at"),
    expiresAt: nullableText(row, "expires_at"),
    releaseStartedAt: nullableText(row, "release_started_at"),
    releasedAt: nullableText(row, "released_at"),
    workflowId: nullableText(row, "workflow_id"),
    createdAt: text(row, "created_at"),
    updatedAt: text(row, "updated_at"),
  };
}

export function mapFaxNotificationRow(row: Row): FaxNotification {
  const attached = row.attached;
  return {
    faxJobId: text(row, "fax_job_id"),
    kind: text(row, "kind") as FaxNotificationKind,
    state: text(row, "state") as FaxNotificationState,
    destinationEmail: text(row, "destination_email"),
    attempt: Number(row.attempt),
    messageId: nullableText(row, "message_id"),
    attached: attached === null || attached === undefined ? null : Number(attached) === 1,
    lastError: nullableText(row, "last_error"),
    createdAt: text(row, "created_at"),
    updatedAt: text(row, "updated_at"),
    deliveredAt: nullableText(row, "delivered_at"),
  };
}

function mapDocumentRow(row: Row): FaxDocument {
  return {
    id: text(row, "id"),
    faxJobId: nullableText(row, "fax_job_id"),
    temporaryNumberId: nullableText(row, "temporary_number_id"),
    kind: text(row, "kind") as FaxDocument["kind"],
    objectKey: text(row, "object_key"),
    mimeType: text(row, "mime_type"),
    byteCount: Number(row.byte_count),
    pageCount: nullableNumber(row, "page_count"),
    sha256: text(row, "sha256"),
    displayName: text(row, "display_name"),
    createdAt: text(row, "created_at"),
  };
}

function mapEventRow(row: Row): FaxEvent {
  return {
    id: text(row, "id"),
    correlationId: text(row, "correlation_id"),
    faxJobId: nullableText(row, "fax_job_id"),
    temporaryNumberId: nullableText(row, "temporary_number_id"),
    source: text(row, "source") as FaxEvent["source"],
    type: text(row, "type"),
    resultingState: nullableText(row, "resulting_state"),
    attempt: nullableNumber(row, "attempt"),
    durationMs: nullableNumber(row, "duration_ms"),
    details: parseJson<Record<string, unknown>>(row.details_json) ?? {},
    rawPayloadKey: nullableText(row, "raw_payload_key"),
    createdAt: text(row, "created_at"),
  };
}

function mapContentTokenRow(row: Row): ContentToken {
  return {
    tokenHash: text(row, "token_hash"),
    faxJobId: text(row, "fax_job_id"),
    documentId: text(row, "document_id"),
    expiresAt: text(row, "expires_at"),
    revokedAt: nullableText(row, "revoked_at"),
    createdAt: text(row, "created_at"),
  };
}

const faxPatchColumns: Partial<Record<keyof FaxJob, string>> = {
  mode: "mode",
  direction: "direction",
  state: "state",
  toNumber: "to_number",
  fromNumber: "from_number",
  providerFaxId: "provider_fax_id",
  providerProjectId: "provider_project_id",
  temporaryNumberId: "temporary_number_id",
  finalDocumentId: "final_document_id",
  pageCount: "page_count",
  estimatedCost: "estimated_cost_json",
  reportedCost: "reported_cost_json",
  requestedTtlDays: "requested_ttl_days",
  requestedRentalMonths: "requested_rental_months",
  coverData: "cover_data_json",
  failureCode: "failure_code",
  failureMessage: "failure_message",
  updatedAt: "updated_at",
  submittedAt: "submitted_at",
  completedAt: "completed_at",
};

const numberPatchColumns: Partial<Record<keyof TemporaryNumber, string>> = {
  faxJobId: "fax_job_id",
  e164: "e164",
  areaCode: "area_code",
  providerId: "provider_id",
  providerName: "provider_name",
  state: "state",
  mode: "mode",
  forwardingEmail: "forwarding_email",
  setupPrice: "setup_price_json",
  monthlyPrice: "monthly_price_json",
  provisionedAt: "provisioned_at",
  earliestProviderReleaseAt: "earliest_provider_release_at",
  releasePolicy: "release_policy",
  rentalMonths: "rental_months",
  nextBilledAt: "next_billed_at",
  releaseAt: "release_at",
  expiresAt: "expires_at",
  releaseStartedAt: "release_started_at",
  releasedAt: "released_at",
  workflowId: "workflow_id",
  updatedAt: "updated_at",
};

const notificationPatchColumns: Partial<Record<keyof FaxNotification, string>> = {
  state: "state",
  destinationEmail: "destination_email",
  attempt: "attempt",
  messageId: "message_id",
  attached: "attached",
  lastError: "last_error",
  updatedAt: "updated_at",
  deliveredAt: "delivered_at",
};

function patchValue(key: string, value: unknown): unknown {
  if (key === "attached") return value === null ? null : value ? 1 : 0;
  return ["estimatedCost", "reportedCost", "coverData", "setupPrice", "monthlyPrice"].includes(key)
    ? json(value)
    : value;
}

export class D1Repository implements Repository {
  constructor(private readonly db: D1Database) {}

  async health(): Promise<{ ok: boolean; detail: string }> {
    const row = await this.db.prepare("SELECT 1 AS ok").first<{ ok: number }>();
    if (row?.ok !== 1) throw new Error("D1 health probe returned an unexpected result.");
    return { ok: true, detail: "D1 binding is reachable." };
  }

  async createFaxJob(job: FaxJob): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO fax_jobs (
          id, mode, direction, state, to_number, from_number, provider_fax_id,
          provider_project_id, temporary_number_id, correlation_id, final_document_id,
          page_count, estimated_cost_json, reported_cost_json, requested_ttl_days, requested_rental_months,
          cover_data_json, failure_code, failure_message, created_at, updated_at,
          submitted_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        job.id,
        job.mode,
        job.direction,
        job.state,
        job.toNumber,
        job.fromNumber,
        job.providerFaxId,
        job.providerProjectId,
        job.temporaryNumberId,
        job.correlationId,
        job.finalDocumentId,
        job.pageCount,
        json(job.estimatedCost),
        json(job.reportedCost),
        job.requestedTtlDays,
        job.requestedRentalMonths ?? null,
        json(job.coverData),
        job.failureCode,
        job.failureMessage,
        job.createdAt,
        job.updatedAt,
        job.submittedAt,
        job.completedAt,
      )
      .run();
  }

  async getFaxJob(id: string): Promise<FaxJob | null> {
    const row = await this.db.prepare("SELECT * FROM fax_jobs WHERE id = ?").bind(id).first<Row>();
    return row ? mapFaxJobRow(row) : null;
  }

  async getFaxJobByProviderId(providerFaxId: string): Promise<FaxJob | null> {
    const row = await this.db
      .prepare("SELECT * FROM fax_jobs WHERE provider_fax_id = ?")
      .bind(providerFaxId)
      .first<Row>();
    return row ? mapFaxJobRow(row) : null;
  }

  async listFaxJobs({ search, limit }: FaxListOptions): Promise<FaxJob[]> {
    const query = search
      ? `SELECT * FROM fax_jobs
         WHERE id LIKE ? OR to_number LIKE ? OR from_number LIKE ? OR provider_fax_id LIKE ?
         ORDER BY created_at DESC LIMIT ?`
      : "SELECT * FROM fax_jobs ORDER BY created_at DESC LIMIT ?";
    const needle = `%${search ?? ""}%`;
    const statement = search
      ? this.db.prepare(query).bind(needle, needle, needle, needle, limit)
      : this.db.prepare(query).bind(limit);
    const result = await statement.all<Row>();
    return result.results.map(mapFaxJobRow);
  }

  async listStuckFaxJobs(before: string): Promise<FaxJob[]> {
    const result = await this.db
      .prepare(
        `SELECT * FROM fax_jobs
         WHERE updated_at <= ?
           AND state IN ('submitted', 'sending', 'status_unknown')
           AND NOT (
             state = 'status_unknown'
             AND COALESCE(failure_code, '') = 'ambiguous_submission'
           )
         ORDER BY updated_at`,
      )
      .bind(before)
      .all<Row>();
    return result.results.map(mapFaxJobRow);
  }

  async updateFaxJob(id: string, patch: Partial<FaxJob>): Promise<FaxJob | null> {
    await this.applyPatch("fax_jobs", id, patch, faxPatchColumns);
    return this.getFaxJob(id);
  }

  async updateFaxJobIfState(
    id: string,
    expected: FaxState,
    patch: Partial<FaxJob>,
  ): Promise<FaxJob | null> {
    const values: unknown[] = [];
    const assignments: string[] = [];
    for (const [key, value] of Object.entries(patch) as [keyof FaxJob & string, unknown][]) {
      if (value === undefined) continue;
      const column = faxPatchColumns[key];
      if (!column) continue;
      assignments.push(`${column} = ?`);
      values.push(patchValue(key, value));
    }
    if (assignments.length === 0) return null;
    const result = await this.db
      .prepare(`UPDATE fax_jobs SET ${assignments.join(", ")} WHERE id = ? AND state = ?`)
      .bind(...values, id, expected)
      .run();
    if ((result.meta.changes ?? 0) !== 1) return null;
    return this.getFaxJob(id);
  }

  async compareAndSetFaxState(id: string, expected: FaxState, next: FaxState, updatedAt: string): Promise<boolean> {
    const result = await this.db
      .prepare("UPDATE fax_jobs SET state = ?, updated_at = ? WHERE id = ? AND state = ?")
      .bind(next, updatedAt, id, expected)
      .run();
    return (result.meta.changes ?? 0) === 1;
  }

  async createFaxNotification(notification: FaxNotification): Promise<boolean> {
    const result = await this.db
      .prepare(
        `INSERT OR IGNORE INTO fax_notifications (
          fax_job_id, kind, state, destination_email, attempt, message_id,
          attached, last_error, created_at, updated_at, delivered_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        notification.faxJobId,
        notification.kind,
        notification.state,
        notification.destinationEmail,
        notification.attempt,
        notification.messageId,
        notification.attached === null ? null : notification.attached ? 1 : 0,
        notification.lastError,
        notification.createdAt,
        notification.updatedAt,
        notification.deliveredAt,
      )
      .run();
    return (result.meta.changes ?? 0) === 1;
  }

  async getFaxNotification(
    faxJobId: string,
    kind: FaxNotificationKind,
  ): Promise<FaxNotification | null> {
    const row = await this.db
      .prepare("SELECT * FROM fax_notifications WHERE fax_job_id = ? AND kind = ?")
      .bind(faxJobId, kind)
      .first<Row>();
    return row ? mapFaxNotificationRow(row) : null;
  }

  async listFaxNotificationsForFax(faxJobId: string): Promise<FaxNotification[]> {
    const result = await this.db
      .prepare("SELECT * FROM fax_notifications WHERE fax_job_id = ? ORDER BY created_at")
      .bind(faxJobId)
      .all<Row>();
    return result.results.map(mapFaxNotificationRow);
  }

  async updateFaxNotificationIfState(
    faxJobId: string,
    kind: FaxNotificationKind,
    expected: FaxNotificationState,
    patch: FaxNotificationPatch,
  ): Promise<FaxNotification | null> {
    const values: unknown[] = [];
    const assignments: string[] = [];
    for (const [key, value] of Object.entries(patch) as [keyof FaxNotificationPatch & string, unknown][]) {
      if (value === undefined) continue;
      const column = notificationPatchColumns[key];
      if (!column) continue;
      assignments.push(`${column} = ?`);
      values.push(patchValue(key, value));
    }
    if (assignments.length === 0) return null;
    const result = await this.db
      .prepare(
        `UPDATE fax_notifications SET ${assignments.join(", ")}
         WHERE fax_job_id = ? AND kind = ? AND state = ?`,
      )
      .bind(...values, faxJobId, kind, expected)
      .run();
    if ((result.meta.changes ?? 0) !== 1) return null;
    return this.getFaxNotification(faxJobId, kind);
  }

  async listStuckFaxNotifications(before: string): Promise<FaxNotification[]> {
    const result = await this.db
      .prepare(
        `SELECT * FROM fax_notifications
         WHERE state = 'sending' AND updated_at <= ?
         ORDER BY updated_at`,
      )
      .bind(before)
      .all<Row>();
    return result.results.map(mapFaxNotificationRow);
  }

  async listFaxNotificationsNeedingAttention(before: string): Promise<FaxNotification[]> {
    const result = await this.db
      .prepare(
        `SELECT * FROM fax_notifications
         WHERE state IN ('failed', 'delivery_unknown')
            OR (state = 'sending' AND updated_at <= ?)
         ORDER BY updated_at`,
      )
      .bind(before)
      .all<Row>();
    return result.results.map(mapFaxNotificationRow);
  }

  async createTemporaryNumber(number: TemporaryNumber): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO temporary_numbers (
          id, fax_job_id, e164, area_code, provider_id, provider_name, state, mode, forwarding_email,
          setup_price_json, monthly_price_json, provisioned_at, earliest_provider_release_at,
          release_policy, rental_months,
          next_billed_at, release_at, expires_at,
          release_started_at, released_at, workflow_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        number.id,
        number.faxJobId,
        number.e164,
        number.areaCode,
        number.providerId,
        number.providerName ?? null,
        number.state,
        number.mode,
        number.forwardingEmail,
        json(number.setupPrice),
        json(number.monthlyPrice),
        number.provisionedAt,
        number.earliestProviderReleaseAt,
        number.releasePolicy ?? "scheduled",
        number.rentalMonths ?? null,
        number.nextBilledAt ?? null,
        number.releaseAt ?? number.expiresAt,
        number.expiresAt,
        number.releaseStartedAt,
        number.releasedAt,
        number.workflowId,
        number.createdAt,
        number.updatedAt,
      )
      .run();
  }

  async getTemporaryNumber(id: string): Promise<TemporaryNumber | null> {
    const row = await this.db.prepare("SELECT * FROM temporary_numbers WHERE id = ?").bind(id).first<Row>();
    return row ? mapTemporaryNumberRow(row) : null;
  }

  async getTemporaryNumberByE164(e164: string): Promise<TemporaryNumber | null> {
    const row = await this.db
      .prepare("SELECT * FROM temporary_numbers WHERE e164 = ? AND state != 'released' ORDER BY created_at DESC LIMIT 1")
      .bind(e164)
      .first<Row>();
    return row ? mapTemporaryNumberRow(row) : null;
  }

  async listActiveNumbers(): Promise<TemporaryNumber[]> {
    const result = await this.db
      .prepare("SELECT * FROM temporary_numbers WHERE state NOT IN ('released', 'provision_failed') ORDER BY created_at")
      .all<Row>();
    return result.results.map(mapTemporaryNumberRow);
  }

  async listOverdueNumbers(now: string): Promise<TemporaryNumber[]> {
    const result = await this.db
      .prepare(
        `SELECT * FROM temporary_numbers
         WHERE state IN ('active', 'expiring', 'release_failed')
           AND (
             COALESCE(release_at, expires_at) <= ?
             OR (
               COALESCE(release_at, expires_at) IS NULL
               AND state = 'release_failed'
               AND release_policy = 'after-send'
             )
           )
         ORDER BY COALESCE(release_at, expires_at, updated_at)`,
      )
      .bind(now)
      .all<Row>();
    return result.results.map(mapTemporaryNumberRow);
  }

  async listStuckReleasingNumbers(before: string): Promise<TemporaryNumber[]> {
    const result = await this.db
      .prepare(
        "SELECT * FROM temporary_numbers WHERE COALESCE(release_started_at, updated_at) <= ? AND state = 'releasing' ORDER BY COALESCE(release_started_at, updated_at)",
      )
      .bind(before)
      .all<Row>();
    return result.results.map(mapTemporaryNumberRow);
  }

  async listStuckNumberRequests(before: string): Promise<TemporaryNumber[]> {
    const result = await this.db
      .prepare(
        "SELECT * FROM temporary_numbers WHERE updated_at <= ? AND state IN ('requested', 'provisioning', 'activating', 'cleaning') ORDER BY updated_at",
      )
      .bind(before)
      .all<Row>();
    return result.results.map(mapTemporaryNumberRow);
  }

  async listReleasedNumbersNeedingFinalization(): Promise<TemporaryNumber[]> {
    const result = await this.db
      .prepare(
        `SELECT n.* FROM temporary_numbers n
         LEFT JOIN fax_jobs f ON f.id = n.fax_job_id
         WHERE n.state = 'released'
           AND (
             (f.mode = 'receive-only' AND f.state = 'active')
             OR NOT EXISTS (
               SELECT 1 FROM fax_events e
               WHERE e.temporary_number_id = n.id
                 AND e.type IN ('number.released', 'number.provider_absent')
             )
           )
         ORDER BY n.updated_at`,
      )
      .all<Row>();
    return result.results.map(mapTemporaryNumberRow);
  }

  async updateTemporaryNumber(
    id: string,
    patch: TemporaryNumberPatch,
  ): Promise<TemporaryNumber | null> {
    await this.applyPatch("temporary_numbers", id, patch, numberPatchColumns);
    return this.getTemporaryNumber(id);
  }

  async updateTemporaryNumberIfState(
    id: string,
    expected: TemporaryNumberState,
    patch: TemporaryNumberPatch,
  ): Promise<TemporaryNumber | null> {
    const values: unknown[] = [];
    const assignments: string[] = [];
    for (const [key, value] of Object.entries(patch) as [keyof TemporaryNumber & string, unknown][]) {
      if (value === undefined) continue;
      const column = numberPatchColumns[key];
      if (!column) continue;
      assignments.push(`${column} = ?`);
      values.push(patchValue(key, value));
    }
    if (assignments.length === 0) return null;
    const result = await this.db
      .prepare(`UPDATE temporary_numbers SET ${assignments.join(", ")} WHERE id = ? AND state = ?`)
      .bind(...values, id, expected)
      .run();
    return (result.meta.changes ?? 0) === 1 ? this.getTemporaryNumber(id) : null;
  }

  async compareAndSetNumberState(
    id: string,
    expected: TemporaryNumberState,
    next: TemporaryNumberState,
  ): Promise<boolean> {
    const result = await this.db
      .prepare("UPDATE temporary_numbers SET state = ? WHERE id = ? AND state = ?")
      .bind(next, id, expected)
      .run();
    return (result.meta.changes ?? 0) === 1;
  }

  async createDocument(document: FaxDocument): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO fax_documents (
          id, fax_job_id, temporary_number_id, kind, object_key, mime_type,
          byte_count, page_count, sha256, display_name, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        document.id,
        document.faxJobId,
        document.temporaryNumberId,
        document.kind,
        document.objectKey,
        document.mimeType,
        document.byteCount,
        document.pageCount,
        document.sha256,
        document.displayName,
        document.createdAt,
      )
      .run();
  }

  async getDocument(id: string): Promise<FaxDocument | null> {
    const row = await this.db.prepare("SELECT * FROM fax_documents WHERE id = ?").bind(id).first<Row>();
    return row ? mapDocumentRow(row) : null;
  }

  async listDocumentsForFax(faxJobId: string): Promise<FaxDocument[]> {
    const result = await this.db
      .prepare("SELECT * FROM fax_documents WHERE fax_job_id = ? ORDER BY created_at")
      .bind(faxJobId)
      .all<Row>();
    return result.results.map(mapDocumentRow);
  }

  async appendEvent(event: FaxEvent): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO fax_events (
          id, correlation_id, fax_job_id, temporary_number_id, source, type,
          resulting_state, attempt, duration_ms, details_json, raw_payload_key, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        event.id,
        event.correlationId,
        event.faxJobId,
        event.temporaryNumberId,
        event.source,
        event.type,
        event.resultingState,
        event.attempt,
        event.durationMs,
        JSON.stringify(event.details),
        event.rawPayloadKey,
        event.createdAt,
      )
      .run();
  }

  async listEventsForFax(faxJobId: string): Promise<FaxEvent[]> {
    return this.listEvents("fax_job_id", faxJobId);
  }

  async listEventsForNumber(temporaryNumberId: string): Promise<FaxEvent[]> {
    return this.listEvents("temporary_number_id", temporaryNumberId);
  }

  async listRecentEvents(limit: number): Promise<FaxEvent[]> {
    const result = await this.db
      .prepare("SELECT * FROM fax_events ORDER BY created_at DESC LIMIT ?")
      .bind(limit)
      .all<Row>();
    return result.results.map(mapEventRow);
  }

  private async listEvents(column: "fax_job_id" | "temporary_number_id", id: string): Promise<FaxEvent[]> {
    const result = await this.db
      .prepare(`SELECT * FROM fax_events WHERE ${column} = ? ORDER BY created_at`)
      .bind(id)
      .all<Row>();
    return result.results.map(mapEventRow);
  }

  async claimWebhook(provider: string, eventKey: string, receivedAt: string): Promise<boolean> {
    const result = await this.db
      .prepare("INSERT OR IGNORE INTO webhook_receipts (provider, event_key, received_at) VALUES (?, ?, ?)")
      .bind(provider, eventKey, receivedAt)
      .run();
    return (result.meta.changes ?? 0) === 1;
  }

  async releaseWebhookClaim(provider: string, eventKey: string): Promise<void> {
    await this.db
      .prepare("DELETE FROM webhook_receipts WHERE provider = ? AND event_key = ?")
      .bind(provider, eventKey)
      .run();
  }

  async createContentToken(token: ContentToken): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO provider_content_tokens
         (token_hash, fax_job_id, document_id, expires_at, revoked_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        token.tokenHash,
        token.faxJobId,
        token.documentId,
        token.expiresAt,
        token.revokedAt,
        token.createdAt,
      )
      .run();
  }

  async getActiveContentToken(tokenHash: string, now: string): Promise<ContentToken | null> {
    const row = await this.db
      .prepare(
        "SELECT * FROM provider_content_tokens WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?",
      )
      .bind(tokenHash, now)
      .first<Row>();
    return row ? mapContentTokenRow(row) : null;
  }

  async revokeContentTokensForFax(faxJobId: string, revokedAt: string): Promise<void> {
    await this.db
      .prepare("UPDATE provider_content_tokens SET revoked_at = ? WHERE fax_job_id = ? AND revoked_at IS NULL")
      .bind(revokedAt, faxJobId)
      .run();
  }

  async getSetting<T>(key: string): Promise<T | null> {
    const row = await this.db.prepare("SELECT value_json FROM settings WHERE key = ?").bind(key).first<Row>();
    return row ? parseJson<T>(row.value_json) : null;
  }

  async setSetting<T>(key: string, value: T, updatedAt: string): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
      )
      .bind(key, JSON.stringify(value), updatedAt)
      .run();
  }

  async listCoverTemplates(): Promise<CoverTemplate[]> {
    const result = await this.db
      .prepare("SELECT * FROM cover_templates ORDER BY is_default DESC, name")
      .all<Row>();
    return result.results.map((row) => ({
      id: text(row, "id"),
      name: text(row, "name"),
      data: parseJson<CoverSheetData>(row.data_json)!,
      isDefault: Number(row.is_default) === 1,
      createdAt: text(row, "created_at"),
      updatedAt: text(row, "updated_at"),
    }));
  }

  async upsertCoverTemplate(template: CoverTemplate): Promise<void> {
    const statements: D1PreparedStatement[] = [];
    if (template.isDefault) {
      statements.push(this.db.prepare("UPDATE cover_templates SET is_default = 0 WHERE is_default = 1"));
    }
    statements.push(
      this.db
        .prepare(
          `INSERT INTO cover_templates (id, name, data_json, is_default, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             name = excluded.name,
             data_json = excluded.data_json,
             is_default = excluded.is_default,
             updated_at = excluded.updated_at`,
        )
        .bind(
          template.id,
          template.name,
          JSON.stringify(template.data),
          template.isDefault ? 1 : 0,
          template.createdAt,
          template.updatedAt,
        ),
    );
    await this.db.batch(statements);
  }

  private async applyPatch<T extends object>(
    table: "fax_jobs" | "temporary_numbers",
    id: string,
    patch: Partial<T>,
    columns: Partial<Record<keyof T, string>>,
  ): Promise<void> {
    const values: unknown[] = [];
    const assignments: string[] = [];
    for (const [key, value] of Object.entries(patch) as [keyof T & string, unknown][]) {
      if (value === undefined) continue;
      const column = columns[key];
      if (!column) continue;
      assignments.push(`${column} = ?`);
      values.push(patchValue(key, value));
    }
    if (assignments.length === 0) return;
    await this.db
      .prepare(`UPDATE ${table} SET ${assignments.join(", ")} WHERE id = ?`)
      .bind(...values, id)
      .run();
  }
}
