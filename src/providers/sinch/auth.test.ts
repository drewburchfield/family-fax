import { describe, expect, it, vi } from "vitest";

import { FixedClock } from "../../domain/clock";
import { SinchAuth } from "./auth";

describe("SinchAuth", () => {
  it("exchanges credentials and caches the token", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({ access_token: "token-1", expires_in: 3599, token_type: "bearer" }),
    );
    const clock = new FixedClock(new Date("2026-08-16T12:00:00.000Z"));
    const auth = new SinchAuth({ keyId: "key-id", keySecret: "key-secret", fetcher, clock });

    expect(await auth.getToken()).toBe("token-1");
    expect(await auth.getToken()).toBe("token-1");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[1]?.headers).toMatchObject({
      Authorization: `Basic ${btoa("key-id:key-secret")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    });
  });

  it("refreshes an expired or invalidated token", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ access_token: "token-1", expires_in: 60 }))
      .mockResolvedValueOnce(Response.json({ access_token: "token-2", expires_in: 60 }));
    const auth = new SinchAuth({
      keyId: "key-id",
      keySecret: "key-secret",
      fetcher,
      clock: new FixedClock(new Date("2026-08-16T12:00:00.000Z")),
    });

    expect(await auth.getToken()).toBe("token-1");
    auth.invalidate();
    expect(await auth.getToken()).toBe("token-2");
  });
});
