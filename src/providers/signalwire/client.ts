import { ProviderError } from "../../domain/errors";

export interface SignalWireClientOptions {
  projectId: string;
  apiToken: string;
  spaceUrl: string;
  fetcher?: typeof fetch;
}

export class SignalWireHttpClient {
  readonly baseUrl: string;
  private readonly authorization: string;
  private readonly fetcher: typeof fetch;

  constructor(private readonly options: SignalWireClientOptions) {
    this.baseUrl = `https://${options.spaceUrl.replace(/^https?:\/\//, "").replace(/\/$/, "")}`;
    this.authorization = `Basic ${btoa(`${options.projectId}:${options.apiToken}`)}`;
    this.fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis);
  }

  async request(
    pathOrUrl: string,
    init: RequestInit = {},
    allowStatuses: number[] = [],
  ): Promise<Response> {
    const url = new URL(pathOrUrl, this.baseUrl);
    const headers = new Headers(init.headers);
    headers.set("Accept", headers.get("Accept") ?? "application/json");
    if (url.origin === this.baseUrl) headers.set("Authorization", this.authorization);
    const response = await this.fetcher(url.toString(), { ...init, headers });
    if (!response.ok && !allowStatuses.includes(response.status)) {
      const body = await response.text();
      let detail: unknown = body;
      try {
        detail = body ? JSON.parse(body) : null;
      } catch {
        // Plain text is the useful provider diagnostic.
      }
      throw new ProviderError(
        `SignalWire request failed with HTTP ${response.status}`,
        `signalwire_http_${response.status}`,
        ["GET", "HEAD"].includes((init.method ?? "GET").toUpperCase()) &&
          (response.status === 429 || response.status >= 500),
        { status: response.status, response: detail },
      );
    }
    return response;
  }

  async json<T>(pathOrUrl: string, init: RequestInit = {}, allowStatuses: number[] = []): Promise<T> {
    const response = await this.request(pathOrUrl, init, allowStatuses);
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }
}
