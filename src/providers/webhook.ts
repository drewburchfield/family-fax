import type { ProviderDocument, ProviderFax } from "./fax-provider";

export class WebhookAuthError extends Error {
  constructor() {
    super("Invalid webhook credentials");
    this.name = "WebhookAuthError";
  }
}

export interface FaxWebhookEvent {
  provider: "demo" | "sinch" | "signalwire";
  type: "incoming" | "status";
  eventKey: string;
  eventTime: string;
  fax: ProviderFax;
  file: ProviderDocument | null;
  raw: unknown;
}

export function assertWebhookBasicAuth(
  authorization: string | null,
  credentials: { username: string; password: string },
): void {
  if (!authorization?.startsWith("Basic ")) throw new WebhookAuthError();
  let supplied = "";
  try {
    supplied = atob(authorization.slice(6));
  } catch {
    throw new WebhookAuthError();
  }
  if (!constantTimeEqual(supplied, `${credentials.username}:${credentials.password}`)) {
    throw new WebhookAuthError();
  }
}

function constantTimeEqual(left: string, right: string): boolean {
  const length = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}
