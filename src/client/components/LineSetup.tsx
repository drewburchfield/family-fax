import { useEffect, useRef, useState } from "react";

import type { TemporaryNumber } from "../../shared/contracts";
import { api, type NumberCandidate } from "../api/client";
import { useTemporaryNumberPoll } from "../hooks/useTemporaryNumberPoll";
import { ErrorNotice } from "../routes/SendPage";
import { useFamilyFax } from "./AppShell";
import { ConfirmCost, formatMoney } from "./ConfirmCost";
import { formatPhone, NumberCard } from "./NumberCard";

export function LineSetup({
  purpose,
  onStarted,
  initialNumber = null,
}: {
  purpose: "household-line" | "resume-send";
  onStarted(number: TemporaryNumber, faxJobId: string): void;
  initialNumber?: TemporaryNumber | null;
}) {
  const { bootstrap } = useFamilyFax();
  const [email, setEmail] = useState(bootstrap.config.defaultForwardEmail);
  const [rentalTerm, setRentalTerm] = useState<number | "manual">(
    bootstrap.config.defaultRentalMonths,
  );
  const [faxJobId, setFaxJobId] = useState<string | null>(initialNumber?.faxJobId ?? null);
  const [candidates, setCandidates] = useState<NumberCandidate[]>([]);
  const [selected, setSelected] = useState<NumberCandidate | null>(null);
  const [number, setNumber] = useState<TemporaryNumber | null>(initialNumber);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const completedNumberId = useRef<string | null>(null);

  useTemporaryNumberPoll(number, setNumber, setError);

  useEffect(() => {
    if (
      number?.state !== "active" ||
      !faxJobId ||
      completedNumberId.current === number.id
    ) return;
    completedNumberId.current = number.id;
    onStarted(number, faxJobId);
  }, [faxJobId, number, onStarted]);

  const search = async () => {
    setBusy(true);
    setError(null);
    let createdJobId: string | null = null;
    try {
      const job = await api.createFax({
        mode: "receive-only",
        toNumber: null,
        requestedTtlDays: null,
        requestedRentalMonths: rentalTerm === "manual" ? null : rentalTerm,
        coverData: null,
      });
      createdJobId = job.id;
      await api.prepareFax(job.id, null, null);
      const result = await api.searchNumbers(bootstrap.config.preferredAreaCodes);
      if (!result.candidates.length) {
        throw new Error("No fax-capable numbers are available in the preferred area codes right now.");
      }
      setFaxJobId(job.id);
      setCandidates(result.candidates);
    } catch (caught) {
      const original = caught instanceof Error ? caught : new Error("The number search failed.");
      if (createdJobId) {
        try {
          await api.cancelFax(createdJobId, original.message);
        } catch (cancelError) {
          const message = cancelError instanceof Error
            ? cancelError.message
            : "Unknown cancellation error.";
          setError(new Error(
            `${original.message} The incomplete line request could not be canceled automatically: ${message}`,
          ));
          return;
        }
      }
      setError(original);
    } finally {
      setBusy(false);
    }
  };

  const confirm = async () => {
    if (!faxJobId || !selected) return;
    setBusy(true);
    setError(null);
    try {
      const started = await api.startFax(faxJobId, selected, email);
      setNumber(started.number);
      setSelected(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught : new Error("The fax line could not be opened."));
    } finally {
      setBusy(false);
    }
  };

  if (number) {
    return (
      <section className="line-setup-result" aria-live="polite">
        <div className="section-heading-row">
          <div>
            <p className="section-kicker">Line setup</p>
            <h2>{number.state === "active" ? "Fax line ready" : "Opening the fax line"}</h2>
          </div>
        </div>
        {error ? <ErrorNotice error={error} /> : null}
        <NumberCard number={number} busy={busy} />
      </section>
    );
  }

  return (
    <section className="line-setup" aria-labelledby="line-setup-heading">
      <div className="section-heading-row">
        <div>
          <p className="section-kicker">{purpose === "resume-send" ? "Sending line" : "Household line"}</p>
          <h2 id="line-setup-heading">
            {purpose === "resume-send" ? "Open a line, then send" : "Open the household fax line"}
          </h2>
        </div>
      </div>
      <p className="quiet-note">
        Choose how long to keep the number and where incoming faxes should be forwarded.
      </p>
      {error ? <ErrorNotice error={error} /> : null}
      <div className="two-column-fields">
        <label>
          Keep the number for
          <select
            aria-label="Keep the number for"
            value={rentalTerm}
            disabled={Boolean(faxJobId) || busy}
            onChange={(event) => setRentalTerm(
              event.currentTarget.value === "manual" ? "manual" : Number(event.currentTarget.value),
            )}
          >
            {bootstrap.config.rentalMonthPresets.map((months) => (
              <option key={months} value={months}>{months} {months === 1 ? "month" : "months"}</option>
            ))}
            <option value="manual">Until I release it</option>
          </select>
          <small>Number rentals are billed monthly.</small>
        </label>
        <label>
          Forward incoming faxes to
          <input
            type="email"
            value={email}
            disabled={Boolean(faxJobId) || busy}
            onChange={(event) => setEmail(event.currentTarget.value)}
          />
        </label>
      </div>
      {!faxJobId ? (
        <button
          type="button"
          className="button button-primary"
          disabled={busy || !email}
          onClick={() => void search()}
        >
          {busy ? "Searching…" : "Search preferred area codes"}
        </button>
      ) : (
        <div className="line-candidate-list">
          <p className="section-kicker">Available now</p>
          <div className="candidate-grid">
            {candidates.map((candidate) => (
              <button
                type="button"
                className="candidate-card"
                key={candidate.e164}
                onClick={() => setSelected(candidate)}
              >
                <strong>{formatPhone(candidate.e164)}</strong>
                <span>{formatMoney(candidate.monthlyPrice) ?? "Price unavailable"}</span>
              </button>
            ))}
          </div>
        </div>
      )}
      {selected ? (
        <div className="modal-backdrop">
          <ConfirmCost
            number={formatPhone(selected.e164)}
            setupPrice={selected.setupPrice}
            monthlyPrice={selected.monthlyPrice}
            minimumNumberHoldDays={bootstrap.config.minimumNumberHoldDays}
            busy={busy}
            confirmLabel="Confirm and open line"
            onCancel={() => setSelected(null)}
            onConfirm={() => void confirm()}
          />
        </div>
      ) : null}
    </section>
  );
}
