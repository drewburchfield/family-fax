import { useState } from "react";
import { Link } from "react-router-dom";

import type { TemporaryNumber } from "../../shared/contracts";
import { api } from "../api/client";
import { PageIntro, useFamilyFax } from "../components/AppShell";
import { LineSetup } from "../components/LineSetup";
import { formatDate, formatPhone } from "../components/NumberCard";
import { StatusBadge } from "../components/StatusBadge";
import { pendingHouseholdLine, visibleReceivingLine } from "../lib/household-line";
import { ErrorNotice } from "./SendPage";

export function ReceivePage() {
  const { bootstrap, refresh } = useFamilyFax();
  const [error, setError] = useState<Error | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const line = visibleReceivingLine(
    bootstrap.activeNumbers,
    bootstrap.config.provider,
    bootstrap.config.householdLineId,
  );
  const pending = pendingHouseholdLine(bootstrap.activeNumbers, bootstrap.config.provider);
  const inbound = bootstrap.recentFaxes.filter(
    (fax) => fax.direction === "inbound" && fax.temporaryNumberId === line?.id,
  );

  const started = async (number: TemporaryNumber) => {
    setError(null);
    try {
      await api.saveSettings({
        defaultForwardEmail: bootstrap.config.defaultForwardEmail,
        preferredAreaCodes: bootstrap.config.preferredAreaCodes,
        defaultTtlDays: bootstrap.config.defaultTtlDays,
        defaultRentalMonths: bootstrap.config.defaultRentalMonths,
        householdLineId: number.id,
      });
      setNotice(`${formatPhone(number.e164!)} is ready to receive faxes.`);
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught : new Error("The household fax line could not be saved."));
    }
  };

  const copyNumber = async () => {
    if (!line?.e164) return;
    try {
      await navigator.clipboard.writeText(line.e164);
      setNotice("The household fax number was copied.");
    } catch {
      setError(new Error("The fax number could not be copied. Select and copy it manually."));
    }
  };

  return (
    <>
      <PageIntro eyebrow="Receiving" title="Receive a fax">
        <p>Share the household number below. Incoming documents are archived here and forwarded to email.</p>
      </PageIntro>
      {error ? <ErrorNotice error={error} /> : null}
      {notice ? <p className="success-notice" role="status">{notice}</p> : null}

      {line ? (
        <>
          {line.state === "expiring" ? (
            <div className="warning-list" role="alert">
              <strong>This line is scheduled for release.</strong>
              <p>It can still receive faxes until the provider completes the release. Open Fax line to review or change its lifecycle.</p>
            </div>
          ) : null}
          <section className="receiving-line-card" aria-labelledby="receiving-number">
            <p className="section-kicker">Household fax number</p>
            <div className="receiving-number-row">
              <h2 id="receiving-number">{formatPhone(line.e164!)}</h2>
              <button type="button" className="button button-primary" onClick={() => void copyNumber()}>
                Copy fax number
              </button>
            </div>
            <dl className="fact-list">
              <div><dt>Forwarding email</dt><dd>{line.forwardingEmail}</dd></div>
              <div><dt>Release policy</dt><dd>{releasePolicyLabel(line)}</dd></div>
              <div><dt>Line status</dt><dd><StatusBadge state={line.state} /></dd></div>
            </dl>
            <Link className="button button-secondary" to="/fax-line">Manage fax line</Link>
          </section>

          <section className="inbound-activity" aria-labelledby="inbound-heading">
            <div className="section-heading-row">
              <div><p className="section-kicker">Recent replies</p><h2 id="inbound-heading">Incoming fax activity</h2></div>
              <Link to="/activity">See all activity</Link>
            </div>
            {inbound.length ? (
              <ul className="inbound-fax-list">
                {inbound.map((fax) => (
                  <li key={fax.id}>
                    <Link to={`/activity/${fax.id}`}>
                      <span>
                        <strong>{fax.fromNumber ? formatPhone(fax.fromNumber) : "Unknown sender"}</strong>
                        <time dateTime={fax.createdAt}>{formatDate(fax.createdAt)}</time>
                      </span>
                      <StatusBadge state={fax.state} />
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="empty-panel">
                <strong>No incoming faxes yet.</strong>
                <p>New faxes to this number will appear here.</p>
              </div>
            )}
          </section>
        </>
      ) : pending ? (
        <div className="form-card line-setup-card">
          <LineSetup
            purpose="household-line"
            initialNumber={pending}
            onStarted={(number) => void started(number)}
          />
        </div>
      ) : (
        <div className="form-card line-setup-card">
          <LineSetup purpose="household-line" onStarted={(number) => void started(number)} />
        </div>
      )}
    </>
  );
}

function releasePolicyLabel(number: TemporaryNumber): string {
  if (number.releasePolicy === "manual") return "Keep until manually released";
  if (number.releaseAt ?? number.expiresAt) {
    return `Scheduled for ${formatDate((number.releaseAt ?? number.expiresAt)!)}`;
  }
  return "Scheduled release";
}
