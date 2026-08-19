import { describe, expect, it, vi } from "vitest";

import { FixedClock } from "../../domain/clock";
import { MemoryRepository } from "../repositories/memory-repository";
import { MemoryDocumentStore } from "../storage/document-store";
import { AuditService } from "./audit-service";

describe("AuditService", () => {
  it("persists the audit event when optional raw diagnostic storage is unavailable", async () => {
    const repository = new MemoryRepository();
    const documents = new MemoryDocumentStore();
    const service = new AuditService(
      repository,
      documents,
      new FixedClock(new Date("2026-08-16T12:00:00.000Z")),
      () => "event-storage-failure",
    );
    vi.spyOn(documents, "put").mockRejectedValueOnce(new Error("diagnostic storage unavailable"));

    const event = await service.record({
      correlationId: "correlation-1",
      source: "provider",
      type: "fax.delivered",
      rawPayload: { providerFaxId: "fax-1" },
    });

    expect(event.rawPayloadKey).toBeNull();
    expect(event.details).toMatchObject({
      diagnosticPayloadStorage: { stored: false, error: "diagnostic storage unavailable" },
    });
    expect(await repository.listRecentEvents(10)).toContainEqual(event);
  });

  it("keeps full fax diagnostics while excluding credentials", async () => {
    const repository = new MemoryRepository();
    const documents = new MemoryDocumentStore();
    const service = new AuditService(
      repository,
      documents,
      new FixedClock(new Date("2026-08-16T12:00:00.000Z")),
      () => "event-1",
    );

    const event = await service.record({
      correlationId: "correlation-1",
      source: "provider",
      type: "fax.submitted",
      details: {
        from: "+12025550100",
        to: "+12025550123",
        authorization: "Bearer never-store-this",
      },
      rawPayload: {
        faxId: "fax-1",
        recipient: { name: "Clinic", number: "+12025550123" },
        callbackUrl: "https://webhook-user:webhook-password@events.example.com/webhooks/sinch",
        queueUri: "amqp://queue-user:queue-password@queue.example.com/faxes",
        providerMessage: "Request rejected. Authorization: Bearer never-store-this",
        contentUrl: "https://fax.example.com/provider-content/private-document-token",
        headers: { Authorization: "Bearer never-store-this", Cookie: "session=never-store-this" },
        accessToken: "never-store-this",
      },
    });

    expect(event.details).toEqual({
      from: "+12025550100",
      to: "+12025550123",
      authorization: "[secret omitted]",
    });
    const object = await documents.get(event.rawPayloadKey!);
    const stored = await new Response(object!.body).json();
    expect(stored).toEqual({
      faxId: "fax-1",
      recipient: { name: "Clinic", number: "+12025550123" },
      callbackUrl: "https://events.example.com/webhooks/sinch",
      queueUri: "amqp://queue.example.com/faxes",
      providerMessage: "Request rejected. Authorization: [secret omitted]",
      contentUrl: "https://fax.example.com/provider-content/[secret%20omitted]",
      headers: { Authorization: "[secret omitted]", Cookie: "[secret omitted]" },
      accessToken: "[secret omitted]",
    });
    expect(JSON.stringify(stored)).not.toContain("never-store-this");
    expect(JSON.stringify(stored)).not.toContain("webhook-password");
    expect(JSON.stringify(stored)).not.toContain("queue-password");
  });
});
