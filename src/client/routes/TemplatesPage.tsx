import { useState } from "react";

import type { CoverSheetData } from "../../shared/contracts";
import { api } from "../api/client";
import { PageIntro, useFamilyFax } from "../components/AppShell";
import { CoverSheetEditor } from "../components/CoverSheetEditor";
import { ErrorNotice } from "./SendPage";

const emptyCover: CoverSheetData = { recipient: "", sender: "", subject: "", callbackNumber: "", note: "Please see the attached documents.", enabled: true };

export function TemplatesPage() {
  const { bootstrap, refresh } = useFamilyFax();
  const existing = bootstrap.templates.find((item) => item.isDefault);
  const [name, setName] = useState(existing?.name ?? "Default family cover");
  const [cover, setCover] = useState(existing?.data ?? emptyCover);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const save = async () => {
    setSaved(false);
    setError(null);
    try {
      await api.saveTemplate({ id: existing?.id ?? "default-cover", name, data: cover, isDefault: true });
      await refresh();
      setSaved(true);
    } catch (caught) {
      setError(caught instanceof Error ? caught : new Error("The cover template could not be saved."));
    }
  };
  return (
    <>
      <PageIntro eyebrow="Reusable layout" title="Cover sheet"><p>Edit the default once, then adjust any field for an individual fax before sending.</p></PageIntro>
      {error ? <ErrorNotice error={error} /> : null}{saved ? <p className="success-notice" role="status">Default cover saved.</p> : null}
      <div className="template-layout"><section className="form-card"><label>Template name<input value={name} onChange={(event) => setName(event.currentTarget.value)} /></label><CoverSheetEditor value={cover} onChange={setCover} /><button type="button" className="button button-primary" onClick={save}>Save default cover</button></section><CoverPaperPreview cover={cover} /></div>
    </>
  );
}
function CoverPaperPreview({ cover }: { cover: CoverSheetData }) {
  return <aside className="cover-paper"><header><strong>FAMILY FAX</strong><span>PRIVATE FACSIMILE TRANSMISSION</span></header><p>COVER SHEET</p><dl><div><dt>TO</dt><dd>{cover.recipient || "Not specified"}</dd></div><div><dt>FROM</dt><dd>{cover.sender || "Not specified"}</dd></div><div><dt>SUBJECT</dt><dd>{cover.subject || "Not specified"}</dd></div><div><dt>CALLBACK</dt><dd>{cover.callbackNumber || "Not specified"}</dd></div></dl><blockquote>{cover.note || "No additional note."}</blockquote></aside>;
}
