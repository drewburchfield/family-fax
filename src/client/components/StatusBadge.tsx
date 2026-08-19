import type { FaxState, TemporaryNumberState } from "../../shared/contracts";

const labels: Record<FaxState | TemporaryNumberState, string> = {
  draft: "Draft",
  preparing: "Preparing",
  prepared: "Ready",
  provisioning: "Getting number",
  activating: "Activating",
  cleaning: "Cleaning up",
  active: "Ready to receive",
  submitting: "Handing off",
  submitted: "Accepted",
  sending: "Sending",
  delivered: "Delivered",
  failed: "Failed",
  canceled: "Canceled",
  status_unknown: "Needs review",
  completed: "Complete",
  requested: "Requested",
  expiring: "Expiring",
  releasing: "Releasing",
  released: "Released",
  provision_failed: "Setup failed",
  release_failed: "Release failed",
};

export function StatusBadge({ state }: { state: FaxState | TemporaryNumberState }) {
  const tone = ["delivered", "completed", "active"].includes(state)
    ? "success"
    : ["failed", "provision_failed", "release_failed", "status_unknown"].includes(state)
      ? "attention"
      : "working";
  return <span className={`status-badge status-${tone}`}>{labels[state]}</span>;
}
