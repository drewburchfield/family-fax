// @vitest-environment jsdom

import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { FaxJob } from "../../shared/contracts";
import { api } from "../api/client";
import { ArchivePage } from "./ArchivePage";

vi.mock("../api/client", async (loadOriginal) => {
  const original = await loadOriginal<typeof import("../api/client")>();
  return { ...original, api: { ...original.api, listFaxes: vi.fn() } };
});

afterEach(() => {
  vi.useRealTimers();
  vi.mocked(api.listFaxes).mockReset();
});

describe("ArchivePage", () => {
  it("ignores an older search response after a newer query starts", async () => {
    vi.useFakeTimers();
    const initial = deferred<{ faxes: FaxJob[] }>();
    const oldSearch = deferred<{ faxes: FaxJob[] }>();
    const newSearch = deferred<{ faxes: FaxJob[] }>();
    const requests = [initial, oldSearch, newSearch];
    vi.mocked(api.listFaxes).mockImplementation(() => requests.shift()!.promise);
    render(<MemoryRouter><ArchivePage /></MemoryRouter>);

    await act(async () => vi.advanceTimersByTime(150));
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "old" } });
    await act(async () => vi.advanceTimersByTime(150));
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "new" } });
    await act(async () => vi.advanceTimersByTime(150));

    await act(async () => newSearch.resolve({ faxes: [fax("new-fax", "+16155550111")] }));
    expect(screen.getByText(/615\) 555-0111/)).toBeTruthy();
    await act(async () => oldSearch.resolve({ faxes: [fax("old-fax", "+16155550122")] }));
    expect(screen.queryByText(/615\) 555-0122/)).toBeNull();
  });

  it("clears results that belong to an earlier query when the new search fails", async () => {
    vi.useFakeTimers();
    const initial = deferred<{ faxes: FaxJob[] }>();
    const failedSearch = deferred<{ faxes: FaxJob[] }>();
    const requests = [initial, failedSearch];
    vi.mocked(api.listFaxes).mockImplementation(() => requests.shift()!.promise);
    render(<MemoryRouter><ArchivePage /></MemoryRouter>);

    await act(async () => vi.advanceTimersByTime(150));
    await act(async () => initial.resolve({ faxes: [fax("old-fax", "+16155550122")] }));
    expect(screen.getByText(/615\) 555-0122/)).toBeTruthy();
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "new" } });
    await act(async () => vi.advanceTimersByTime(150));
    await act(async () => failedSearch.reject(new Error("search unavailable")));

    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.queryByText(/615\) 555-0122/)).toBeNull();
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

function fax(id: string, toNumber: string): FaxJob {
  return {
    id,
    mode: "send-only",
    direction: "outbound",
    state: "delivered",
    toNumber,
    fromNumber: "+16155550100",
    providerFaxId: `provider-${id}`,
    providerProjectId: null,
    temporaryNumberId: null,
    correlationId: `correlation-${id}`,
    finalDocumentId: null,
    pageCount: 1,
    estimatedCost: null,
    reportedCost: null,
    requestedTtlDays: null,
    coverData: null,
    failureCode: null,
    failureMessage: null,
    createdAt: "2026-08-16T12:00:00.000Z",
    updatedAt: "2026-08-16T12:00:00.000Z",
    submittedAt: "2026-08-16T12:00:00.000Z",
    completedAt: "2026-08-16T12:00:00.000Z",
  };
}
