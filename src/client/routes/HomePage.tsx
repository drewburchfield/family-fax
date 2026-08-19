import { Link } from "react-router-dom";

import { useFamilyFax } from "../components/AppShell";
import { formatPhone } from "../components/NumberCard";
import { StatusBadge } from "../components/StatusBadge";
import { selectHouseholdLine } from "../lib/household-line";

export function HomePage() {
  const { bootstrap } = useFamilyFax();
  const line = selectHouseholdLine(
    bootstrap.activeNumbers,
    bootstrap.config.provider,
    bootstrap.config.householdLineId,
  );

  return (
    <>
      <section className="home-hero">
        <div>
          <p className="eyebrow">Private household utility</p>
          <h1>Fax the thing.<br /><em>Then move on.</em></h1>
          <p className="hero-copy">A simple family fax line for the occasional office that still lives in 1997.</p>
        </div>
        <div className="fax-slip" aria-hidden="true">
          <span>LINE STATUS</span>
          <strong>{line ? "OPEN" : "SETUP"}</strong>
          <small>{new Date().toLocaleDateString()}</small>
        </div>
      </section>

      <section className="task-grid two-tasks" aria-label="Choose a fax task">
        <TaskCard to="/send" number="01" title="Send a fax" detail="Build, preview, and send from the household line." action="Send something" />
        <TaskCard to="/receive" number="02" title="Receive a fax" detail="Share the household number and watch for incoming documents." action="Show fax number" />
      </section>

      <section className="home-section household-line-strip">
        <div>
          <p className="section-kicker">Household fax line</p>
          <h2>{line?.e164 ? formatPhone(line.e164) : "No line is open yet"}</h2>
          <p className="quiet-note">{line
            ? `Incoming faxes forward to ${line.forwardingEmail}.`
            : "Open one retained line when you are ready to send or receive."}</p>
        </div>
        <Link className="button button-secondary" to="/fax-line">{line ? "Manage fax line" : "Open fax line"}</Link>
      </section>

      <section className="home-section recent-strip">
        <div className="section-heading-row">
          <div><p className="section-kicker">Last transmissions</p><h2>Recent activity</h2></div>
          <Link to="/activity">See everything</Link>
        </div>
        {bootstrap.recentFaxes.length === 0 ? <p className="quiet-note">Nothing sent or received yet.</p> : (
          <ul className="compact-activity">{bootstrap.recentFaxes.slice(0, 4).map((fax) => (
            <li key={fax.id}><Link to={`/activity/${fax.id}`}><span>{fax.direction === "inbound" ? "From" : "To"} {fax.direction === "inbound" ? fax.fromNumber : fax.toNumber}</span><StatusBadge state={fax.state} /></Link></li>
          ))}</ul>
        )}
      </section>
    </>
  );
}

function TaskCard({ to, number, title, detail, action }: { to: string; number: string; title: string; detail: string; action: string }) {
  return (
    <Link to={to} className="task-card" aria-label={title}>
      <span className="task-number">{number}</span>
      <h2>{title}</h2>
      <p>{detail}</p>
      <strong>{action}<span aria-hidden="true"> →</span></strong>
    </Link>
  );
}
