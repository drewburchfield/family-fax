import { useEffect, useState } from "react";
import type { CountryCode } from "libphonenumber-js";
import { Link } from "react-router-dom";

import type { CoverSheetData, TemporaryNumber } from "../../shared/contracts";
import { api, ApiError } from "../api/client";
import { PageIntro, useFamilyFax } from "../components/AppShell";
import { CoverSheetEditor } from "../components/CoverSheetEditor";
import { DocumentQueue, type QueuedDocument } from "../components/DocumentQueue";
import { LineSetup } from "../components/LineSetup";
import { formatPhone } from "../components/NumberCard";
import {
  normalizeFaxNumber,
  PhoneNumberField,
} from "../components/PhoneNumberField";
import { PdfPreview } from "../components/PdfPreview";
import {
  eligibleHouseholdLines,
  selectHouseholdLine,
} from "../lib/household-line";

export function SendPage() {
  const { bootstrap, refresh } = useFamilyFax();
  const [country, setCountry] = useState<CountryCode>(bootstrap.config.defaultPhoneCountry);
  const [destination, setDestination] = useState("");
  const [cover, setCover] = useState<CoverSheetData>(() => defaultCover(bootstrap));
  const [documents, setDocuments] = useState<QueuedDocument[]>([]);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [pageCount, setPageCount] = useState<number | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [faxJobId, setFaxJobId] = useState<string | null>(null);
  const householdLines = eligibleHouseholdLines(
    bootstrap.activeNumbers,
    bootstrap.config.provider,
  );
  const initialLine = selectHouseholdLine(
    householdLines,
    bootstrap.config.provider,
    bootstrap.config.householdLineId,
  );
  const [selectedLineId, setSelectedLineId] = useState<string | null>(initialLine?.id ?? null);
  const [sendingLine, setSendingLine] = useState<TemporaryNumber | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | Error | null>(null);

  useEffect(() => () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
  }, [previewUrl]);

  const selectedLine = householdLines.find((line) => line.id === selectedLineId)
    ?? initialLine;
  const canPrepare = destination.trim().length > 0 && documents.length > 0 && !busy;
  const packetLocked = busy || Boolean(faxJobId);

  const prepare = async () => {
    setBusy(true);
    setError(null);
    let createdJobId: string | null = null;
    try {
      const normalizedDestination = normalizeFaxNumber(destination, country);
      const { prepareFaxPacket } = await import("../lib/pdf");
      const packet = await prepareFaxPacket(
        documents.map((document) => document.source),
        cover,
        { limits: bootstrap.config.limits },
      );
      const job = await api.createFax({
        mode: "send-only",
        toNumber: normalizedDestination,
        requestedTtlDays: null,
        requestedRentalMonths: null,
        coverData: cover,
      });
      createdJobId = job.id;
      for (const [index, document] of documents.entries()) {
        const bytes = await document.source.arrayBuffer();
        const metadata = packet.documents[index]!;
        await api.uploadDocument(
          job.id,
          `original-${index + 1}-${crypto.randomUUID()}`,
          new Blob([bytes], { type: document.type }),
          {
            kind: "original",
            sha256: metadata.sha256,
            displayName: document.name,
            pageCount: metadata.pageCount,
          },
        );
      }
      const finalDocumentId = `packet-${crypto.randomUUID()}`;
      const packetBlob = new Blob([copyBytes(packet.bytes)], { type: "application/pdf" });
      await api.uploadDocument(job.id, finalDocumentId, packetBlob, {
        kind: "final-packet",
        sha256: packet.sha256,
        displayName: "fax-packet.pdf",
        pageCount: packet.pageCount,
      });
      await api.prepareFax(job.id, finalDocumentId, packet.pageCount);
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      setPreviewUrl(URL.createObjectURL(packetBlob));
      setPageCount(packet.pageCount);
      setWarnings(packet.warnings);
      setFaxJobId(job.id);
      setDestination(normalizedDestination);
    } catch (caught) {
      const original = asError(caught);
      if (createdJobId) {
        try {
          await api.cancelFax(createdJobId, original.message);
        } catch (cancelError) {
          setError(new Error(
            `${original.message} The incomplete fax could not be canceled automatically: ${asError(cancelError).message}`,
          ));
          return;
        }
      }
      setError(original);
    } finally {
      setBusy(false);
    }
  };

  const sendFrom = async (line: TemporaryNumber) => {
    if (!faxJobId || !line.e164) return;
    setBusy(true);
    setError(null);
    try {
      await api.startFaxWithExistingNumber(faxJobId, line.id);
      setSendingLine(line);
      setNotice(`The fax is sending from ${formatPhone(line.e164)}.`);
      await refresh();
    } catch (caught) {
      setError(asError(caught));
    } finally {
      setBusy(false);
    }
  };

  if (sendingLine) {
    return (
      <>
        <PageIntro eyebrow="Transmission started" title="The fax is on its way.">
          <p>The fax provider will report the final result here, and the household email will receive a confirmation after delivery.</p>
        </PageIntro>
        {notice ? <p className="success-notice" role="status">{notice}</p> : null}
        {error ? <ErrorNotice error={error} /> : null}
        <section className="form-card">
          <p className="section-kicker">Sending line</p>
          <h2>{formatPhone(sendingLine.e164!)}</h2>
          <p className="quiet-note">The line remains open for replies under its existing release schedule.</p>
        </section>
        <div className="completion-actions">
          <Link className="button button-primary" to={`/activity/${faxJobId}`}>Follow transmission</Link>
          <Link className="button button-secondary" to="/">Back home</Link>
        </div>
      </>
    );
  }

  return (
    <>
      <PageIntro eyebrow="Household fax" title="Send a fax">
        <p>Build and preview the exact packet, then send it from the household fax line.</p>
      </PageIntro>
      {error ? <ErrorNotice error={error} /> : null}
      <div className="flow-layout">
        <div className="flow-main">
          <section className="form-card">
            <div className="step-heading"><span>1</span><div><p className="section-kicker">Destination</p><h2>Where is this going?</h2></div></div>
            <PhoneNumberField
              country={country}
              value={destination}
              onCountryChange={setCountry}
              onChange={setDestination}
              disabled={packetLocked}
            />
          </section>
          <section className="form-card">
            <div className="step-heading"><span>2</span><div><p className="section-kicker">Packet</p><h2>Build what they will receive</h2></div></div>
            <CoverSheetEditor value={cover} onChange={setCover} disabled={packetLocked} />
            <DocumentQueue documents={documents} onChange={setDocuments} disabled={packetLocked} />
            {faxJobId ? <p className="quiet-note">The previewed packet is locked so the confirmed fax matches it exactly.</p> : null}
            {!faxJobId ? (
              <button type="button" className="button button-primary button-wide" disabled={!canPrepare} onClick={() => void prepare()}>
                {busy ? "Preparing…" : "Prepare and preview"}
              </button>
            ) : null}
          </section>
          {faxJobId ? (
            <section className="form-card">
              <div className="step-heading"><span>3</span><div><p className="section-kicker">Confirmation</p><h2>Send from the household line</h2></div></div>
              {selectedLine ? (
                <>
                  {householdLines.length > 1 ? (
                    <label>
                      Sending line
                      <select value={selectedLine.id} onChange={(event) => setSelectedLineId(event.currentTarget.value)} disabled={busy}>
                        {householdLines.map((line) => (
                          <option key={line.id} value={line.id}>{formatPhone(line.e164!)}</option>
                        ))}
                      </select>
                    </label>
                  ) : null}
                  <div className="send-line-confirmation">
                    <div><span>Send from</span><strong>{formatPhone(selectedLine.e164!)}</strong></div>
                    <div><span>Send to</span><strong>{formatPhone(destination)}</strong></div>
                  </div>
                  <button type="button" className="button button-primary button-wide" disabled={busy} onClick={() => void sendFrom(selectedLine)}>
                    {busy ? "Starting…" : "Send fax"}
                  </button>
                  <Link className="quiet-link" to="/fax-line">Manage the household fax line</Link>
                </>
              ) : (
                <LineSetup purpose="resume-send" onStarted={(line) => void sendFrom(line)} />
              )}
            </section>
          ) : null}
        </div>
        <aside className="flow-preview">
          <PdfPreview url={previewUrl} pageCount={pageCount} />
          {warnings.length ? <div className="warning-list"><strong>Check before sending</strong>{warnings.map((warning) => <p key={warning}>{warning}</p>)}</div> : null}
        </aside>
      </div>
    </>
  );
}

export function ErrorNotice({ error }: { error: Error }) {
  return (
    <div className="error-notice" role="alert">
      <strong>That did not work yet.</strong>
      <p>{error.message}</p>
      {error instanceof ApiError && error.correlationId ? <small>Reference: {error.correlationId}</small> : null}
    </div>
  );
}

function defaultCover(bootstrap: ReturnType<typeof useFamilyFax>["bootstrap"]): CoverSheetData {
  const template = bootstrap.templates.find((item) => item.isDefault);
  return template?.data ?? {
    recipient: "",
    sender: "",
    subject: "",
    callbackNumber: "",
    note: "Please see the attached documents.",
    enabled: true,
  };
}

function asError(value: unknown): ApiError | Error {
  return value instanceof Error ? value : new Error("The operation could not be completed.");
}

function copyBytes(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}
