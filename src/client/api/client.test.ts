import { afterEach, describe, expect, it, vi } from "vitest";

import { api } from "./client";

afterEach(() => vi.unstubAllGlobals());

describe("Family Fax API client", () => {
  it("uses the direction-neutral fax email retry endpoint", async () => {
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      expect(String(input)).toBe("/api/faxes/fax-1/retry-email");
      return Response.json({ faxJobId: "fax-1", kind: "outbound_delivered", state: "delivered" });
    });
    vi.stubGlobal("fetch", fetcher);

    await api.retryEmail("fax-1");

    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("encodes Unicode document names into an ASCII-safe request header", async () => {
    const fetcher = vi.fn<typeof fetch>(async (_input, init) => {
      const value = new Headers(init?.headers).get("X-Document-Name");
      expect(value).toBe(encodeURIComponent("scan-📠.pdf"));
      expect(decodeURIComponent(value!)).toBe("scan-📠.pdf");
      return Response.json({ id: "document-1" });
    });
    vi.stubGlobal("fetch", fetcher);

    await api.uploadDocument("fax-1", "document-1", new Blob(["%PDF-1.7"], {
      type: "application/pdf",
    }), {
      kind: "original",
      sha256: "digest",
      displayName: "scan-📠.pdf",
      pageCount: 1,
    });

    expect(fetcher).toHaveBeenCalledOnce();
  });
});
