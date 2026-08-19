// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { CoverSheetEditor } from "./CoverSheetEditor";

describe("CoverSheetEditor", () => {
  it("edits cover fields and can disable the cover", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <CoverSheetEditor
        value={{
          recipient: "Clinic",
          sender: "Family",
          subject: "Records",
          callbackNumber: "",
          note: "Attached",
          enabled: true,
        }}
        onChange={onChange}
      />,
    );

    await user.type(screen.getByLabelText("Callback number"), "615-555-0100");
    await user.click(screen.getByRole("checkbox", { name: /include a cover sheet/i }));

    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ callbackNumber: "6" }));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ enabled: false }));
  });

  it("locks every cover field after the packet is prepared", () => {
    render(
      <CoverSheetEditor
        disabled
        value={{
          recipient: "Clinic",
          sender: "Family",
          subject: "Records",
          callbackNumber: "615-555-0100",
          note: "Attached",
          enabled: true,
        }}
        onChange={() => undefined}
      />,
    );

    expect((screen.getByRole("group", { name: "Cover sheet" }) as HTMLFieldSetElement).disabled).toBe(true);
    expect((screen.getByLabelText("Recipient") as HTMLInputElement).disabled).toBe(true);
  });
});
