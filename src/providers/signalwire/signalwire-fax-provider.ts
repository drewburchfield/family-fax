import type {
  FaxProvider,
  NumberCandidate,
  NumberSearchRequest,
  ProviderDocument,
  ProviderFax,
  ProvisionedNumber,
} from "../fax-provider";
import { SignalWireHttpClient } from "./client";
import {
  availableNumbersSchema,
  mapSignalWireCandidate,
  mapSignalWireFax,
  mapSignalWireNumber,
  signalWireFaxMediaListSchema,
  signalWireFaxListSchema,
  signalWireFaxSchema,
  signalWireNumberListSchema,
  signalWireNumberSchema,
} from "./schemas";

interface SignalWireOptions {
  projectId: string;
  apiToken: string;
  spaceUrl: string;
  localNumberMonthlyPrice: string;
  fetcher?: typeof fetch;
}

export class SignalWireFaxProvider implements FaxProvider {
  readonly name = "signalwire" as const;
  private readonly client: SignalWireHttpClient;

  constructor(private readonly options: SignalWireOptions) {
    this.client = new SignalWireHttpClient(options);
  }

  async searchNumbers(request: NumberSearchRequest): Promise<NumberCandidate[]> {
    const candidates: NumberCandidate[] = [];
    for (const areaCode of request.areaCodes) {
      const url = new URL("/api/relay/rest/phone_numbers/search", this.client.baseUrl);
      url.searchParams.set("areacode", areaCode);
      url.searchParams.set("number_type", "local");
      url.searchParams.set("max_results", String(request.limitPerAreaCode));
      const raw = await this.client.json<unknown>(url.toString());
      const parsed = availableNumbersSchema.parse(raw);
      for (const number of parsed.data) {
        const candidate = mapSignalWireCandidate(
          number,
          areaCode,
          this.options.localNumberMonthlyPrice,
        );
        if (candidate) candidates.push(candidate);
      }
    }
    return candidates;
  }

