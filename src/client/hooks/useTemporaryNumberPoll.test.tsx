// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TemporaryNumber } from "../../shared/contracts";
import { api } from "../api/client";
import { useTemporaryNumberPoll } from "./useTemporaryNumberPoll";

vi.mock("../api/client", () => ({ api: { getNumber: vi.fn() } }));

describe("useTemporaryNumberPoll", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("serializes provider-status requests", async () => {
    const pending = deferred<TemporaryNumber>();
    vi.mocked(api.getNumber).mockReturnValue(pending.promise);
    const setNumber = vi.fn();
    const setError = vi.fn();
    renderHook(() => useTemporaryNumberPoll(number("requested"), setNumber, setError));

    await act(() => vi.advanceTimersByTimeAsync(1_000));
    await act(() => vi.advanceTimersByTimeAsync(5_000));
    expect(api.getNumber).toHaveBeenCalledTimes(1);

    await act(async () => pending.resolve(number("requested")));
    await act(() => vi.advanceTimersByTimeAsync(1_000));
    expect(api.getNumber).toHaveBeenCalledTimes(2);
  });

  it("ignores a completion from a previous polling generation", async () => {
    const pending = deferred<TemporaryNumber>();
    vi.mocked(api.getNumber).mockReturnValue(pending.promise);
    const setNumber = vi.fn();
    const setError = vi.fn();
    const { rerender } = renderHook(
      ({ value }) => useTemporaryNumberPoll(value, setNumber, setError),
      { initialProps: { value: number("requested") } },
    );
    await act(() => vi.advanceTimersByTimeAsync(1_000));

    rerender({ value: number("active") });
    await act(async () => pending.resolve(number("requested")));

    expect(setNumber).not.toHaveBeenCalled();
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function number(state: TemporaryNumber["state"]): TemporaryNumber {
  return {
    id: "number-1",
    faxJobId: "fax-1",
    e164: "+16155550100",
    areaCode: "615",
    providerId: "+16155550100",
    state,
    mode: "receive-only",
    forwardingEmail: "fax@example.com",
    setupPrice: null,
    monthlyPrice: null,
    provisionedAt: null,
    earliestProviderReleaseAt: null,
    expiresAt: null,
    releaseStartedAt: null,
    releasedAt: null,
    workflowId: "workflow-1",
    createdAt: "2026-08-16T12:00:00.000Z",
    updatedAt: "2026-08-16T12:00:00.000Z",
  };
}
