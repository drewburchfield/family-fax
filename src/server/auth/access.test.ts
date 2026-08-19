import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { describe, expect, it, vi } from "vitest";

import { AccessAuthenticator, assertSameOriginMutation } from "./access";

describe("AccessAuthenticator", () => {
  it("provides an explicit local identity in development mode", async () => {
    const auth = new AccessAuthenticator({ mode: "dev" });

    await expect(auth.authenticate(new Request("http://localhost/api/bootstrap"))).resolves.toEqual({
      email: "local-family-user",
      subject: "development",
    });
  });

  it("refuses development authentication on a remote hostname", async () => {
    const auth = new AccessAuthenticator({ mode: "dev" });

    await expect(
      auth.authenticate(new Request("https://fax.example.com/api/bootstrap")),
    ).rejects.toThrow(/limited to localhost/i);
  });

  it("verifies the configured Cloudflare Access audience and issuer", async () => {
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    const jwk = await exportJWK(publicKey);
    const token = await new SignJWT({ email: "family@example.com" })
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setIssuer("https://family.cloudflareaccess.com")
      .setAudience("access-audience")
      .setSubject("person-1")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({ keys: [{ ...jwk, kid: "test-key", alg: "RS256", use: "sig" }] }),
    );
    const auth = new AccessAuthenticator(
      {
        mode: "access",
        audience: "access-audience",
        teamDomain: "family.cloudflareaccess.com",
      },
      { fetcher },
    );

    await expect(
      auth.authenticate(
        new Request("https://fax.example.com/api/bootstrap", {
          headers: { "Cf-Access-Jwt-Assertion": token },
        }),
      ),
    ).resolves.toEqual({ email: "family@example.com", subject: "person-1" });
    const secondRequestAuthenticator = new AccessAuthenticator(
      {
        mode: "access",
        audience: "access-audience",
        teamDomain: "family.cloudflareaccess.com",
      },
      { fetcher },
    );
    await secondRequestAuthenticator.authenticate(
      new Request("https://fax.example.com/api/bootstrap", {
        headers: { "Cf-Access-Jwt-Assertion": token },
      }),
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("rejects cross-origin or unmarked browser mutations", () => {
    expect(() =>
      assertSameOriginMutation(
        new Request("https://fax.example.com/api/faxes", {
          method: "POST",
          headers: { Origin: "https://other.example.com", "X-Family-Fax-Request": "1" },
        }),
      ),
    ).toThrowError(/same origin/i);
    expect(() =>
      assertSameOriginMutation(
        new Request("https://fax.example.com/api/faxes", {
          method: "POST",
          headers: { Origin: "https://fax.example.com" },
        }),
      ),
    ).toThrowError(/request marker/i);
  });
});
