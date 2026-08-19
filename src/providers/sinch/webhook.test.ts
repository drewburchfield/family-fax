import { describe, expect, it } from "vitest";

import { WebhookAuthError, parseSinchWebhook } from "./webhook";

const credentials = { username: "sinch", password: "secret" };
const authorization = `Basic ${btoa("sinch:secret")}`;

describe("parseSinchWebhook", () => {
  it("authenticates and parses a JSON incoming fax", async () => {
    const request = new Request("https://events.example.com/webhooks/sinch/fax", {
      method: "POST",
      headers: { Authorization: authorization, "Content-Type": "application/json" },
      body: JSON.stringify({
        event: "INCOMING_FAX",
        eventTime: "2026-08-16T12:00:00.000Z",
        fax: {
          id: "fax-1",
          direction: "INBOUND",
          from: "+16155550123",
          to: "+16155550199",
          status: "COMPLETED",
          numberOfPages: 2,
          createTime: "2026-08-16T11:59:00.000Z",
        },
        file: btoa("pdf"),
        fileType: "PDF",
      }),
    });

    const event = await parseSinchWebhook(request, credentials);

    expect(event.type).toBe("incoming");
    expect(event.fax.id).toBe("fax-1");
    expect(event.eventKey).toContain("fax-1");
    expect(event.file?.contentType).toBe("application/pdf");
    expect(event.raw).not.toHaveProperty("file");
  });

  it("parses multipart fax and file fields", async () => {
    const form = new FormData();
    form.set("event", "FAX_COMPLETED");
    form.set("eventTime", "2026-08-16T12:00:00.000Z");
    form.set(
      "fax",
      JSON.stringify({
        id: "fax-2",
        direction: "OUTBOUND",
        from: "+16155550199",
        to: "+16155550123",
        status: "COMPLETED",
        createTime: "2026-08-16T11:59:00.000Z",
      }),
    );
    form.set("file", new Blob(["pdf"], { type: "application/pdf" }), "fax.pdf");
    const request = new Request("https://events.example.com/webhooks/sinch/fax", {
      method: "POST",
      headers: { Authorization: authorization },
      body: form,
    });

    const event = await parseSinchWebhook(request, credentials);

    expect(event.type).toBe("status");
    expect(await new Response(event.file?.body).text()).toBe("pdf");
  });

  it("rejects missing or incorrect Basic credentials", async () => {
    const request = new Request("https://events.example.com/webhooks/sinch/fax", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });

    await expect(parseSinchWebhook(request, credentials)).rejects.toBeInstanceOf(WebhookAuthError);
  });

  it("rejects an authenticated but unsupported event", async () => {
    const request = new Request("https://events.example.com/webhooks/sinch", {
      method: "POST",
      headers: { Authorization: authorization, "Content-Type": "application/json" },
      body: JSON.stringify({
        event: "SERVICE_CHANGED",
        eventTime: "2026-08-16T12:00:00.000Z",
        fax: {
          id: "fax-3",
          direction: "OUTBOUND",
          from: "+12025550100",
          to: "+12025550123",
          status: "COMPLETED",
        },
      }),
    });

    await expect(parseSinchWebhook(request, credentials)).rejects.toThrow(
      "Unsupported Sinch webhook event",
    );
  });
});
