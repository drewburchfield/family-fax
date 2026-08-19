import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";

import type { TemporaryNumber } from "../../shared/contracts";
import { api } from "../api/client";
import { PageIntro, useFamilyFax } from "../components/AppShell";
import { LineSetup } from "../components/LineSetup";
import {
  formatPhone,
  NumberCard,
  RELEASE_NUMBER_CONFIRMATION,
  releaseOutcomeMessage,
} from "../components/NumberCard";
import {
  eligibleHouseholdLines,
  pendingHouseholdLine,
  selectHouseholdLine,
} from "../lib/household-line";
import { ErrorNotice } from "./SendPage";

export function FaxLinePage() {
  const { bootstrap, refresh } = useFamilyFax();
  const eligible = eligibleHouseholdLines(bootstrap.activeNumbers, bootstrap.config.provider);
  const primary = selectHouseholdLine(
    eligible,
    bootstrap.config.provider,
    bootstrap.config.householdLineId,
  );
  const pending = pendingHouseholdLine(bootstrap.activeNumbers, bootstrap.config.provider);
  const [busyNumberId, setBusyNumberId] = useState<string | null>(null);
  const [savingDefaults, setSavingDefaults] = useState(false);
  const externalEmail = primary?.forwardingEmail ?? bootstrap.config.defaultForwardEmail;
  const [email, setEmail] = useState(externalEmail);
  const lastExternalEmail = useRef(externalEmail);
  const [areaCodes, setAreaCodes] = useState(bootstrap.config.preferredAreaCodes.join(", "));
  const [rentalMonths, setRentalMonths] = useState(bootstrap.config.defaultRentalMonths);
  const [error, setError] = useState<Error | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const ordered = primary
    ? [primary, ...eligible.filter((number) => number.id !== primary.id)]
    : eligible;
  const attention = bootstrap.activeNumbers.filter(
    (number) =>
      Boolean(number.e164) &&
      number.providerName === bootstrap.config.provider &&
      ["expiring", "release_failed"].includes(number.state),
  );

  useEffect(() => {
    if (lastExternalEmail.current === externalEmail) return;
    lastExternalEmail.current = externalEmail;
    setEmail(externalEmail);
  }, [externalEmail]);

  const savePrimary = async (number: TemporaryNumber) => {
    setBusyNumberId(number.id);
    setError(null);
    try {
      await api.saveSettings(preferences(bootstrap, number.id));
      setNotice(`${formatPhone(number.e164!)} is now the primary household fax line.`);
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught : new Error("The primary fax line could not be saved."));
    } finally {
      setBusyNumberId(null);
    }
  };

  const extend = async (number: TemporaryNumber, months: number) => {
    setBusyNumberId(number.id);
    setError(null);
    try {
      await api.extendNumber(number.id, months);
      setNotice(`${formatPhone(number.e164!)} was extended by ${months} ${months === 1 ? "month" : "months"}.`);
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught : new Error("The fax line could not be extended."));
    } finally {
      setBusyNumberId(null);
    }
  };

  const cancelRelease = async (number: TemporaryNumber) => {
    if (!window.confirm("Keep this number until you release it manually? Monthly billing will continue.")) return;
    setBusyNumberId(number.id);
    setError(null);
    try {
      await api.cancelNumberRelease(number.id);
      setNotice(`${formatPhone(number.e164!)} will stay open until you release it.`);
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught : new Error("The release schedule could not be canceled."));
    } finally {
      setBusyNumberId(null);
    }
  };

  const release = async (number: TemporaryNumber) => {
    if (!window.confirm(RELEASE_NUMBER_CONFIRMATION)) return;
    setBusyNumberId(number.id);
    setError(null);
    try {
      const result = await api.releaseNumber(number.id);
      setNotice(releaseOutcomeMessage(result, formatPhone(number.e164!)));
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught : new Error("The fax line could not be released."));
      await refresh();
    } finally {
      setBusyNumberId(null);
    }
  };

  const started = async (number: TemporaryNumber) => {
    setError(null);
    try {
      await api.saveSettings(preferences(bootstrap, number.id));
      setNotice(`${formatPhone(number.e164!)} is ready as the household fax line.`);
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught : new Error("The new household fax line could not be saved."));
    }
  };

  const saveDefaults = async () => {
    setSavingDefaults(true);
    setError(null);
    try {
      if (primary && primary.forwardingEmail !== email) {
        await api.updateNumberForwardingEmail(primary.id, email);
      }
      await api.saveSettings({
        defaultForwardEmail: email,
        preferredAreaCodes: areaCodes.split(",").map((value) => value.trim()).filter(Boolean),
        defaultTtlDays: bootstrap.config.defaultTtlDays,
        defaultRentalMonths: rentalMonths,
        householdLineId: primary?.id ?? bootstrap.config.householdLineId,
      });
      setNotice("Household fax line defaults were saved.");
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught : new Error("The fax line defaults could not be saved."));
    } finally {
      setSavingDefaults(false);
    }
  };

  return (
    <>
      <PageIntro eyebrow="Line management" title="Household fax line">
        <p>Choose the number your family shares, review billing dates, and manage its release schedule.</p>
      </PageIntro>
      {error ? <ErrorNotice error={error} /> : null}
      {notice ? <p className="success-notice" role="status">{notice}</p> : null}

      <section className="form-card" aria-labelledby="line-defaults-heading">
        <p className="section-kicker">Routing and new line defaults</p>
        <h2 id="line-defaults-heading">Routing and number preferences</h2>
        <label>
          Forward incoming faxes to
          <input type="email" value={email} onChange={(event) => setEmail(event.currentTarget.value)} />
          <small>This updates the primary household line and becomes the default for new lines.</small>
        </label>
        <label>
          Preferred area codes
          <input inputMode="numeric" value={areaCodes} onChange={(event) => setAreaCodes(event.currentTarget.value)} />
          <small>Comma-separated, searched in order when opening a line.</small>
        </label>
        <label>
          Default number term
          <input
            type="number"
            min="1"
            max={bootstrap.config.maxRentalMonths}
            value={rentalMonths}
            onChange={(event) => setRentalMonths(Number(event.currentTarget.value))}
          />
          <small>The configured fax provider bills numbers monthly.</small>
        </label>
        <button type="button" className="button button-primary" disabled={savingDefaults} onClick={() => void saveDefaults()}>
          {savingDefaults ? "Saving…" : "Save line defaults"}
        </button>
      </section>

      {ordered.length ? (
        <section className="line-management-section" aria-labelledby="open-lines-heading">
          <div className="section-heading-row">
            <div><p className="section-kicker">Ready now</p><h2 id="open-lines-heading">Open receiving lines</h2></div>
            <Link to="/diagnostics">Open diagnostics</Link>
          </div>
          <div className="number-grid">
            {ordered.map((number) => (
              <div className={number.id === primary?.id ? "managed-line primary-line" : "managed-line"} key={number.id}>
                <div className="managed-line-heading">
                  <strong>{number.id === primary?.id ? "Primary household line" : "Additional line"}</strong>
                  {number.id !== primary?.id ? (
                    <button
                      type="button"
                      className="button button-secondary"
                      disabled={busyNumberId === number.id}
                      onClick={() => void savePrimary(number)}
                    >
                      Make primary {formatPhone(number.e164!)}
                    </button>
                  ) : null}
                </div>
                <NumberCard
                  number={number}
                  busy={busyNumberId === number.id}
                  onExtend={number.releasePolicy === "scheduled" ? (months) => void extend(number, months) : undefined}
                  onCancelRelease={number.releasePolicy === "scheduled" ? () => void cancelRelease(number) : undefined}
                  onRelease={() => void release(number)}
                />
              </div>
            ))}
          </div>
        </section>
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

      {ordered.length && pending ? (
        <div className="form-card line-setup-card">
          <LineSetup
            purpose="household-line"
            initialNumber={pending}
            onStarted={(number) => void started(number)}
          />
        </div>
      ) : null}

      {attention.length ? (
        <section className="line-management-section attention-lines" aria-labelledby="attention-lines-heading">
          <div className="section-heading-row">
            <div><p className="section-kicker">Needs attention</p><h2 id="attention-lines-heading">Lines leaving service</h2></div>
          </div>
          <div className="number-grid">
            {attention.map((number) => (
              <NumberCard
                key={number.id}
                number={number}
                busy={busyNumberId === number.id}
                onExtend={number.releasePolicy === "scheduled" ? (months) => void extend(number, months) : undefined}
                onCancelRelease={number.releasePolicy === "scheduled" ? () => void cancelRelease(number) : undefined}
                onRelease={number.state === "release_failed" ? () => void release(number) : undefined}
              />
            ))}
          </div>
        </section>
      ) : null}
    </>
  );
}

function preferences(
  bootstrap: ReturnType<typeof useFamilyFax>["bootstrap"],
  householdLineId: string | null,
) {
  return {
    defaultForwardEmail: bootstrap.config.defaultForwardEmail,
    preferredAreaCodes: bootstrap.config.preferredAreaCodes,
    defaultTtlDays: bootstrap.config.defaultTtlDays,
    defaultRentalMonths: bootstrap.config.defaultRentalMonths,
    householdLineId,
  };
}
