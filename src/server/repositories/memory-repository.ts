import type {
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
import type {
  ContentToken,
  CoverTemplate,
  FaxListOptions,
  FaxNotificationPatch,
  Repository,
  TemporaryNumberPatch,
} from "./types";

const copy = <T>(value: T): T => structuredClone(value);

export class MemoryRepository implements Repository {
  private readonly faxJobs = new Map<string, FaxJob>();
  private readonly faxNotifications = new Map<string, FaxNotification>();
  private readonly numbers = new Map<string, TemporaryNumber>();
  private readonly documents = new Map<string, FaxDocument>();
  private readonly events = new Map<string, FaxEvent>();
  private readonly webhooks = new Set<string>();
  private readonly contentTokens = new Map<string, ContentToken>();
  private readonly settings = new Map<string, unknown>();
  private readonly coverTemplates = new Map<string, CoverTemplate>();

  async health(): Promise<{ ok: boolean; detail: string }> {
    return { ok: true, detail: "Memory database is ready." };
  }

  async createFaxJob(job: FaxJob): Promise<void> {
    if (this.faxJobs.has(job.id)) throw new Error(`Fax job already exists: ${job.id}`);
    this.faxJobs.set(job.id, copy(job));
  }

  async getFaxJob(id: string): Promise<FaxJob | null> {
    const value = this.faxJobs.get(id);
    return value ? copy(value) : null;
  }

  async getFaxJobByProviderId(providerFaxId: string): Promise<FaxJob | null> {
    const value = [...this.faxJobs.values()].find((job) => job.providerFaxId === providerFaxId);
    return value ? copy(value) : null;
  }

  async listFaxJobs({ search, limit }: FaxListOptions): Promise<FaxJob[]> {
    const needle = search?.toLowerCase();
    return [...this.faxJobs.values()]
      .filter((job) =>
        !needle
          ? true
          : [job.id, job.toNumber, job.fromNumber, job.providerFaxId]
              .filter(Boolean)
              .some((value) => value!.toLowerCase().includes(needle)),
      )
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, limit)
      .map(copy);
  }

  async listStuckFaxJobs(before: string): Promise<FaxJob[]> {
    return [...this.faxJobs.values()]
      .filter(
        (job) =>
          job.updatedAt <= before &&
          ["submitted", "sending", "status_unknown"].includes(job.state) &&
          !(job.state === "status_unknown" && job.failureCode === "ambiguous_submission"),
      )
      .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt))
      .map(copy);
  }

  async updateFaxJob(id: string, patch: Partial<FaxJob>): Promise<FaxJob | null> {
    const current = this.faxJobs.get(id);
    if (!current) return null;
    const updated = {
      ...current,
      ...copy(patch),
      id: current.id,
      correlationId: current.correlationId,
      createdAt: current.createdAt,
    };
    this.faxJobs.set(id, updated);
    return copy(updated);
  }

  async updateFaxJobIfState(
    id: string,
    expected: FaxState,
    patch: Partial<FaxJob>,
  ): Promise<FaxJob | null> {
    const current = this.faxJobs.get(id);
    if (!current || current.state !== expected) return null;
    const updated = {
      ...current,
      ...copy(patch),
      id: current.id,
      correlationId: current.correlationId,
      createdAt: current.createdAt,
    };
    this.faxJobs.set(id, updated);
    return copy(updated);
  }

  async compareAndSetFaxState(id: string, expected: FaxState, next: FaxState, updatedAt: string): Promise<boolean> {
    const current = this.faxJobs.get(id);
    if (!current || current.state !== expected) return false;
    this.faxJobs.set(id, { ...current, state: next, updatedAt });
    return true;
  }

  async createFaxNotification(notification: FaxNotification): Promise<boolean> {
    const key = notificationKey(notification.faxJobId, notification.kind);
    if (this.faxNotifications.has(key)) return false;
    this.faxNotifications.set(key, copy(notification));
    return true;
  }

  async getFaxNotification(
    faxJobId: string,
    kind: FaxNotificationKind,
  ): Promise<FaxNotification | null> {
    const value = this.faxNotifications.get(notificationKey(faxJobId, kind));
    return value ? copy(value) : null;
  }

  async listFaxNotificationsForFax(faxJobId: string): Promise<FaxNotification[]> {
    return [...this.faxNotifications.values()]
      .filter((notification) => notification.faxJobId === faxJobId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map(copy);
  }

  async updateFaxNotificationIfState(
    faxJobId: string,
    kind: FaxNotificationKind,
    expected: FaxNotificationState,
    patch: FaxNotificationPatch,
  ): Promise<FaxNotification | null> {
    const key = notificationKey(faxJobId, kind);
    const current = this.faxNotifications.get(key);
    if (!current || current.state !== expected) return null;
    const updated = {
      ...current,
      ...copy(patch),
    };
    this.faxNotifications.set(key, updated);
    return copy(updated);
  }

  async listStuckFaxNotifications(before: string): Promise<FaxNotification[]> {
    return [...this.faxNotifications.values()]
      .filter((notification) => notification.state === "sending" && notification.updatedAt <= before)
      .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt))
      .map(copy);
  }

  async listFaxNotificationsNeedingAttention(before: string): Promise<FaxNotification[]> {
    return [...this.faxNotifications.values()]
      .filter((notification) =>
        ["failed", "delivery_unknown"].includes(notification.state) ||
        notification.state === "sending" && notification.updatedAt <= before)
      .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt))
      .map(copy);
  }

  async createTemporaryNumber(number: TemporaryNumber): Promise<void> {
    if (this.numbers.has(number.id)) throw new Error(`Temporary number already exists: ${number.id}`);
    if (
      number.providerName &&
      number.mode !== "send-only" &&
      ["requested", "provisioning", "activating", "cleaning"].includes(number.state) &&
      [...this.numbers.values()].some(
        (existing) =>
          existing.providerName === number.providerName &&
          existing.mode !== "send-only" &&
          ["requested", "provisioning", "activating", "cleaning"].includes(existing.state),
      )
    ) {
      throw new Error("A household fax line is already being opened for this provider.");
    }
    this.numbers.set(number.id, copy(number));
  }

  async getTemporaryNumber(id: string): Promise<TemporaryNumber | null> {
    const value = this.numbers.get(id);
    return value ? copy(value) : null;
  }

  async getTemporaryNumberByE164(e164: string): Promise<TemporaryNumber | null> {
    const value = [...this.numbers.values()]
      .filter((number) => number.e164 === e164 && number.state !== "released")
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
    return value ? copy(value) : null;
  }

  async listActiveNumbers(): Promise<TemporaryNumber[]> {
    return [...this.numbers.values()]
      .filter((number) => !["released", "provision_failed"].includes(number.state))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map(copy);
  }

  async listOverdueNumbers(now: string): Promise<TemporaryNumber[]> {
    return [...this.numbers.values()]
      .filter(
        (number) => {
          const deadline = number.releaseAt ?? number.expiresAt;
          return ["active", "expiring", "release_failed"].includes(number.state) &&
            (deadline !== null && deadline <= now ||
              deadline === null && number.state === "release_failed" && number.releasePolicy === "after-send");
        },
      )
      .map(copy);
  }

  async listStuckReleasingNumbers(before: string): Promise<TemporaryNumber[]> {
    return [...this.numbers.values()]
      .filter(
        (number) =>
          number.state === "releasing" &&
          (number.releaseStartedAt ?? number.updatedAt) <= before,
      )
      .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt))
      .map(copy);
  }

  async listStuckNumberRequests(before: string): Promise<TemporaryNumber[]> {
    return [...this.numbers.values()]
      .filter((number) => ["requested", "provisioning", "activating", "cleaning"].includes(number.state) && number.updatedAt <= before)
      .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt))
      .map(copy);
  }

  async listReleasedNumbersNeedingFinalization(): Promise<TemporaryNumber[]> {
    return [...this.numbers.values()]
      .filter((number) => {
        if (number.state !== "released") return false;
        const job = number.faxJobId ? this.faxJobs.get(number.faxJobId) : null;
        const ownerIncomplete = job?.mode === "receive-only" && job.state === "active";
        const releaseRecorded = [...this.events.values()].some(
          (event) =>
            event.temporaryNumberId === number.id &&
            ["number.released", "number.provider_absent"].includes(event.type),
        );
        return ownerIncomplete || !releaseRecorded;
      })
      .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt))
      .map(copy);
  }

  async updateTemporaryNumber(
    id: string,
    patch: TemporaryNumberPatch,
  ): Promise<TemporaryNumber | null> {
    const current = this.numbers.get(id);
    if (!current) return null;
    const updated = { ...current, ...copy(patch), id: current.id, createdAt: current.createdAt };
    this.numbers.set(id, updated);
    return copy(updated);
  }

  async updateTemporaryNumberIfState(
    id: string,
    expected: TemporaryNumberState,
    patch: TemporaryNumberPatch,
  ): Promise<TemporaryNumber | null> {
    const current = this.numbers.get(id);
    if (!current || current.state !== expected) return null;
    const updated = { ...current, ...copy(patch), id: current.id, createdAt: current.createdAt };
    this.numbers.set(id, updated);
    return copy(updated);
  }

  async compareAndSetNumberState(
    id: string,
    expected: TemporaryNumberState,
    next: TemporaryNumberState,
  ): Promise<boolean> {
    const current = this.numbers.get(id);
    if (!current || current.state !== expected) return false;
    this.numbers.set(id, { ...current, state: next });
    return true;
  }

  async createDocument(document: FaxDocument): Promise<void> {
    if (this.documents.has(document.id)) throw new Error(`Document already exists: ${document.id}`);
    this.documents.set(document.id, copy(document));
  }

  async getDocument(id: string): Promise<FaxDocument | null> {
    const value = this.documents.get(id);
    return value ? copy(value) : null;
  }

  async listDocumentsForFax(faxJobId: string): Promise<FaxDocument[]> {
    return [...this.documents.values()]
      .filter((document) => document.faxJobId === faxJobId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map(copy);
  }

  async appendEvent(event: FaxEvent): Promise<void> {
    if (this.events.has(event.id)) throw new Error(`Event already exists: ${event.id}`);
    this.events.set(event.id, copy(event));
  }

  async listEventsForFax(faxJobId: string): Promise<FaxEvent[]> {
    return this.listEvents((event) => event.faxJobId === faxJobId);
  }

  async listEventsForNumber(temporaryNumberId: string): Promise<FaxEvent[]> {
    return this.listEvents((event) => event.temporaryNumberId === temporaryNumberId);
  }

  async listRecentEvents(limit: number): Promise<FaxEvent[]> {
    return [...this.events.values()]
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, limit)
      .map(copy);
  }

  private listEvents(predicate: (event: FaxEvent) => boolean): FaxEvent[] {
    return [...this.events.values()]
      .filter(predicate)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map(copy);
  }

  async claimWebhook(provider: string, eventKey: string, _receivedAt: string): Promise<boolean> {
    const key = JSON.stringify([provider, eventKey]);
    if (this.webhooks.has(key)) return false;
    this.webhooks.add(key);
    return true;
  }

  async releaseWebhookClaim(provider: string, eventKey: string): Promise<void> {
    this.webhooks.delete(JSON.stringify([provider, eventKey]));
  }

  async createContentToken(token: ContentToken): Promise<void> {
    this.contentTokens.set(token.tokenHash, copy(token));
  }

  async getActiveContentToken(tokenHash: string, now: string): Promise<ContentToken | null> {
    const token = this.contentTokens.get(tokenHash);
    if (!token || token.revokedAt || token.expiresAt <= now) return null;
    return copy(token);
  }

  async revokeContentTokensForFax(faxJobId: string, revokedAt: string): Promise<void> {
    for (const [hash, token] of this.contentTokens) {
      if (token.faxJobId === faxJobId && token.revokedAt === null) {
        this.contentTokens.set(hash, { ...token, revokedAt });
      }
    }
  }

  async getSetting<T>(key: string): Promise<T | null> {
    const value = this.settings.get(key);
    return value === undefined ? null : copy(value as T);
  }

  async setSetting<T>(key: string, value: T, _updatedAt: string): Promise<void> {
    this.settings.set(key, copy(value));
  }

  async listCoverTemplates(): Promise<CoverTemplate[]> {
    return [...this.coverTemplates.values()]
      .sort((left, right) => Number(right.isDefault) - Number(left.isDefault) || left.name.localeCompare(right.name))
      .map(copy);
  }

  async upsertCoverTemplate(template: CoverTemplate): Promise<void> {
    if (template.isDefault) {
      for (const [id, current] of this.coverTemplates) {
        this.coverTemplates.set(id, { ...current, isDefault: false });
      }
    }
    this.coverTemplates.set(template.id, copy(template));
  }
}

function notificationKey(faxJobId: string, kind: FaxNotificationKind): string {
  return JSON.stringify([faxJobId, kind]);
}
