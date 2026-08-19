import type { FaxState } from "../../shared/contracts";
import type { ProviderFaxStatus } from "../../providers/fax-provider";

export function mapProviderFaxState(status: ProviderFaxStatus): FaxState {
  switch (status) {
    case "queued":
      return "submitted";
    case "in_progress":
      return "sending";
    case "completed":
      return "delivered";
    case "failure":
      return "failed";
    case "unknown":
      return "status_unknown";
  }
}

export function shouldPollFax(state: FaxState, failureCode: string | null = null): boolean {
  if (state === "status_unknown" && failureCode === "ambiguous_submission") return false;
  return state === "submitted" || state === "sending" || state === "status_unknown";
}

export function pollDelayForAttempt(attempt: number): string {
  if (attempt <= 0) return "30 seconds";
  if (attempt === 1) return "1 minute";
  if (attempt === 2) return "2 minutes";
  if (attempt <= 4) return "5 minutes";
  return "15 minutes";
}

export function providerInteractionBaseUrl(
  appBaseUrl: string,
  webhook: { baseUrl: string; username: string; password: string } | undefined,
): string {
  return webhook?.baseUrl ?? appBaseUrl;
}
