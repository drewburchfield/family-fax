import { describe, expect, it } from "vitest";

import {
  mapProviderFaxState,
  pollDelayForAttempt,
  providerInteractionBaseUrl,
  shouldPollFax,
} from "./workflow-policy";

describe("workflow policy", () => {
  it("maps provider states without inventing success", () => {
    expect(mapProviderFaxState("queued")).toBe("submitted");
    expect(mapProviderFaxState("in_progress")).toBe("sending");
    expect(mapProviderFaxState("completed")).toBe("delivered");
    expect(mapProviderFaxState("failure")).toBe("failed");
    expect(mapProviderFaxState("unknown")).toBe("status_unknown");
  });

  it("polls accepted and uncertain nonterminal provider faxes", () => {
    expect(shouldPollFax("submitted")).toBe(true);
    expect(shouldPollFax("sending")).toBe(true);
    expect(shouldPollFax("status_unknown")).toBe(true);
    expect(shouldPollFax("status_unknown", "submission_in_progress")).toBe(true);
    expect(shouldPollFax("status_unknown", "ambiguous_submission")).toBe(false);
    expect(shouldPollFax("delivered")).toBe(false);
  });

  it("backs off status polling", () => {
    expect([0, 1, 2, 3, 8].map(pollDelayForAttempt)).toEqual([
      "30 seconds",
      "1 minute",
      "2 minutes",
      "5 minutes",
      "15 minutes",
    ]);
  });

  it("uses the public integration host for provider document fetches", () => {
    expect(
      providerInteractionBaseUrl("https://fax.example.com", {
        baseUrl: "https://fax-events.example.com",
        username: "provider",
        password: "secret",
      }),
    ).toBe("https://fax-events.example.com");
    expect(providerInteractionBaseUrl("https://fax.example.com", undefined)).toBe(
      "https://fax.example.com",
    );
  });
});
