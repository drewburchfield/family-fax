import { afterEach, describe, expect, it, vi } from "vitest";

import { SinchFaxProvider } from "./sinch-fax-provider";

const jsonResponse = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { "Content-Type": "application/json" } });

describe("SinchFaxProvider", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("calls the Worker global fetch with its required receiver", async () => {
    const workerFetch = vi.fn(async function (this: unknown, input: RequestInfo | URL) {
      if (this !== globalThis) {
        throw new TypeError("Illegal invocation: function called with incorrect `this` reference.");
      }
      const url = new URL(String(input));
      if (url.hostname === "auth.sinch.com") {
        return jsonResponse({ access_token: "token", expires_in: 3599 });
      }
      return jsonResponse({ id: "service-id", name: "Default Service" });
    });
    vi.stubGlobal("fetch", workerFetch as typeof fetch);
    const provider = new SinchFaxProvider({
      projectId: "project-id",
      serviceId: "service-id",
      region: "global",
      keyId: "key-id",
      keySecret: "key-secret",
    });

    await expect(provider.health()).resolves.toMatchObject({
      ok: true,
      detail: "Sinch Fax service is reachable.",
    });
    expect(workerFetch).toHaveBeenCalledTimes(2);
  });

  it("searches preferred area codes and preserves pricing", async () => {
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      if (url.hostname === "auth.sinch.com") {
        return jsonResponse({ access_token: "token", expires_in: 3599 });
      }
      expect(url.searchParams.get("numberPattern.pattern")).toBe("615");
      expect(url.searchParams.get("numberPattern.searchPattern")).toBe("START");
      return jsonResponse({
        availableNumbers: [
          {
            phoneNumber: "+16155550199",
            regionCode: "US",
            type: "LOCAL",
            capability: ["VOICE"],
            setupPrice: { amount: "0.00", currencyCode: "USD" },
            monthlyPrice: { amount: "1.00", currencyCode: "USD" },
            paymentIntervalMonths: 1,
            supportingDocumentationRequired: false,
          },
        ],
      });
    });
    const provider = createProvider(fetcher);

    const candidates = await provider.searchNumbers({
      areaCodes: ["615"],
      countryCode: "US",
      limitPerAreaCode: 3,
    });

    expect(candidates[0]?.e164).toBe("+16155550199");
    expect(candidates[0]?.monthlyPrice?.amount).toBe("1.00");
  });

  it("rents a number with FAX service configuration", async () => {
    const fetcher = routedFetch((url, init) => {
      expect(url.pathname).toContain("/availableNumbers/%2B16155550199:rent");
      expect(JSON.parse(String(init?.body))).toEqual({
        voiceConfiguration: { type: "FAX", serviceId: "service-id" },
      });
      return jsonResponse({
        phoneNumber: "+16155550199",
        voiceConfiguration: { type: "FAX", serviceId: "service-id" },
      });
    });
    const provider = createProvider(fetcher);

    const result = await provider.provisionNumber({
      candidate: candidate(),
      correlationId: "correlation-1",
    });

    expect(result.ready).toBe(true);
  });

  it("submits a content URL with a JSON callback and correlation label", async () => {
    const fetcher = routedFetch((url, init) => {
      expect(url.pathname).toBe("/v3/projects/project-id/faxes");
      expect(JSON.parse(String(init?.body))).toMatchObject({
        from: "+16155550199",
        to: "+16155550123",
        contentUrl: "https://fax.example.com/provider-content/token",
        callbackUrlContentType: "application/json",
        labels: { correlation_id: "correlation-1" },
      });
      return jsonResponse([
        {
          id: "fax-1",
          direction: "OUTBOUND",
          from: "+16155550199",
          to: "+16155550123",
          status: "QUEUED",
          createTime: "2026-08-16T12:00:00.000Z",
          projectId: "project-id",
        },
      ]);
    });
    const provider = createProvider(fetcher);

    const fax = await provider.sendFax({
      from: "+16155550199",
      to: "+16155550123",
      contentUrl: "https://fax.example.com/provider-content/token",
      callbackUrl: "https://fax-events.example.com/webhooks/sinch/fax",
      correlationId: "correlation-1",
    });

    expect(fax.id).toBe("fax-1");
    expect(fax.status).toBe("queued");
  });

  it("merges a fax-to-email number without dropping existing routes", async () => {
    const bodies: unknown[] = [];
    const fetcher = routedFetch((url, init) => {
      if (!init?.method || init.method === "GET") {
        return jsonResponse({
          phoneNumbers: [{ number: "+12125550100", permissions: "receive" }],
        });
      }
      bodies.push(JSON.parse(String(init?.body)));
      return jsonResponse({ email: "fax@example.com" });
    });
    const provider = createProvider(fetcher);

    await provider.configureInboundNumber({
      e164: "+16155550199",
      email: "fax@example.com",
      mode: "receive-only",
      callbackUrl: "https://fax-events.example.com/webhooks/sinch",
      correlationId: "correlation-1",
    });

    expect(bodies).toEqual([
      {
        phoneNumbers: [
          { number: "+12125550100", permissions: "receive" },
          { number: "+16155550199", permissions: "receive" },
        ],
      },
    ]);
  });

  it("does not create inbound routing for a send-only number", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const provider = createProvider(fetcher);

    await expect(provider.configureInboundNumber({
      e164: "+16155550199",
      email: "fax@example.com",
      mode: "send-only",
      callbackUrl: "https://events.example.com/webhooks/sinch/inbound",
      correlationId: "send-only",
    })).resolves.toMatchObject({ configured: false });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("retries once with a refreshed token after a 401", async () => {
    let authCalls = 0;
    let apiCalls = 0;
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      if (url.hostname === "auth.sinch.com") {
        authCalls += 1;
        return jsonResponse({ access_token: `token-${authCalls}`, expires_in: 3599 });
      }
      apiCalls += 1;
      if (apiCalls === 1) return jsonResponse({ message: "expired" }, 401);
      return jsonResponse({ availableNumbers: [] });
    });
    const provider = createProvider(fetcher);

    await provider.searchNumbers({ areaCodes: ["615"], countryCode: "US", limitPerAreaCode: 1 });

    expect(authCalls).toBe(2);
    expect(apiCalls).toBe(2);
  });
});

function createProvider(fetcher: typeof fetch) {
  return new SinchFaxProvider({
    projectId: "project-id",
    serviceId: "service-id",
    region: "global",
    keyId: "key-id",
    keySecret: "key-secret",
    fetcher,
  });
}

function routedFetch(handler: (url: URL, init?: RequestInit) => Response | Promise<Response>) {
  return vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === "auth.sinch.com") {
      return jsonResponse({ access_token: "token", expires_in: 3599 });
    }
    return handler(url, init);
  });
}

function candidate() {
  return {
    e164: "+16155550199",
    areaCode: "615",
    countryCode: "US",
    type: "LOCAL" as const,
    capabilities: ["VOICE"],
    setupPrice: null,
    monthlyPrice: { amount: "1.00", currency: "USD", intervalMonths: 1 },
    supportingDocumentationRequired: false,
    raw: {},
  };
}
