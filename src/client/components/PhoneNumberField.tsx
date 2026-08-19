import {
  getCountries,
  getCountryCallingCode,
  parsePhoneNumberFromString,
  type CountryCode,
} from "libphonenumber-js";
import { useId } from "react";

export interface PhoneNumberFieldProps {
  country: CountryCode;
  value: string;
  onCountryChange(country: CountryCode): void;
  onChange(value: string): void;
  disabled?: boolean;
}

const displayNames = new Intl.DisplayNames(["en"], { type: "region" });
const countryOptions = getCountries()
  .map((country) => ({
    country,
    label: displayNames.of(country) ?? country,
  }))
  .sort((left, right) => left.label.localeCompare(right.label));

export function normalizeFaxNumber(value: string, selectedCountry: CountryCode): string {
  const candidate = value.trim();
  const parsed = candidate.startsWith("+")
    ? parsePhoneNumberFromString(candidate)
    : parsePhoneNumberFromString(candidate, selectedCountry);

  if (!parsed?.isValid()) {
    throw new Error("Enter a valid fax number.");
  }

  return parsed.number;
}

export function PhoneNumberField({
  country,
  value,
  onCountryChange,
  onChange,
  disabled = false,
}: PhoneNumberFieldProps) {
  const countryId = useId();
  const phoneNumberId = useId();

  return (
    <div className="phone-number-field">
      <label htmlFor={countryId}>
        Country
        <select
          id={countryId}
          value={country}
          disabled={disabled}
          onChange={(event) => onCountryChange(event.currentTarget.value as CountryCode)}
        >
          {countryOptions.map((option) => (
            <option key={option.country} value={option.country}>
              {option.label} (+{getCountryCallingCode(option.country)})
            </option>
          ))}
        </select>
      </label>
      <div>
        <label htmlFor={phoneNumberId}>Fax number</label>
        <span className="phone-number-input">
          <span className="phone-country-code">+{getCountryCallingCode(country)}</span>
          <input
            id={phoneNumberId}
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            value={value}
            disabled={disabled}
            onChange={(event) => onChange(event.currentTarget.value)}
          />
        </span>
      </div>
    </div>
  );
}
