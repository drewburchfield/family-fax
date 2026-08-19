import type { Money } from "../shared/contracts";

export function normalizeMoney(
  amount: string | number | undefined,
  currency: string | undefined,
  intervalMonths?: number,
): Money | null {
  if (amount === undefined || !currency) {
    return null;
  }

  const numeric = typeof amount === "number" ? amount : Number.parseFloat(amount);
  if (!Number.isFinite(numeric) || numeric < 0) {
    return null;
  }

  return {
    amount: numeric.toFixed(4).replace(/0+$/, "").replace(/\.$/, ".00"),
    currency: currency.toUpperCase(),
    ...(intervalMonths ? { intervalMonths } : {}),
  };
}

export function formatMoney(money: Money | null): string {
  if (!money) {
    return "Price unavailable";
  }

  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: money.currency,
    minimumFractionDigits: 2,
  }).format(Number(money.amount));
}
