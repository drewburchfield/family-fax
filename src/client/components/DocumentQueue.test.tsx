// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { DocumentQueue, type QueuedDocument } from "./DocumentQueue";

describe("DocumentQueue", () => {
  it("reorders and removes prepared documents", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const documents: QueuedDocument[] = [
      queued("a", "first.pdf"),
      queued("b", "second.pdf"),
    ];
    render(<DocumentQueue documents={documents} onChange={onChange} />);

    await user.click(screen.getByRole("button", { name: "Move second.pdf up" }));
    expect(onChange).toHaveBeenCalledWith([documents[1], documents[0]]);
    await user.click(screen.getByRole("button", { name: "Remove first.pdf" }));
    expect(onChange).toHaveBeenLastCalledWith([documents[1]]);
  });

  it("reports unsupported files without adding them", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<DocumentQueue documents={[]} onChange={onChange} />);

    await user.upload(
      screen.getByLabelText(/add PDF or photos/i),
      new File(["notes"], "notes.pdf", { type: "text/plain" }),
    );

    expect((await screen.findByRole("alert")).textContent).toMatch(/PDF, JPEG, or PNG/i);
    expect(onChange).not.toHaveBeenCalled();
    expect((screen.getByLabelText(/add PDF or photos/i) as HTMLInputElement).value).toBe("");
  });

  it("locks uploads and ordering after the packet is prepared", () => {
    render(
      <DocumentQueue
        disabled
        documents={[queued("a", "records.pdf")]}
        onChange={() => undefined}
      />,
    );

    expect((screen.getByLabelText(/add PDF or photos/i) as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Remove records.pdf" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

function queued(id: string, name: string): QueuedDocument {
  return {
    id,
    name,
    type: "application/pdf",
    size: 100,
    source: {
      name,
      type: "application/pdf",
      size: 100,
      arrayBuffer: async () => new ArrayBuffer(0),
    },
    warnings: [],
  };
}
