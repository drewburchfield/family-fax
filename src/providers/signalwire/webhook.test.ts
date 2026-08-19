import { describe, expect, it } from "vitest";

import { WebhookAuthError } from "../webhook";
import { parseSignalWireFaxWebhook, signalWireReceiveXml } from "./webhook";

const credentials = { username: "signalwire", password: "secret" };
const authorization = `Basic ${btoa("signalwire:secret")}`;

describe("parseSignalWireFaxWebhook", () => {
  it("authenticates and normalizes an inbound form callback", async () => {
    const body = new URLSearchParams({
      FaxSid: "fax-id",
      FaxStatus: "received",
      From: "+16155550123",
      To: "+16155550199",
      NumPages: "2",
      MediaSid: "media-id",
      MediaUrl: "https://family.signalwire.com/media/fax-id.pdf",
    });
    const request = new Request("https://events.example.com/webhooks/signalwire/inbound", {
      method: "POST",
      headers: {
        Authorization: authorization,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    });

    const event = await parseSignalWireFaxWebhook(request, credentials, "inbound");
    const retry = await parseSignalWireFaxWebhook(new Request(
      "https://events.example.com/webhooks/signalwire/inbound",
      {
        method: "POST",
        headers: {
          Authorization: authorization,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body,
      },
    ), credentials, "inbound");

    expect(event).toMatchObject({
      provider: "signalwire",
      type: "incoming",
      fax: {
        id: "fax-id",
        direction: "inbound",
        status: "completed",
        from: "+16155550123",
        to: "+16155550199",
        pageCount: 2,
      },
    });
    expect(event.eventKey).toContain("fax-id");
    expect(retry.eventKey).toBe(event.eventKey);
  });

  it("maps outbound failures with provider error detail", async () => {
    const body = new URLSearchParams({
      FaxSid: "fax-id",
      FaxStatus: "failed",
      From: "+16155550199",
      To: "+16155550123",
      ErrorCode: "32034",
      ErrorMessage: "No answer",
    });
    const request = new Request("https://events.example.com/webhooks/signalwire/fax", {
      method: "POST",
      headers: {
        Authorization: authorization,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    });

    const event = await parseSignalWireFaxWebhook(request, credentials, "outbound");

    expect(event).toMatchObject({
      type: "status",
      fax: { status: "failure", errorCode: "32034", errorMessage: "No answer" },
    });
  });

  it("rejects missing Basic credentials before parsing the body", async () => {
    const request = new Request("https://events.example.com/webhooks/signalwire/fax", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "FaxSid=fax-id",
    });

    await expect(
      parseSignalWireFaxWebhook(request, credentials, "outbound"),
    ).rejects.toBeInstanceOf(WebhookAuthError);
  });

  it("rejects a callback with a partial numeric page count", async () => {
    const request = new Request("https://events.example.com/webhooks/signalwire/fax", {
      method: "POST",
      headers: {
        Authorization: authorization,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "FaxSid=fax-id&FaxStatus=completed&NumPages=2pages",
    });

    await expect(parseSignalWireFaxWebhook(request, credentials, "outbound")).rejects.toThrow();
  });
});

describe("signalWireReceiveXml", () => {
  it("returns cXML that stores a PDF and posts completion to the authenticated action URL", () => {
    const xml = signalWireReceiveXml(
      "https://signalwire:secret@events.example.com/webhooks/signalwire/inbound?source=number&mode=fax",
    );

    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(xml).toContain("<Receive");
    expect(xml).toContain('mediaType="application/pdf"');
    expect(xml).toContain("source=number&amp;mode=fax");
  });
});
