import { ProviderError } from "../../domain/errors";
import { SinchAuth } from "./auth";

export class SinchHttpClient {
  readonly auth: SinchAuth;

  constructor(
    options: {
      keyId: string;
      keySecret: string;
      fetcher?: typeof fetch;
    },
  ) {
    this.fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis);
    this.auth = new SinchAuth({ ...options, fetcher: this.fetcher });
  }

  private readonly fetcher: typeof fetch;

  async request(url: string, init: RequestInit = {}, allowStatuses: number[] = []): Promise<Response> {
    let response = await this.authorizedFetch(url, init);
    if (response.status === 401) {
      this.auth.invalidate();
      response = await this.authorizedFetch(url, init);
    }

    if (!response.ok && !allowStatuses.includes(response.status)) {
      const raw = await response.text();
      let detail: unknown = raw;
      try {
        detail = raw ? JSON.parse(raw) : null;
      } catch {
        // The text response is the useful diagnostic payload.
      }
      throw new ProviderError(
        `Sinch request failed with HTTP ${response.status}`,
        `sinch_http_${response.status}`,
        response.status === 429 || response.status >= 500,
        { status: response.status, response: detail },
      );
    }

    return response;
  }

  async json<T>(url: string, init: RequestInit = {}, allowStatuses: number[] = []): Promise<T> {
    const response = await this.request(url, init, allowStatuses);
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  private async authorizedFetch(url: string, init: RequestInit): Promise<Response> {
    const token = await this.auth.getToken();
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${token}`);
    headers.set("Accept", "application/json");
    return this.fetcher(url, { ...init, headers });
  }
}
