import type { TemporaryNumber } from "../../shared/contracts";
import { formatMoney } from "./ConfirmCost";
import { StatusBadge } from "./StatusBadge";

export const RELEASE_NUMBER_CONFIRMATION =
  "Request release of this fax number? Receiving stops when the provider completes the release. If a minimum hold still applies, Family Fax will schedule the earliest permitted release.";

export function releaseOutcomeMessage(number: TemporaryNumber, subject: string): string {
  if (number.state === "released") return `${subject} was released. Receiving has stopped.`;
  const releaseAt = number.releaseAt ?? number.expiresAt;
  if (releaseAt) {
    return `${subject} is scheduled for release on ${formatDate(releaseAt)}. Receiving continues until the provider completes the release.`;
  }
  return `${subject} release is pending provider confirmation.`;
}

export function NumberCard({
  number,
  now = new Date(),
  busy = false,
  onExtend,
  onCancelRelease,
  onRelease,
}: {
  number: TemporaryNumber;
  now?: Date;
  busy?: boolean;
  onExtend?(months: number): void;
  onCancelRelease?(): void;
  onRelease?(): void;
}) {
  const remaining = lifecycleLabel(number, now);
  const routeStatus = routingLabel(number);
  const releaseDeferred = number.state === "expiring";
  return (
    <article className="number-card">
      <div className="number-card-top">
        <span className="section-kicker">Fax line</span>
        <StatusBadge state={number.state} />
      </div>
      <strong className="active-number">{number.e164 ? formatPhone(number.e164) : "Being assigned…"}</strong>
      <p>{remaining}</p>
      <p className="number-email">{routeStatus}</p>
      {!["requested", "provisioning", "activating", "cleaning", "provision_failed", "released"].includes(number.state) ? (
        <dl className="fact-list">
          <div><dt>Monthly rental</dt><dd>{formatMoney(number.monthlyPrice) ?? "Not reported"}</dd></div>
          <div><dt>Next provider billing</dt><dd>{number.nextBilledAt ? formatDate(number.nextBilledAt) : "Not reported"}</dd></div>
          <div><dt>Release</dt><dd>{number.releaseAt ? formatDate(number.releaseAt) : number.releasePolicy === "after-send" ? "After this send" : "Manual"}</dd></div>
        </dl>
      ) : null}
      {number.e164 && !["requested", "provisioning", "activating", "cleaning"].includes(number.state) ? (
        <div className="button-row compact">
          <button type="button" className="button button-secondary" onClick={() => navigator.clipboard?.writeText(number.e164!)}>Copy number</button>
          {onExtend ? <button type="button" className="button button-secondary" disabled={busy} onClick={() => onExtend(1)}>Add 1 month</button> : null}
          {onCancelRelease ? <button type="button" className="button button-secondary" disabled={busy} onClick={onCancelRelease}>Keep until released</button> : null}
          {releaseDeferred ? <button type="button" className="button button-secondary" disabled>Release scheduled</button> : null}
          {!releaseDeferred && onRelease ? <button type="button" className="button button-danger" disabled={busy} onClick={onRelease}>{number.state === "release_failed" ? "Retry release" : "Release now"}</button> : null}
        </div>
      ) : null}
    </article>
  );
}

function routingLabel(number: TemporaryNumber) {
  if (["requested", "provisioning", "activating", "cleaning"].includes(number.state)) return "Finishing the provider's fax configuration.";
  if (number.state === "provision_failed") return "The provider could not finish this fax line.";
  if (number.state === "release_failed") return "Release needs attention. Incoming routing may still be active.";
  if (number.state === "released") return "This temporary fax line has been released.";
  return <>Incoming faxes route to <strong>{number.forwardingEmail}</strong>.</>;
}

export function formatPhone(value: string): string {
  const digits = value.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) {
    return `+1 (${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
  }
  return value;
}

function lifecycleLabel(number: TemporaryNumber, now: Date): string {
  if (["requested", "provisioning", "activating", "cleaning"].includes(number.state)) return "The provider is assigning the line.";
  if (number.state === "released") return "Released. The provider should no longer bill this number.";
  if ((number.releasePolicy ?? "scheduled") === "after-send") {
    const earliestRelease = number.releaseAt ?? number.expiresAt;
    return earliestRelease
      ? `This sending line will release after the fax reaches a final status and no earlier than ${formatDate(earliestRelease)}.`
      : "This sending line will release after the fax reaches a final status.";
  }
  const releaseAt = number.releaseAt ?? number.expiresAt;
  if ((number.releasePolicy ?? "scheduled") === "manual" || !releaseAt) {
    return number.nextBilledAt
      ? `Kept until you release it. Next provider billing: ${formatDate(number.nextBilledAt)}.`
      : "Kept until you release it. The provider bills monthly.";
  }
  const milliseconds = new Date(releaseAt).getTime() - now.getTime();
  if (milliseconds <= 0) return "Release is due now.";
  return `Scheduled release: ${formatDate(releaseAt)}.`;
}

export function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}
