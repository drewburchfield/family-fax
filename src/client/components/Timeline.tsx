import type { FaxEvent } from "../../shared/contracts";
import { StatusBadge } from "./StatusBadge";

export function Timeline({ events }: { events: FaxEvent[] }) {
  if (events.length === 0) return <p className="quiet-note">No transmission events yet.</p>;
  return (
    <ol className="timeline">
      {events.map((event) => (
        <li key={event.id}>
          <span className="timeline-dot" />
          <div>
            <strong>{eventLabel(event.type)}</strong>
            <time dateTime={event.createdAt}>{new Date(event.createdAt).toLocaleString()}</time>
            {event.resultingState ? <StatusBadge state={event.resultingState as Parameters<typeof StatusBadge>[0]["state"]} /> : null}
          </div>
        </li>
      ))}
    </ol>
  );
}
function eventLabel(type: string): string {
  return type.replaceAll(".", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}
