import { useEffect, useRef, useState } from "react";

import { api } from "../api/client";
import { PageIntro } from "../components/AppShell";
import { ErrorNotice } from "./SendPage";

export function DiagnosticsPage() {
  const [diagnostics, setDiagnostics] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const request = useRef<AbortController | null>(null);
  const load = () => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setError(null);
    void api.diagnostics(controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) setDiagnostics(result);
      })
      .catch((caught) => {
        if (!controller.signal.aborted) setError(caught instanceof Error ? caught : new Error("Diagnostics could not be loaded."));
      });
  };
  useEffect(() => {
    load();
    return () => request.current?.abort();
  }, []);
  return (
    <>
      <PageIntro eyebrow="Operational visibility" title="Diagnostics"><p>Provider, database, storage, webhook, release, and scheduled-sweep health in one place.</p></PageIntro>
      {error ? <ErrorNotice error={error} /> : null}
      <div className="section-heading-row"><p className="quiet-note">Sensitive fax context is intentionally retained in this private app. Credentials are never included.</p><button type="button" className="button button-secondary" onClick={load}>Run checks</button></div>
      {!diagnostics ? <p aria-busy="true">Running health checks…</p> : <DiagnosticView value={diagnostics} />}
    </>
  );
}

function DiagnosticView({ value }: { value: Record<string, unknown> }) {
  const download = () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `family-fax-diagnostics-${new Date().toISOString()}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  };
  return <section className="diagnostic-panel"><div className="diagnostic-summary"><span className={value.ok ? "health-good" : "health-bad"} /> <strong>{value.ok ? "All core checks passed" : "Something needs attention"}</strong><button type="button" className="button button-secondary" onClick={download}>Download snapshot</button></div><pre>{JSON.stringify(value, null, 2)}</pre></section>;
}
