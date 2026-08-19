// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { PdfPreview } from "./PdfPreview";

describe("PdfPreview", () => {
  it("uses an intentional label when a ready preview has no page count", () => {
    render(<PdfPreview url="blob:fax-preview" pageCount={null} />);

    expect(screen.getByText("Page count unavailable")).toBeTruthy();
    expect(screen.queryByText(/^pages$/)).toBeNull();
  });
});
