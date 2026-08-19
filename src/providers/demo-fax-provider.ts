import type {
  FaxProvider,
  NumberCandidate,
  NumberSearchRequest,
  ProviderDocument,
  ProviderFax,
  ProvisionedNumber,
} from "./fax-provider";

interface DemoInboundFax {
  id: string;
  from: string;
  to: string;
  bytes: Uint8Array;
}

const now = () => new Date().toISOString();

export class DemoFaxProvider implements FaxProvider {
  readonly name = "demo" as const;
  private readonly numbers = new Map<string, ProvisionedNumber>();
  private readonly emailRoutes = new Map<string, Set<string>>();
  private readonly faxes = new Map<string, ProviderFax>();
  private readonly inboundDocuments = new Map<string, Uint8Array>();

  async searchNumbers(request: NumberSearchRequest): Promise<NumberCandidate[]> {
    return request.areaCodes.filter((areaCode) => areaCode !== "999").flatMap((areaCode) =>
      Array.from({ length: request.limitPerAreaCode }, (_, index) => {
        const suffix = String(index).padStart(2, "0");
        const e164 = `+1${areaCode}55501${suffix}`;
        return {
          e164,
          areaCode,
          countryCode: request.countryCode,
          type: "LOCAL" as const,
          capabilities: ["VOICE", "FAX"],
          setupPrice: null,
          monthlyPrice: {
            amount: Number(areaCode.at(-1)) >= 6 ? "2.00" : "1.00",
            currency: "USD",
            intervalMonths: 1,
          },
          supportingDocumentationRequired: false,
          raw: { demo: true, e164 },
        };
      }),
    );
  }

  async provisionNumber(input: {
    candidate: NumberCandidate;
    correlationId: string;
  }): Promise<ProvisionedNumber> {
    const provisioned = {
      e164: input.candidate.e164,
      providerId: input.candidate.e164,
      ready: true,
      nextBilledAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      raw: { demo: true, correlationId: input.correlationId },
    };
    this.numbers.set(provisioned.e164, provisioned);
    return structuredClone(provisioned);
  }

  async getNumber(e164: string): Promise<ProvisionedNumber | null> {
    const number = this.numbers.get(e164);
    return number ? structuredClone(number) : null;
  }

  async configureInboundNumber(input: {
    e164: string;
    email: string;
    mode: "send-only" | "receive-only" | "send-and-receive";
    callbackUrl: string;
    correlationId: string;
  }): Promise<{ configured: boolean; raw: unknown }> {
    if (input.mode === "send-only") {
      return { configured: false, raw: { demo: true, ...input, reason: "Inbound routing is disabled." } };
    }
    const routes = this.emailRoutes.get(input.email) ?? new Set<string>();
    routes.add(input.e164);
    this.emailRoutes.set(input.email, routes);
    return { configured: true, raw: { demo: true, ...input } };
  }

  async removeInboundNumberRouting(input: {
    e164: string;
    email: string;
    correlationId: string;
  }): Promise<{ removed: boolean; raw: unknown }> {
    const routes = this.emailRoutes.get(input.email);
    routes?.delete(input.e164);
    return { removed: true, raw: { demo: true, ...input } };
  }

  async sendFax(input: {
    from: string;
    to: string;
    contentUrl: string;
    callbackUrl: string;
    correlationId: string;
  }): Promise<ProviderFax> {
    const createdAt = now();
    const status = input.to.endsWith("0000")
      ? "failure"
      : input.to.endsWith("0001")
        ? "unknown"
        : "completed";
    const fax: ProviderFax = {
      id: `demo-fax-${crypto.randomUUID()}`,
      direction: "outbound",
      from: input.from,
      to: input.to,
      status,
      pageCount: 1,
      price: { amount: "0.045", currency: "USD" },
      errorCode: status === "failure" ? "demo_no_answer" : null,
      errorMessage: status === "failure" ? "The demo destination did not answer." : null,
      createdAt,
      completedAt: ["completed", "failure"].includes(status) ? createdAt : null,
      raw: {
        demo: true,
        correlationId: input.correlationId,
        contentUrl: input.contentUrl,
        callbackUrl: input.callbackUrl,
      },
    };
    this.faxes.set(fax.id, fax);
    return structuredClone(fax);
  }

  async getFax(id: string): Promise<ProviderFax> {
    const fax = this.faxes.get(id);
    if (!fax) throw new Error(`Demo fax not found: ${id}`);
    return structuredClone(fax);
  }

  async downloadFax(id: string): Promise<ProviderDocument> {
    const bytes = this.inboundDocuments.get(id);
    if (!bytes) throw new Error(`Demo fax document not found: ${id}`);
    const buffer = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(buffer).set(bytes);
    return {
      body: new Blob([buffer]).stream(),
      contentType: "application/pdf",
      size: bytes.byteLength,
    };
  }

  async releaseNumber(e164: string, correlationId: string): Promise<{ released: boolean; raw: unknown }> {
    if (e164.endsWith("0102")) throw new Error("Demo release failure for operator recovery testing.");
    this.numbers.delete(e164);
    for (const routes of this.emailRoutes.values()) routes.delete(e164);
    return { released: true, raw: { demo: true, e164, correlationId } };
  }

  async health(): Promise<{ ok: boolean; detail: string; raw?: unknown }> {
    return { ok: true, detail: "Demo provider is ready." };
  }

  injectInboundFax(input: DemoInboundFax): ProviderFax {
    const createdAt = now();
    const fax: ProviderFax = {
      id: input.id,
      direction: "inbound",
      from: input.from,
      to: input.to,
      status: "completed",
      pageCount: 1,
      price: { amount: "0.045", currency: "USD" },
      errorCode: null,
      errorMessage: null,
      createdAt,
      completedAt: createdAt,
      raw: { demo: true },
    };
    this.faxes.set(input.id, fax);
    this.inboundDocuments.set(input.id, new Uint8Array(input.bytes));
    return structuredClone(fax);
  }
}
