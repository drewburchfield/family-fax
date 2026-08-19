import type { Clock } from "../../domain/clock";
import { systemClock } from "../../domain/clock";
import { ProviderError } from "../../domain/errors";

interface TokenResponse {
  access_token: string;
  expires_in: number;
  token_type?: string;
}

export class SinchAuth {
  private cached: { token: string; expiresAt: number } | null = null;

  constructor(
    private readonly options: {
      keyId: string;
      keySecret: string;
      fetcher?: typeof fetch;
      clock?: Clock;
    },
  ) {}

  async getToken(): Promise<string> {
    const clock = this.options.clock ?? systemClock;
    const now = clock.now().getTime();
    if (this.cached && this.cached.expiresAt > now) {
      return this.cached.token;
    }

    const response = await (this.options.fetcher ?? fetch)("https://auth.sinch.com/oauth2/token", {
      method: "POST",
      headers: {
        Authorization: `Basic ${btoa(`${this.options.keyId}:${this.options.keySecret}`)}`,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: "grant_type=client_credentials",
    });

    if (!response.ok) {
      throw new ProviderError(
        `Sinch authentication failed with HTTP ${response.status}`,
        "sinch_auth_failed",
        response.status >= 500,
      );
    }

    const result = (await response.json()) as TokenResponse;
    if (!result.access_token || !Number.isFinite(result.expires_in)) {
      throw new ProviderError("Sinch returned an invalid OAuth response", "sinch_auth_invalid", false);
    }

    const skewSeconds = Math.min(30, Math.max(1, Math.floor(result.expires_in / 10)));
    this.cached = {
      token: result.access_token,
      expiresAt: now + Math.max(1, result.expires_in - skewSeconds) * 1000,
    };
    return result.access_token;
  }

  invalidate(): void {
    this.cached = null;
  }
}
