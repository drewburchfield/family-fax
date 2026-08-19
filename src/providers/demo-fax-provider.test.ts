import { describe, expect, it } from "vitest";

import { DemoFaxProvider } from "./demo-fax-provider";

describe("DemoFaxProvider", () => {
  it("builds deterministic inventory from configured area codes", async () => {
    const provider = new DemoFaxProvider();
    const candidates = await provider.searchNumbers({
      areaCodes: ["212", "646"],
      countryCode: "US",
      limitPerAreaCode: 1,
    });

    expect(candidates.map((candidate) => candidate.areaCode)).toEqual(["212", "646"]);
    expect(candidates[0]?.monthlyPrice).toEqual({
      amount: "1.00",
      currency: "USD",
      intervalMonths: 1,
    });
  });

  it("exposes predictable no-inventory and differently priced fallback seams", async () => {
    const provider = new DemoFaxProvider();

    expect(
      await provider.searchNumbers({ areaCodes: ["999"], countryCode: "US", limitPerAreaCode: 3 }),
    ).toEqual([]);
    const fallback = await provider.searchNumbers({
      areaCodes: ["212", "646"],
      countryCode: "US",
      limitPerAreaCode: 1,
    });
    expect(fallback[1]?.monthlyPrice?.amount).toBe("2.00");
    expect(
      (await provider.searchNumbers({ areaCodes: ["646"], countryCode: "US", limitPerAreaCode: 1 }))[0]
        ?.monthlyPrice?.amount,
    ).toBe("2.00");
  });

  it("provides stable failure and unknown-status destinations", async () => {
    const provider = new DemoFaxProvider();
    const failed = await provider.sendFax({
      from: "+16155550100",
      to: "+16155550000",
      contentUrl: "https://example.com/fax.pdf",
      callbackUrl: "https://example.com/callback",
      correlationId: "failed",
    });
    const unknown = await provider.sendFax({
      from: "+16155550100",
      to: "+16155550001",
      contentUrl: "https://example.com/fax.pdf",
      callbackUrl: "https://example.com/callback",
      correlationId: "unknown",
    });

    expect(failed.status).toBe("failure");
    expect(failed.errorCode).toBe("demo_no_answer");
    expect(unknown.status).toBe("unknown");
  });

  it("does not create inbound routing for a send-only number", async () => {
    const provider = new DemoFaxProvider();

    await expect(provider.configureInboundNumber({
      e164: "+16155550199",
      email: "fax@example.com",
      mode: "send-only",
      callbackUrl: "https://events.example.com/webhooks/demo/inbound",
      correlationId: "send-only",
    })).resolves.toMatchObject({ configured: false });
  });

  it("uses globally unique fax identifiers across isolated Worker requests", async () => {
    const input = {
      from: "+16155550100",
      to: "+16155550123",
      contentUrl: "https://example.com/fax.pdf",
      callbackUrl: "https://example.com/callback",
      correlationId: "unique",
    };

    const first = await new DemoFaxProvider().sendFax(input);
    const second = await new DemoFaxProvider().sendFax(input);

    expect(first.id).not.toBe(second.id);
  });

  it("can inject and retrieve an inbound demo fax", async () => {
    const provider = new DemoFaxProvider();
    provider.injectInboundFax({
      id: "inbound-1",
      from: "+16155550111",
      to: "+16155550199",
      bytes: new TextEncoder().encode("pdf bytes"),
    });

    const result = await provider.downloadFax("inbound-1");
    expect(await new Response(result.body).text()).toBe("pdf bytes");
    expect(result.contentType).toBe("application/pdf");
  });
});
