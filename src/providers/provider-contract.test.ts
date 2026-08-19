import { describe, expect, it } from "vitest";

import { DemoFaxProvider } from "./demo-fax-provider";

describe("FaxProvider contract", () => {
  it("searches, provisions, configures, sends, reads, and releases", async () => {
    const provider = new DemoFaxProvider();
    const candidates = await provider.searchNumbers({
      areaCodes: ["615", "629"],
      countryCode: "US",
      limitPerAreaCode: 2,
    });
    const selected = candidates[0]!;

    const provisioned = await provider.provisionNumber({
      candidate: selected,
      correlationId: "correlation-1",
    });
    await provider.configureInboundNumber({
      e164: provisioned.e164,
      email: "fax@example.com",
      mode: "receive-only",
      callbackUrl: "https://fax-events.example.com/webhooks/demo/incoming",
      correlationId: "correlation-1",
    });
    const submitted = await provider.sendFax({
      from: provisioned.e164,
      to: "+16155550123",
      contentUrl: "https://fax.example.com/provider-content/token",
      callbackUrl: "https://fax-events.example.com/webhooks/sinch/fax",
      correlationId: "correlation-1",
    });

    expect((await provider.getFax(submitted.id)).status).toBe("completed");
    expect((await provider.health()).ok).toBe(true);
    expect(provisioned.nextBilledAt).toBeTruthy();
    expect((await provider.releaseNumber(provisioned.e164, "correlation-1")).released).toBe(true);
  });
});
