import { Link } from "react-router-dom";

import { PageIntro, useFamilyFax } from "../components/AppShell";

export function SettingsPage() {
  const { bootstrap } = useFamilyFax();
  return (
    <>
      <PageIntro eyebrow="Application" title="Settings"><p>Review deployment behavior and manage reusable cover sheets.</p></PageIntro>
      <div className="settings-grid">
        <section className="form-card">
          <p className="section-kicker">Fax line</p>
          <h2>Routing, area codes, and billing term</h2>
          <p>Household number preferences and lifecycle controls live together on Fax line.</p>
          <Link className="button button-primary" to="/fax-line">Manage fax line</Link>
        </section>
        <aside className="settings-aside">
          <p className="section-kicker">Deployment</p>
          <dl className="fact-list">
            <div><dt>Provider</dt><dd>{bootstrap.config.provider}</dd></div>
            <div><dt>Retention</dt><dd>Keep everything</dd></div>
            <div><dt>Log detail</dt><dd>Full, unredacted fax context</dd></div>
          </dl>
          <Link to="/templates">Edit the default cover sheet</Link>
          <Link to="/diagnostics">Open diagnostics</Link>
        </aside>
      </div>
    </>
  );
}
