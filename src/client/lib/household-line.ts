import type { PublicAppConfig, TemporaryNumber } from "../../shared/contracts";

export function eligibleHouseholdLines(
  numbers: TemporaryNumber[],
  provider: PublicAppConfig["provider"],
): TemporaryNumber[] {
  return numbers
    .filter(
      (number) =>
        number.state === "active" &&
        Boolean(number.e164) &&
        ["scheduled", "manual"].includes(number.releasePolicy ?? "scheduled") &&
        number.providerName === provider,
    )
    .sort((left, right) =>
      (left.provisionedAt ?? left.createdAt).localeCompare(
        right.provisionedAt ?? right.createdAt,
      ),
    );
}

export function selectHouseholdLine(
  numbers: TemporaryNumber[],
  provider: PublicAppConfig["provider"],
  householdLineId: string | null,
): TemporaryNumber | null {
  const eligible = eligibleHouseholdLines(numbers, provider);
  return eligible.find((number) => number.id === householdLineId) ?? eligible[0] ?? null;
}

export function pendingHouseholdLine(
  numbers: TemporaryNumber[],
  provider: PublicAppConfig["provider"],
): TemporaryNumber | null {
  return numbers
    .filter(
      (number) =>
        ["requested", "provisioning", "activating", "cleaning"].includes(number.state) &&
        number.mode !== "send-only" &&
        number.providerName === provider &&
        ["scheduled", "manual"].includes(number.releasePolicy ?? "scheduled"),
    )
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))[0] ?? null;
}

export function visibleReceivingLine(
  numbers: TemporaryNumber[],
  provider: PublicAppConfig["provider"],
  householdLineId: string | null,
): TemporaryNumber | null {
  return (
    selectHouseholdLine(numbers, provider, householdLineId) ??
    numbers.find(
      (number) =>
        number.state === "expiring" &&
        Boolean(number.e164) &&
        number.providerName === provider &&
        ["scheduled", "manual"].includes(number.releasePolicy ?? "scheduled"),
    ) ??
    null
  );
}
