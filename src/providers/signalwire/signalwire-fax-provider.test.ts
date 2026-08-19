import { describe, expect, it, vi } from "vitest";

import { SignalWireFaxProvider } from "./signalwire-fax-provider";

const jsonResponse = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { "Content-Type": "application/json" } });

describe("SignalWireFaxProvider", () => {
  it("searches preferred area codes and keeps only fax-capable local numbers", async () => {
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe("/api/relay/rest/phone_numbers/search");
      expect(url.searchParams.get("areacode")).toBe("615");
      expect(url.searchParams.get("number_type")).toBe("local");
      expect(url.searchParams.get("max_results")).toBe("3");
      expect(new Headers(init?.headers).get("Authorization")).toBe(
        `Basic ${btoa("project-id:api-token")}`,
      );
      return jsonResponse({
        data: [
          {
            number: "+16155550199",
            region: "TN",
            city: "Nashville",
            capabilities: { voice: true, sms: true, mms: true, fax: true },
          },
          {
            number: "+16155550198",
            region: "TN",
            city: "Nashville",
            capabilities: { voice: true, fax: false },
          },
        ],
      });
    });
    const provider = createProvider(fetcher);

    const result = await provider.searchNumbers({
      areaCodes: ["615"],
      countryCode: "US",
      limitPerAreaCode: 3,
    });

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      e164: "+16155550199",
      areaCode: "615",
      capabilities: ["VOICE", "SMS", "MMS", "FAX"],
      monthlyPrice: { amount: "0.5", currency: "USD", intervalMonths: 1 },
    });
  });

  it("accepts the current SignalWire inventory response shape", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => jsonResponse({
      data: [
        {
          e164: "+16295550199",
          national_number_formatted: "(629) 555-0199",
          international_number_formatted: "+1 629-555-0199",
          rate_center: "NASHVILLE",
          region: "TN",
          country_code: "US",
          capabilities: ["voice", "fax"],
        },
      ],
    }));

    const result = await createProvider(fetcher).searchNumbers({
      areaCodes: ["629"],
      countryCode: "US",
      limitPerAreaCode: 3,
    });

    expect(result).toEqual([
      expect.objectContaining({
        e164: "+16295550199",
        areaCode: "629",
        countryCode: "US",
        capabilities: ["VOICE", "FAX"],
      }),
    ]);
  });

  it("purchases a number and preserves its provider billing date", async () => {
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe("/api/relay/rest/phone_numbers");
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toEqual({ number: "+16155550199" });
      return jsonResponse({
        id: "number-id",
        number: "+16155550199",
        capabilities: ["voice", "fax"],
        number_type: "longcode",
        next_billed_at: "2026-09-17T12:00:00.000Z",
        call_receive_mode: "voice",
      });
    });
    const provider = createProvider(fetcher);

    const result = await provider.provisionNumber({
      candidate: candidate(),
      correlationId: "correlation-1",
    });

    expect(result).toMatchObject({
      providerId: "number-id",
      e164: "+16155550199",
      ready: true,
      nextBilledAt: "2026-09-17T12:00:00.000Z",
    });
  });

  it("configures the purchased number to receive fax through a cXML webhook", async () => {
    const requests: Array<{ url: URL; init?: RequestInit }> = [];
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      requests.push({ url, init });
      if (url.pathname === "/api/relay/rest/phone_numbers") {
        return jsonResponse({
          data: [
            {
              id: "number-id",
              number: "+16155550199",
              capabilities: ["voice", "fax"],
              next_billed_at: "2026-09-17T12:00:00.000Z",
            },
          ],
        });
      }
      expect(url.pathname).toBe("/api/relay/rest/phone_numbers/number-id");
      expect(init?.method).toBe("PUT");
      expect(JSON.parse(String(init?.body))).toEqual({
        call_handler: "laml_webhooks",
        call_receive_mode: "fax",
        call_request_url: "https://fax-events.example.com/webhooks/signalwire/incoming",
        call_request_method: "POST",
      });
      return jsonResponse({
        id: "number-id",
        number: "+16155550199",
        capabilities: ["voice", "fax"],
        next_billed_at: "2026-09-17T12:00:00.000Z",
        call_handler: "laml_webhooks",
        call_receive_mode: "fax",
        call_request_url: "https://fax-events.example.com/webhooks/signalwire/incoming",
      });
    });
    const provider = createProvider(fetcher);

    await expect(
      provider.configureInboundNumber({
        e164: "+16155550199",
        email: "fax@example.com",
        mode: "receive-only",
        callbackUrl: "https://fax-events.example.com/webhooks/signalwire/incoming",
        correlationId: "correlation-1",
      }),
    ).resolves.toMatchObject({ configured: true });
    expect(requests).toHaveLength(2);
  });

  it("does not install inbound routing for a send-only number", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const provider = createProvider(fetcher);

    await expect(provider.configureInboundNumber({
      e164: "+16155550199",
      email: "fax@example.com",
      mode: "send-only",
      callbackUrl: "https://fax-events.example.com/webhooks/signalwire/incoming",
      correlationId: "correlation-1",
    })).resolves.toMatchObject({ configured: false });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("submits form-encoded faxes and maps fax status", async () => {
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe("/api/laml/2010-04-01/Accounts/project-id/Faxes");
      expect(init?.method).toBe("POST");
      const body = new URLSearchParams(String(init?.body));
      expect(Object.fromEntries(body)).toMatchObject({
        From: "+16155550199",
        To: "+16155550123",
        MediaUrl: "https://fax.example.com/provider-content/token",
        StatusCallback: "https://fax-events.example.com/webhooks/signalwire/fax",
        StatusCallbackMethod: "POST",
        StoreMedia: "true",
      });
      return jsonResponse({
        sid: "fax-id",
        direction: "outbound",
        from: "+16155550199",
        to: "+16155550123",
        status: "queued",
        date_created: "2026-08-17T12:00:00.000Z",
        num_pages: null,
        price: null,
      });
    });
    const provider = createProvider(fetcher);

    const fax = await provider.sendFax({
      from: "+16155550199",
      to: "+16155550123",
      contentUrl: "https://fax.example.com/provider-content/token",
      callbackUrl: "https://fax-events.example.com/webhooks/signalwire/fax",
      correlationId: "correlation-1",
    });

    expect(fax).toMatchObject({ id: "fax-id", status: "queued", direction: "outbound" });
  });

  it("marks a failed provider mutation as ambiguous and non-retryable", async () => {
    const provider = createProvider(vi.fn<typeof fetch>(async () =>
      jsonResponse({ message: "temporary provider failure" }, 500)
    ));

    await expect(provider.sendFax({
      from: "+16155550199",
      to: "+16155550123",
      contentUrl: "https://fax.example.com/provider-content/token",
      callbackUrl: "https://fax-events.example.com/webhooks/signalwire/fax",
      correlationId: "correlation-1",
    })).rejects.toMatchObject({ retryable: false, providerCode: "signalwire_http_500" });
  });

  it("downloads the provider media URL and releases the exact provider number", async () => {
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/Faxes/fax-id")) {
        return jsonResponse({
          sid: "fax-id",
          direction: "inbound",
          from: "+16155550123",
          to: "+16155550199",
          status: "received",
          date_created: "2026-08-17T12:00:00.000Z",
          media_url: "https://family.signalwire.com/media/fax-id.pdf",
        });
      }
      if (url.pathname === "/media/fax-id.pdf") {
        return new Response("%PDF-1.7", { headers: { "Content-Type": "application/pdf" } });
      }
      if (url.pathname === "/api/relay/rest/phone_numbers") {
        return jsonResponse({ data: [{ id: "number-id", number: "+16155550199" }] });
      }
      expect(url.pathname).toBe("/api/relay/rest/phone_numbers/number-id");
      expect(init?.method).toBe("DELETE");
      return new Response(null, { status: 204 });
    });
    const provider = createProvider(fetcher);

    const document = await provider.downloadFax("fax-id");
    expect(await new Response(document.body).text()).toBe("%PDF-1.7");
    await expect(provider.releaseNumber("+16155550199", "correlation-1")).resolves.toMatchObject({
      released: true,
    });
  });

  it("uses the fax media list when the fax record omits its media URL", async () => {
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/Faxes/fax-media-list")) {
        return jsonResponse({
          sid: "fax-media-list",
          direction: "inbound",
          from: "+16155550123",
          to: "+16155550199",
          status: "received",
          date_created: "2026-08-17T12:00:00.000Z",
        });
      }
      if (url.pathname.endsWith("/Faxes/fax-media-list/Media")) {
        return jsonResponse({
          media: [{
            sid: "media-id",
            content_type: "application/pdf",
            url: "https://family.signalwire.com/media/fax-media-list.pdf",
          }],
        });
      }
      if (url.pathname === "/media/fax-media-list.pdf") {
        return new Response("%PDF-media-list", { headers: { "Content-Type": "application/pdf" } });
      }
      throw new Error(`Unexpected SignalWire path: ${url.pathname}`);
    });

    const document = await createProvider(fetcher).downloadFax("fax-media-list");

    expect(await new Response(document.body).text()).toBe("%PDF-media-list");
  });

  it("rejects malformed provider page counts", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => jsonResponse({
      sid: "fax-bad-pages",
      direction: "outbound",
      from: "+16155550199",
      to: "+16155550123",
      status: "completed",
      num_pages: "2pages",
    }));

    await expect(createProvider(fetcher).getFax("fax-bad-pages")).rejects.toThrow(/page count/i);
  });

  it("reports credential health without mutating provider resources", async () => {
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/relay/rest/phone_numbers") {
        return jsonResponse({ data: [] });
      }
      expect(url.pathname).toBe("/api/laml/2010-04-01/Accounts/project-id/Faxes");
      expect(url.searchParams.get("PageSize")).toBe("1");
      return jsonResponse({ faxes: [], meta: { page: 0, page_size: 1 } });
    });

    await expect(createProvider(fetcher).health()).resolves.toMatchObject({
      ok: true,
      detail: "SignalWire number and Fax APIs are reachable.",
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("does not interpret a malformed number list as confirmed absence", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => jsonResponse({ unexpected: [] }));

    await expect(createProvider(fetcher).getNumber("+16155550199")).rejects.toThrow(/data/i);
  });
});

function createProvider(fetcher: typeof fetch) {
  return new SignalWireFaxProvider({
    projectId: "project-id",
    apiToken: "api-token",
    spaceUrl: "family.signalwire.com",
    localNumberMonthlyPrice: "0.50",
    fetcher,
  });
}

function candidate() {
  return {
    e164: "+16155550199",
    areaCode: "615",
    countryCode: "US",
    type: "LOCAL" as const,
    capabilities: ["VOICE", "FAX"],
    setupPrice: null,
    monthlyPrice: { amount: "0.50", currency: "USD", intervalMonths: 1 },
    supportingDocumentationRequired: false,
    raw: {},
  };
}
