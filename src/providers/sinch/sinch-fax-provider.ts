import type {
  FaxProvider,
  NumberCandidate,
  NumberSearchRequest,
  ProviderDocument,
  ProviderFax,
  ProvisionedNumber,
} from "../fax-provider";
import { SinchHttpClient } from "./client";
import {
  activeNumberSchema,
  availableNumbersResponseSchema,
  mapSinchCandidate,
  mapSinchFax,
} from "./schemas";

interface SinchOptions {
  projectId: string;
  serviceId: string;
  region: string;
  keyId: string;
  keySecret: string;
  fetcher?: typeof fetch;
}

interface EmailNumber {
  number?: string;
  faxNumber?: string;
  phoneNumber?: string;
  permissions?: "send" | "receive" | "both";
}

export class SinchFaxProvider implements FaxProvider {
  readonly name = "sinch" as const;
  private readonly client: SinchHttpClient;
  private readonly numbersBase = "https://numbers.api.sinch.com";
  private readonly faxBase: string;

  constructor(private readonly options: SinchOptions) {
    this.client = new SinchHttpClient(options);
    this.faxBase =
      options.region === "global"
        ? "https://fax.api.sinch.com"
        : `https://${options.region}.fax.api.sinch.com`;
  }

  async searchNumbers(request: NumberSearchRequest): Promise<NumberCandidate[]> {
    const candidates: NumberCandidate[] = [];
    for (const areaCode of request.areaCodes) {
      const url = new URL(
        `/v1/projects/${encodeURIComponent(this.options.projectId)}/availableNumbers`,
        this.numbersBase,
      );
      url.searchParams.set("regionCode", request.countryCode);
      url.searchParams.set("type", "LOCAL");
      url.searchParams.set("numberPattern.pattern", areaCode);
      url.searchParams.set("numberPattern.searchPattern", "START");
      url.searchParams.append("capabilities", "VOICE");
      url.searchParams.set("size", String(request.limitPerAreaCode));
      const raw = await this.client.json<unknown>(url.toString());
      const parsed = availableNumbersResponseSchema.parse(raw);
      candidates.push(...parsed.availableNumbers.map((number) => mapSinchCandidate(number, areaCode)));
    }
    return candidates;
  }

