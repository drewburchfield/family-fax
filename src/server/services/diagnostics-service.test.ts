import { describe, expect, it, vi } from "vitest";

import { DemoFaxProvider } from "../../providers/demo-fax-provider";
import type { FaxNotification } from "../../shared/contracts";
import { MemoryRepository } from "../repositories/memory-repository";
import { MemoryDocumentStore } from "../storage/document-store";
import { DiagnosticsService } from "./diagnostics-service";

describe("DiagnosticsService", () => {
  it("returns component failures instead of rejecting when D1 and R2 are unavailable", async () => {
    const repository = new MemoryRepository();
    const documents = new MemoryDocumentStore();
    vi.spyOn(repository, "health").mockRejectedValue(new Error("D1 unavailable"));
    vi.spyOn(documents, "health").mockRejectedValue(new Error("R2 unavailable"));
    const diagnostics = new DiagnosticsService(repository, new DemoFaxProvider(), documents);

    await expect(diagnostics.health()).resolves.toMatchObject({
      ok: false,
      database: { ok: false, detail: "D1 unavailable" },
      storage: { ok: false, detail: "R2 unavailable" },
      activeNumberCount: 0,
    });
  });

  it("returns a provider failure without hiding healthy storage and database checks", async () => {
    const repository = new MemoryRepository();
    const documents = new MemoryDocumentStore();
    const provider = new DemoFaxProvider();
    vi.spyOn(provider, "health").mockRejectedValue(new Error("provider unavailable"));
    const diagnostics = new DiagnosticsService(repository, provider, documents);

    await expect(diagnostics.health()).resolves.toMatchObject({
      ok: false,
      provider: { ok: false, detail: "provider unavailable" },
      database: { ok: true },
      storage: { ok: true },
    });
  });

  it("removes credentials from provider health details", async () => {
    const repository = new MemoryRepository();
    const documents = new MemoryDocumentStore();
    const provider = new DemoFaxProvider();
    vi.spyOn(provider, "health").mockResolvedValue({
      ok: true,
      detail: "Provider is reachable.",
      raw: {
        incomingWebhookUrl: "https://webhook-user:webhook-password@events.example.com/webhooks/sinch",
        accessKeySecret: "never-return-this",
        providerMessage: "Authorization: Bearer never-return-this-either",
      },
    });
    const diagnostics = new DiagnosticsService(repository, provider, documents);

    await expect(diagnostics.health()).resolves.toMatchObject({
      provider: {
        ok: true,
        raw: {
          incomingWebhookUrl: "https://events.example.com/webhooks/sinch",
          accessKeySecret: "[secret omitted]",
          providerMessage: "Authorization: [secret omitted]",
        },
      },
    });
  });

  it("removes credentials from deployment configuration", async () => {
    const repository = new MemoryRepository();
    const documents = new MemoryDocumentStore();
    const diagnostics = new DiagnosticsService(
      repository,
      new DemoFaxProvider(),
      documents,
      {
        version: "test",
        deployment: null,
        configuration: {
          provider: "demo",
          apiToken: "never-return-this",
          nested: { password: "never-return-this-either" },
        },
      },
    );

    await expect(diagnostics.health()).resolves.toMatchObject({
      application: {
        configuration: {
          provider: "demo",
          apiToken: "[secret omitted]",
          nested: { password: "[secret omitted]" },
        },
      },
    });
  });

  it("reports durable failed, uncertain, and stale notification states", async () => {
    const repository = new MemoryRepository();
    const documents = new MemoryDocumentStore();
    for (const item of [
      notification("failed", "fax-failed"),
      notification("delivery_unknown", "fax-unknown"),
      notification("sending", "fax-stale"),
    ]) {
      await repository.createFaxNotification(item);
    }
    const diagnostics = new DiagnosticsService(repository, new DemoFaxProvider(), documents);

    await expect(diagnostics.health()).resolves.toMatchObject({
      ok: false,
      emailDeliveryFailures: 1,
      emailDeliveryUnknown: 1,
      staleEmailDeliveries: 1,
    });
  });
});

function notification(state: FaxNotification["state"], faxJobId: string): FaxNotification {
  return {
    faxJobId,
    kind: "outbound_delivered",
    state,
    destinationEmail: "family@example.com",
    attempt: 1,
    messageId: null,
    attached: null,
    lastError: state === "failed" ? "email unavailable" : null,
    createdAt: "2020-01-01T00:00:00.000Z",
    updatedAt: "2020-01-01T00:00:00.000Z",
    deliveredAt: null,
  };
}
