// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import type { CountryCode } from "libphonenumber-js";

import { normalizeFaxNumber, PhoneNumberField } from "./PhoneNumberField";

describe("PhoneNumberField", () => {
  it("starts with the selected country and keeps local input editable", async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    render(<PhoneNumberHarness onValueChange={onValueChange} />);

    expect(screen.getByLabelText("Country")).toHaveValue("US");
    expect(screen.getByText("+1")).toBeTruthy();

    await user.type(screen.getByLabelText("Fax number"), "6155550123");

    expect(onValueChange).toHaveBeenLastCalledWith("6155550123");
  });

  it("updates the calling code when the country changes", async () => {
    const user = userEvent.setup();
    render(<PhoneNumberHarness />);

    await user.selectOptions(screen.getByLabelText("Country"), "GB");

    expect(screen.getByLabelText("Country")).toHaveValue("GB");
    expect(screen.getByText("+44")).toBeTruthy();
  });

  it("preserves a valid pasted international number regardless of the selected country", () => {
    expect(normalizeFaxNumber(" +44 20 7946 0018 ", "US")).toBe("+442079460018");
  });

  it("normalizes a local number using the selected country", () => {
    expect(normalizeFaxNumber("615-555-0123", "US")).toBe("+16155550123");
  });

  it("rejects an invalid fax number", () => {
    expect(() => normalizeFaxNumber("not a number", "US")).toThrow(
      "Enter a valid fax number.",
    );
  });
});

function PhoneNumberHarness({ onValueChange = () => undefined }: { onValueChange?: (value: string) => void }) {
  const [country, setCountry] = useState<CountryCode>("US");
  const [value, setValue] = useState("");

  return (
    <PhoneNumberField
      country={country}
      value={value}
      onCountryChange={setCountry}
      onChange={(nextValue) => {
        setValue(nextValue);
        onValueChange(nextValue);
      }}
    />
  );
}