  async provisionNumber(input: {
    candidate: NumberCandidate;
    correlationId: string;
  }): Promise<ProvisionedNumber> {
    const url = `${this.numbersBase}/v1/projects/${encodeURIComponent(this.options.projectId)}/availableNumbers/${encodeURIComponent(input.candidate.e164)}:rent`;
    const raw = await this.client.json<unknown>(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Correlation-ID": input.correlationId },
      body: JSON.stringify({
        voiceConfiguration: { type: "FAX", serviceId: this.options.serviceId },
      }),
    });
    const parsed = activeNumberSchema.parse(raw);
    return {
      e164: parsed.phoneNumber,
      providerId: parsed.phoneNumber,
      ready:
        parsed.voiceConfiguration?.type === "FAX" &&
        parsed.voiceConfiguration.serviceId === this.options.serviceId &&
        !parsed.scheduledVoiceProvisioning,
      nextBilledAt: null,
      raw,
    };
  }

  async getNumber(e164: string): Promise<ProvisionedNumber | null> {
    const url = `${this.numbersBase}/v1/projects/${encodeURIComponent(this.options.projectId)}/activeNumbers/${encodeURIComponent(e164)}`;
    const response = await this.client.request(url, {}, [404]);
    if (response.status === 404) return null;
    const raw = await response.json();
    const parsed = activeNumberSchema.parse(raw);
    return {
      e164: parsed.phoneNumber,
      providerId: parsed.phoneNumber,
      ready:
        parsed.voiceConfiguration?.type === "FAX" &&
        parsed.voiceConfiguration.serviceId === this.options.serviceId &&
        !parsed.scheduledVoiceProvisioning,
      nextBilledAt: null,
      raw,
    };
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
        raw: { provider: "sinch", e164: input.e164, reason: "Inbound routing is disabled." },
      };
    }
    const current = await this.listEmailNumbers(input.email);
    const merged = current.filter((item) => this.emailNumber(item) !== input.e164);
    merged.push({
      number: input.e164,
      permissions: input.mode === "receive-only" ? "receive" : "both",
    });
    const raw = await this.updateEmailNumbers(input.email, merged, input.correlationId);
    return { configured: true, raw };
  }

  async removeInboundNumberRouting(input: {
    e164: string;
    email: string;
    correlationId: string;
  }): Promise<{ removed: boolean; raw: unknown }> {
    const current = await this.listEmailNumbers(input.email);
    const remaining = current.filter((item) => this.emailNumber(item) !== input.e164);
    const raw = await this.updateEmailNumbers(input.email, remaining, input.correlationId);
    return { removed: true, raw };
  }

  async sendFax(input: {
    from: string;
    to: string;
    contentUrl: string;
    callbackUrl: string;
    correlationId: string;
  }): Promise<ProviderFax> {
    const raw = await this.client.json<unknown>(
      `${this.faxBase}/v3/projects/${encodeURIComponent(this.options.projectId)}/faxes`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Correlation-ID": input.correlationId },
        body: JSON.stringify({
          from: input.from,
          to: input.to,
          contentUrl: input.contentUrl,
          callbackUrl: input.callbackUrl,
          callbackUrlContentType: "application/json",
          serviceId: this.options.serviceId,
          labels: { correlation_id: input.correlationId },
        }),
      },
    );
    const first = Array.isArray(raw) ? raw[0] : raw;
    return mapSinchFax(first);
  }

  async getFax(id: string): Promise<ProviderFax> {
    const raw = await this.client.json<unknown>(
      `${this.faxBase}/v3/projects/${encodeURIComponent(this.options.projectId)}/faxes/${encodeURIComponent(id)}`,
    );
    return mapSinchFax(raw);
  }

  async downloadFax(id: string): Promise<ProviderDocument> {
    const response = await this.client.request(
      `${this.faxBase}/v3/projects/${encodeURIComponent(this.options.projectId)}/faxes/${encodeURIComponent(id)}/file`,
    );
    if (!response.body) throw new Error("Sinch returned an empty fax document");
    const length = response.headers.get("Content-Length");
    return {
      body: response.body,
      contentType: response.headers.get("Content-Type") ?? "application/pdf",
      ...(length ? { size: Number.parseInt(length, 10) } : {}),
    };
  }

  async releaseNumber(e164: string, correlationId: string): Promise<{ released: boolean; raw: unknown }> {
    const response = await this.client.request(
      `${this.numbersBase}/v1/projects/${encodeURIComponent(this.options.projectId)}/activeNumbers/${encodeURIComponent(e164)}:release`,
      { method: "POST", headers: { "X-Correlation-ID": correlationId } },
      [404],
    );
    if (response.status === 404 || response.status === 204) {
      return { released: true, raw: { status: response.status } };
    }
    const raw = await response.json();
    return { released: true, raw };
  }

  async health(): Promise<{ ok: boolean; detail: string; raw?: unknown }> {
    try {
      const raw = await this.client.json<unknown>(
        `${this.faxBase}/v3/projects/${encodeURIComponent(this.options.projectId)}/services/${encodeURIComponent(this.options.serviceId)}`,
      );
      return { ok: true, detail: "Sinch Fax service is reachable.", raw };
    } catch (error) {
      return {
        ok: false,
        detail: error instanceof Error ? error.message : "Sinch health check failed.",
      };
    }
  }

  private async listEmailNumbers(email: string): Promise<EmailNumber[]> {
    const url = `${this.faxBase}/v3/projects/${encodeURIComponent(this.options.projectId)}/services/${encodeURIComponent(this.options.serviceId)}/emails/${encodeURIComponent(email)}/numbers?pageSize=1000`;
    const response = await this.client.request(url, {}, [404]);
    if (response.status === 404) return [];
    const raw = (await response.json()) as { phoneNumbers?: EmailNumber[] };
    return raw.phoneNumbers ?? [];
  }

  private async updateEmailNumbers(
    email: string,
    values: EmailNumber[],
    correlationId: string,
  ): Promise<unknown> {
    const phoneNumbers = values
      .map((item) => ({
        number: this.emailNumber(item),
        permissions: item.permissions ?? "receive",
      }))
      .filter((item): item is { number: string; permissions: "send" | "receive" | "both" } =>
        Boolean(item.number),
      );
    return this.client.json<unknown>(
      `${this.faxBase}/v3/projects/${encodeURIComponent(this.options.projectId)}/services/${encodeURIComponent(this.options.serviceId)}/emails/${encodeURIComponent(email)}`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json", "X-Correlation-ID": correlationId },
        body: JSON.stringify({ phoneNumbers }),
      },
    );
  }

  private emailNumber(value: EmailNumber): string {
    return value.number ?? value.faxNumber ?? value.phoneNumber ?? "";
  }
}
