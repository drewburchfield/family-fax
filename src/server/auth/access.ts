import { createLocalJWKSet, jwtVerify, type JSONWebKeySet } from "jose";

import type { RuntimeConfig } from "../../domain/config";
import { AuthenticationError, AuthorizationError } from "../../domain/errors";

export interface AuthenticatedIdentity {
  email: string;
  subject: string;
}

type AuthConfig = RuntimeConfig["auth"];

const keySetCache = new Map<
  string,
  { keySet: ReturnType<typeof createLocalJWKSet>; expiresAt: number }
>();

export class AccessAuthenticator {
  private keySet: ReturnType<typeof createLocalJWKSet> | null = null;

  constructor(
    private readonly config: AuthConfig,
    private readonly options: {
      fetcher?: typeof fetch;
      allowRemoteDevelopment?: boolean;
    } = {},
  ) {}

  async authenticate(request: Request): Promise<AuthenticatedIdentity> {
    if (this.config.mode === "dev") {
      const hostname = new URL(request.url).hostname;
      const isLocal = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
      if (!isLocal && !this.options.allowRemoteDevelopment) {
        throw new AuthenticationError("Development authentication is limited to localhost.");
      }
      return {
        email: request.headers.get("X-Development-Identity") ?? "local-family-user",
        subject: "development",
      };
    }
    const token = request.headers.get("Cf-Access-Jwt-Assertion");
    if (!token) throw new AuthenticationError("Cloudflare Access identity is missing.");
    try {
      const { payload } = await jwtVerify(token, await this.getKeySet(), {
        audience: this.config.audience,
        issuer: `https://${normalizeTeamDomain(this.config.teamDomain)}`,
      });
      if (typeof payload.email !== "string" || !payload.sub) {
        throw new AuthenticationError("Cloudflare Access identity is incomplete.");
      }
      return { email: payload.email, subject: payload.sub };
    } catch (error) {
      if (error instanceof AuthenticationError) throw error;
      throw new AuthenticationError("Cloudflare Access identity is invalid.");
    }
  }

  private async getKeySet() {
    if (this.keySet) return this.keySet;
    const teamDomain = normalizeTeamDomain(
      this.config.mode === "access" ? this.config.teamDomain : "",
    );
    const cached = keySetCache.get(teamDomain);
    if (cached && cached.expiresAt > Date.now()) {
      this.keySet = cached.keySet;
      return cached.keySet;
    }
    const response = await (this.options.fetcher ?? fetch)(
      `https://${teamDomain}/cdn-cgi/access/certs`,
    );
    if (!response.ok) throw new AuthenticationError("Cloudflare Access keys are unavailable.");
    const jwks = (await response.json()) as JSONWebKeySet;
    this.keySet = createLocalJWKSet(jwks);
    keySetCache.set(teamDomain, { keySet: this.keySet, expiresAt: Date.now() + 5 * 60_000 });
    return this.keySet;
  }
}

export function assertSameOriginMutation(request: Request): void {
  if (["GET", "HEAD", "OPTIONS"].includes(request.method.toUpperCase())) return;
  const origin = request.headers.get("Origin");
  if (!origin || origin !== new URL(request.url).origin) {
    throw new AuthorizationError("State-changing requests must come from the same origin.");
  }
  if (request.headers.get("X-Family-Fax-Request") !== "1") {
    throw new AuthorizationError("The application request marker is missing.");
  }
}

function normalizeTeamDomain(value: string): string {
  return value.replace(/^https?:\/\//, "").replace(/\/$/, "");
}
