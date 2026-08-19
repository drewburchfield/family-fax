import { useEffect, useState } from "react";

import type { Money } from "../../shared/contracts";

export function ConfirmCost({
  number,
  setupPrice,
  monthlyPrice,
  minimumNumberHoldDays = 0,
  busy = false,
  confirmLabel = "Provision this number",
  onConfirm,
  onCancel,
}: {
  number: string;
  setupPrice: Money | null;
  monthlyPrice: Money | null;
  minimumNumberHoldDays?: number;
  busy?: boolean;
  confirmLabel?: string;
  onConfirm(): void;
  onCancel(): void;
}) {
  const [confirmed, setConfirmed] = useState(false);
  const priceAvailable = monthlyPrice !== null;
  useEffect(() => {
    setConfirmed(false);
  }, [number, setupPrice?.amount, setupPrice?.currency, monthlyPrice?.amount, monthlyPrice?.currency]);
  return (
    <section className="cost-confirmation" aria-labelledby="cost-heading">
      <p className="section-kicker">Configured monthly estimate</p>
      <h2 id="cost-heading">Confirm before we get this number</h2>
      <strong className="quoted-number">{number}</strong>
      <dl className="price-breakdown">
        <div><dt>Setup</dt><dd>{formatMoney(setupPrice) ?? "No setup fee shown"}</dd></div>
        <div><dt>Monthly rental</dt><dd>{formatMoney(monthlyPrice) ?? "Not reported"}</dd></div>
      </dl>
      <p className="billing-warning">
        {priceAvailable
          ? "Provider inventory may omit account-specific pricing. This configured estimate is the amount the app uses for approval. The provider bills this number by the month, and releasing it early may not prorate the current month."
          : "No monthly rental estimate is configured. Choose another number or ask the app administrator to set one."}
        {minimumNumberHoldDays > 0
          ? ` You cannot release this number for ${minimumNumberHoldDays} days after purchase.`
          : ""}
      </p>
      <label className="confirm-check">
        <input type="checkbox" checked={confirmed} disabled={!priceAvailable} onChange={(event) => setConfirmed(event.currentTarget.checked)} />
        <span>I understand this can create a charge on the provider account.</span>
      </label>
      <div className="button-row">
        <button type="button" className="button button-secondary" onClick={onCancel}>Choose another</button>
        <button type="button" className="button button-primary" disabled={!priceAvailable || !confirmed || busy} onClick={onConfirm}>
          {busy ? "Provisioning…" : confirmLabel}
        </button>
      </div>
    </section>
  );
}
export function formatMoney(money: Money | null): string | null {
  if (!money) return null;
  const value = Number.parseFloat(money.amount);
  const formatted = Number.isFinite(value)
    ? new Intl.NumberFormat("en-US", { style: "currency", currency: money.currency }).format(value)
    : `${money.amount} ${money.currency}`;
  return money.intervalMonths ? `${formatted} every ${money.intervalMonths === 1 ? "month" : `${money.intervalMonths} months`}` : formatted;
}
