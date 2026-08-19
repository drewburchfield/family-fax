import type { FaxState } from "../shared/contracts";
import { InvalidTransitionError } from "./errors";

const transitions: Record<FaxState, ReadonlySet<FaxState>> = {
  draft: new Set(["preparing", "canceled"]),
  preparing: new Set(["prepared", "failed", "canceled"]),
  prepared: new Set(["provisioning", "submitting", "canceled"]),
  provisioning: new Set(["active", "submitting", "failed", "canceled"]),
  active: new Set(["submitting", "completed", "canceled", "failed"]),
  submitting: new Set(["submitted", "delivered", "failed", "status_unknown"]),
  submitted: new Set(["sending", "delivered", "failed", "status_unknown"]),
  sending: new Set(["delivered", "failed", "status_unknown"]),
  status_unknown: new Set(["submitted", "sending", "delivered", "failed", "canceled"]),
  delivered: new Set(),
  failed: new Set(),
  canceled: new Set(),
  completed: new Set(),
};

export function canTransitionFax(from: FaxState, to: FaxState): boolean {
  return transitions[from].has(to);
}

export function transitionFax(from: FaxState, to: FaxState): FaxState {
  if (!canTransitionFax(from, to)) {
    throw new InvalidTransitionError("fax", from, to);
  }

  return to;
}

export function isTerminalFaxState(state: FaxState): boolean {
  return transitions[state].size === 0;
}
