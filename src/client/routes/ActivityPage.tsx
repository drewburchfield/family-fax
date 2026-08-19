import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";

import type { FaxDocument, FaxEvent, FaxJob, FaxNotification } from "../../shared/contracts";
import { api } from "../api/client";
import { PageIntro, useFamilyFax } from "../components/AppShell";
import { StatusBadge } from "../components/StatusBadge";
import { Timeline } from "../components/Timeline";
import { formatPhone } from "../components/NumberCard";
import { ErrorNotice } from "./SendPage";

export function ActivityPage() {
  const { bootstrap } = useFamilyFax();
  const [faxes, setFaxes] = useState(bootstrap.recentFaxes);
  const [error, setError] = useState<Error | null>(null);
  const request = useRef<AbortController | null>(null);
  const load = () => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setError(null);
    void api.listFaxes("", controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) setFaxes(result.faxes);
      })
      .catch((caught) => {
        if (!controller.signal.aborted) setError(caught instanceof Error ? caught : new Error("Fax activity could not be loaded."));
      });
  };
  useEffect(() => {
    load();
    return () => request.current?.abort();
  }, []);
  return (
    <>
      <PageIntro eyebrow="Live and recent" title="Fax activity"><p>Every provider handoff, delivery update, incoming fax, and number release appears here.</p></PageIntro>
      {error ? <ErrorNotice error={error} /> : null}
      <div className="section-heading-row"><p className="quiet-note">{faxes.length} transmissions</p><button type="button" className="button button-secondary" onClick={load}>Refresh</button></div>
      <FaxTable faxes={faxes} />
    </>
  );
}

export function FaxDetailPage() {
  const { id = "" } = useParams();
  const [detail, setDetail] = useState<{ fax: FaxJob; documents: FaxDocument[]; events: FaxEvent[]; notifications: FaxNotification[] } | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [emailNotice, setEmailNotice] = useState<string | null>(null);
  const [emailBusy, setEmailBusy] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    setDetail(null);
    setError(null);
    void api.getFax(id, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) setDetail(result);
      })
      .catch((caught) => {
        if (!controller.signal.aborted) setError(caught instanceof Error ? caught : new Error("Fax details could not be loaded."));
      });
    return () => controller.abort();
  }, [id]);
  if (error) return <ErrorNotice error={error} />;
  if (!detail) return <p className="quiet-note" aria-busy="true">Loading transmission…</p>;
  const peer = detail.fax.direction === "inbound" ? detail.fax.fromNumber : detail.fax.toNumber;
  const notification = detail.notifications?.[0];
  const emailDelivered = notification?.state === "delivered" || detail.events.some((event) => event.type === "fax.email_delivered");
  const shouldShowEmailStatus = detail.fax.state === "delivered" && detail.fax.direction !== "none";
  const retryEmail = async () => {
    const warning = notification?.state === "delivery_unknown"
      ? "Email may already have been accepted. Retry anyway? This can create a duplicate message."
      : "Send this archived fax to the household email now?";
    if (!window.confirm(warning)) return;
    setEmailBusy(true);
    setError(null);
    try {
      await api.retryEmail(detail.fax.id);
      setDetail(await api.getFax(detail.fax.id));
      setEmailNotice("The archived fax was sent to the forwarding email.");
    } catch (caught) {
      setError(caught instanceof Error ? caught : new Error("Email delivery could not be retried."));
    } finally {
      setEmailBusy(false);
    }
  };
  return (
    <>
      <PageIntro eyebrow={detail.fax.direction === "inbound" ? "Incoming fax" : "Outgoing fax"} title={peer ? formatPhone(peer) : "Fax details"}>
        <StatusBadge state={detail.fax.state} />
      </PageIntro>
      {detail.fax.failureMessage ? <div className="error-notice"><strong>{detail.fax.failureCode}</strong><p>{detail.fax.failureMessage}</p></div> : null}
      {emailNotice ? <p className="success-notice" role="status">{emailNotice}</p> : null}
      {shouldShowEmailStatus && !emailDelivered ? (
        <div className="warning-list">
          <strong>{notification?.state === "failed" ? "Email confirmation failed." : "Email delivery is unconfirmed."}</strong>
          <p>{notification?.state === "delivery_unknown"
            ? "The email may already have been accepted. Retrying can create a duplicate message."
            : "The fax remains safely archived here. You can retry delivery to the household email."}</p>
          <button type="button" className="button button-secondary" disabled={emailBusy} onClick={() => void retryEmail()}>{emailBusy ? "Sending…" : "Retry email delivery"}</button>
        </div>
      ) : null}
      <div className="detail-grid">
        <section className="form-card"><p className="section-kicker">Transmission facts</p><dl className="fact-list"><div><dt>Direction</dt><dd>{detail.fax.direction}</dd></div><div><dt>Pages</dt><dd>{detail.fax.pageCount ?? "Unknown"}</dd></div><div><dt>Provider ID</dt><dd>{detail.fax.providerFaxId ?? "Not assigned"}</dd></div><div><dt>Correlation ID</dt><dd>{detail.fax.correlationId}</dd></div></dl></section>
        <section className="form-card"><p className="section-kicker">Documents</p>{detail.documents.length ? <ul className="document-links">{detail.documents.map((document) => <li key={document.id}><a href={`/api/documents/${document.id}`}>{document.displayName}</a><small>{document.pageCount ?? "?"} pages</small></li>)}</ul> : <p className="quiet-note">No archived documents.</p>}</section>
      </div>
      <section className="form-card"><div className="section-heading-row"><div><p className="section-kicker">Durable audit trail</p><h2>Timeline</h2></div><a className="button button-secondary" href={`/api/faxes/${detail.fax.id}/diagnostics`} download>Diagnostic JSON</a></div><Timeline events={detail.events} /></section>
    </>
  );
}

export function FaxTable({ faxes }: { faxes: FaxJob[] }) {
  if (!faxes.length) return <div className="empty-panel"><strong>No faxes yet.</strong><p>Start from the home page when an office asks for one.</p></div>;
  return (
    <div className="fax-table"><div className="fax-table-head"><span>When</span><span>Direction</span><span>Number</span><span>Status</span></div>{faxes.map((fax) => {
      const peer = fax.direction === "inbound" ? fax.fromNumber : fax.toNumber;
      return <Link key={fax.id} to={`/activity/${fax.id}`}><time dateTime={fax.createdAt}>{new Date(fax.createdAt).toLocaleDateString()}</time><span>{fax.direction === "inbound" ? "Received" : fax.direction === "outbound" ? "Sent" : "Line"}</span><strong>{peer ? formatPhone(peer) : "No peer number"}</strong><StatusBadge state={fax.state} /></Link>;
    })}</div>
  );
}