  async provisionNumber(input: {
    candidate: NumberCandidate;
    correlationId: string;
  }): Promise<ProvisionedNumber> {
    const raw = await this.client.json<unknown>("/api/relay/rest/phone_numbers", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Correlation-ID": input.correlationId,
      },
      body: JSON.stringify({ number: input.candidate.e164 }),
    });
    return mapSignalWireNumber(raw);
  }

  async getNumber(e164: string): Promise<ProvisionedNumber | null> {
    const number = await this.findNumber(e164);
    return number ? mapSignalWireNumber(number) : null;
  }

  async configureInboundNumber(input: {
    e164: string;
    email: string;
    mode: "send-only" | "receive-only" | "send-and-receive";
    callbackUrl: string;
    correlationId: string;
  }): Promise<{ configured: boolean; raw: unknown }> {
    if (input.mode === "send-only") {
      return {
        configured: false,
        raw: { provider: "signalwire", e164: input.e164, reason: "Inbound routing is disabled for send-only lines." },
      };
    }
    const number = await this.findNumber(input.e164);
    if (!number) throw new Error(`SignalWire number was not found after purchase: ${input.e164}`);
    const raw = await this.client.json<unknown>(
      `/api/relay/rest/phone_numbers/${encodeURIComponent(number.id)}`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "X-Correlation-ID": input.correlationId,
        },
        body: JSON.stringify({
          call_handler: "laml_webhooks",
          call_receive_mode: "fax",
          call_request_url: input.callbackUrl,
          call_request_method: "POST",
        }),
      },
    );
    signalWireNumberSchema.parse(raw);
    return { configured: true, raw };
  }

  async removeInboundNumberRouting(input: {
    e164: string;
    email: string;
    correlationId: string;
  }): Promise<{ removed: boolean; raw: unknown }> {
    return {
      removed: false,
      raw: {
        provider: "signalwire",
        e164: input.e164,
        reason: "SignalWire removes inbound routing when the number is released.",
      },
    };
  }

  async sendFax(input: {
    from: string;
    to: string;
    contentUrl: string;
    callbackUrl: string;
    correlationId: string;
  }): Promise<ProviderFax> {
    const body = new URLSearchParams({
      From: input.from,
      To: input.to,
      MediaUrl: input.contentUrl,
      StatusCallback: input.callbackUrl,
      StatusCallbackMethod: "POST",
      StoreMedia: "true",
    });
    const raw = await this.client.json<unknown>(
      `/api/laml/2010-04-01/Accounts/${encodeURIComponent(this.options.projectId)}/Faxes`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "X-Correlation-ID": input.correlationId,
        },
        body: body.toString(),
      },
    );
    return mapSignalWireFax(raw);
  }

  async getFax(id: string): Promise<ProviderFax> {
    const raw = await this.client.json<unknown>(this.faxPath(id));
    signalWireFaxSchema.parse(raw);
    return mapSignalWireFax(raw);
  }

  async downloadFax(id: string): Promise<ProviderDocument> {
    const raw = await this.client.json<unknown>(this.faxPath(id));
    const fax = signalWireFaxSchema.parse(raw);
    let mediaUrl = fax.media_url ?? null;
    let contentType = "application/pdf";
    if (!mediaUrl) {
      const mediaRaw = await this.client.json<unknown>(`${this.faxPath(id)}/Media`);
      const media = signalWireFaxMediaListSchema.parse(mediaRaw).media[0];
      if (!media) throw new Error(`SignalWire returned no media for fax ${id}`);
      mediaUrl = media.url ?? media.uri ?? null;
      contentType = media.content_type;
    }
    if (!mediaUrl) throw new Error(`SignalWire returned no downloadable media URL for fax ${id}`);
    const downloadUrl = mediaUrl.endsWith(".json") ? mediaUrl.slice(0, -5) : mediaUrl;
    const response = await this.client.request(downloadUrl, {
      headers: { Accept: contentType },
    });
    if (!response.body) throw new Error("SignalWire returned an empty fax document");
    const length = response.headers.get("Content-Length");
    return {
      body: response.body,
      contentType: response.headers.get("Content-Type") ?? contentType,
      ...(length ? { size: Number.parseInt(length, 10) } : {}),
    };
  }

  async releaseNumber(
    e164: string,
    correlationId: string,
  ): Promise<{ released: boolean; raw: unknown }> {
    const number = await this.findNumber(e164);
    if (!number) return { released: true, raw: { status: 404, alreadyAbsent: true } };
    const response = await this.client.request(
      `/api/relay/rest/phone_numbers/${encodeURIComponent(number.id)}`,
      { method: "DELETE", headers: { "X-Correlation-ID": correlationId } },
      [404],
    );
    return {
      released: response.status === 204 || response.status === 404,
      raw: { status: response.status, providerId: number.id },
    };
  }

  async health(): Promise<{ ok: boolean; detail: string; raw?: unknown }> {
    try {
      const [numberRaw, faxRaw] = await Promise.all([
        this.client.json<unknown>("/api/relay/rest/phone_numbers?page_size=1"),
        this.client.json<unknown>(`${this.faxPath("").replace(/\/$/, "")}?PageSize=1`),
      ]);
      signalWireNumberListSchema.parse(numberRaw);
      signalWireFaxListSchema.parse(faxRaw);
      return {
        ok: true,
        detail: "SignalWire number and Fax APIs are reachable.",
        raw: { numberApi: "ok", faxApi: "ok" },
      };
    } catch (error) {
      return {
        ok: false,
        detail: error instanceof Error ? error.message : "SignalWire health check failed.",
      };
    }
  }

  private async findNumber(
    e164: string,
  ): Promise<ReturnType<typeof signalWireNumberSchema.parse> | null> {
    const url = new URL("/api/relay/rest/phone_numbers", this.client.baseUrl);
    url.searchParams.set("filter_number", e164);
    url.searchParams.set("page_size", "50");
    const raw = await this.client.json<unknown>(url.toString());
    const parsed = signalWireNumberListSchema.parse(raw);
    return parsed.data.find((number) => number.number === e164) ?? null;
  }

  private faxPath(id: string): string {
    return `/api/laml/2010-04-01/Accounts/${encodeURIComponent(this.options.projectId)}/Faxes/${encodeURIComponent(id)}`;
  }
}
