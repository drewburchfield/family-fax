import type {
  CoverSheetData,
  FaxDocument,
  FaxEvent,
  FaxJob,
  FaxNotification,
  FaxNotificationKind,
  FaxNotificationState,
  FaxState,
  TemporaryNumber,
  TemporaryNumberState,
} from "../../shared/contracts";

export interface ContentToken {
  tokenHash: string;
  faxJobId: string;
  documentId: string;
  expiresAt: string;
  revokedAt: string | null;
  createdAt: string;
}

export interface CoverTemplate {
  id: string;
  name: string;
  data: CoverSheetData;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface FaxListOptions {
  search?: string;
  limit: number;
}

export type FaxNotificationPatch = Partial<
  Omit<FaxNotification, "faxJobId" | "kind" | "destinationEmail" | "createdAt">
>;

export type TemporaryNumberPatch = Partial<
  Omit<TemporaryNumber, "id" | "faxJobId" | "providerName" | "mode" | "areaCode" | "createdAt">
>;

export interface Repository {
  health(): Promise<{ ok: boolean; detail: string }>;
  createFaxJob(job: FaxJob): Promise<void>;
  getFaxJob(id: string): Promise<FaxJob | null>;
  getFaxJobByProviderId(providerFaxId: string): Promise<FaxJob | null>;
  listFaxJobs(options: FaxListOptions): Promise<FaxJob[]>;
  listStuckFaxJobs(before: string): Promise<FaxJob[]>;
  updateFaxJob(id: string, patch: Partial<FaxJob>): Promise<FaxJob | null>;
  updateFaxJobIfState(
    id: string,
    expected: FaxState,
    patch: Partial<FaxJob>,
  ): Promise<FaxJob | null>;
  compareAndSetFaxState(id: string, expected: FaxState, next: FaxState, updatedAt: string): Promise<boolean>;

  createFaxNotification(notification: FaxNotification): Promise<boolean>;
  getFaxNotification(faxJobId: string, kind: FaxNotificationKind): Promise<FaxNotification | null>;
  listFaxNotificationsForFax(faxJobId: string): Promise<FaxNotification[]>;
  updateFaxNotificationIfState(
    faxJobId: string,
    kind: FaxNotificationKind,
    expected: FaxNotificationState,
    patch: FaxNotificationPatch,
  ): Promise<FaxNotification | null>;
  listStuckFaxNotifications(before: string): Promise<FaxNotification[]>;
  listFaxNotificationsNeedingAttention(before: string): Promise<FaxNotification[]>;

  createTemporaryNumber(number: TemporaryNumber): Promise<void>;
  getTemporaryNumber(id: string): Promise<TemporaryNumber | null>;
  getTemporaryNumberByE164(e164: string): Promise<TemporaryNumber | null>;
  listActiveNumbers(): Promise<TemporaryNumber[]>;
  listOverdueNumbers(now: string): Promise<TemporaryNumber[]>;
  listStuckReleasingNumbers(before: string): Promise<TemporaryNumber[]>;
  listStuckNumberRequests(before: string): Promise<TemporaryNumber[]>;
  listReleasedNumbersNeedingFinalization(): Promise<TemporaryNumber[]>;
  updateTemporaryNumber(id: string, patch: TemporaryNumberPatch): Promise<TemporaryNumber | null>;
  updateTemporaryNumberIfState(
    id: string,
    expected: TemporaryNumberState,
    patch: TemporaryNumberPatch,
  ): Promise<TemporaryNumber | null>;
  compareAndSetNumberState(
    id: string,
    expected: TemporaryNumberState,
    next: TemporaryNumberState,
  ): Promise<boolean>;

  createDocument(document: FaxDocument): Promise<void>;
  getDocument(id: string): Promise<FaxDocument | null>;
  listDocumentsForFax(faxJobId: string): Promise<FaxDocument[]>;

  appendEvent(event: FaxEvent): Promise<void>;
  listEventsForFax(faxJobId: string): Promise<FaxEvent[]>;
  listEventsForNumber(temporaryNumberId: string): Promise<FaxEvent[]>;
  listRecentEvents(limit: number): Promise<FaxEvent[]>;

  claimWebhook(provider: string, eventKey: string, receivedAt: string): Promise<boolean>;
  releaseWebhookClaim(provider: string, eventKey: string): Promise<void>;
  createContentToken(token: ContentToken): Promise<void>;
  getActiveContentToken(tokenHash: string, now: string): Promise<ContentToken | null>;
  revokeContentTokensForFax(faxJobId: string, revokedAt: string): Promise<void>;

  getSetting<T>(key: string): Promise<T | null>;
  setSetting<T>(key: string, value: T, updatedAt: string): Promise<void>;
  listCoverTemplates(): Promise<CoverTemplate[]>;
  upsertCoverTemplate(template: CoverTemplate): Promise<void>;
}
