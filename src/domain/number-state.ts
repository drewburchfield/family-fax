import type { TemporaryNumberState } from "../shared/contracts";
import { InvalidTransitionError } from "./errors";

const transitions: Record<TemporaryNumberState, ReadonlySet<TemporaryNumberState>> = {
  requested: new Set(["provisioning", "cleaning", "active", "provision_failed", "release_failed"]),
  provisioning: new Set(["requested", "activating", "cleaning", "provision_failed", "release_failed"]),
  activating: new Set(["provisioning", "active"]),
  cleaning: new Set(["provision_failed", "release_failed"]),
  active: new Set(["expiring", "releasing"]),
  expiring: new Set(["active", "releasing"]),
  releasing: new Set(["released", "release_failed"]),
  release_failed: new Set(["releasing", "released"]),
  provision_failed: new Set(["requested"]),
  released: new Set(),
};

export function canTransitionNumber(from: TemporaryNumberState, to: TemporaryNumberState): boolean {
  return transitions[from].has(to);
}

export function transitionNumber(
  from: TemporaryNumberState,
  to: TemporaryNumberState,
): TemporaryNumberState {
  if (!canTransitionNumber(from, to)) {
    throw new InvalidTransitionError("number", from, to);
  }

  return to;
}

export function isTerminalNumberState(state: TemporaryNumberState): boolean {
  return state === "released";
}
