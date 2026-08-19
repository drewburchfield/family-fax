import { useEffect, type Dispatch, type SetStateAction } from "react";

import type { TemporaryNumber } from "../../shared/contracts";
import { api } from "../api/client";

export function useTemporaryNumberPoll(
  number: TemporaryNumber | null,
  setNumber: Dispatch<SetStateAction<TemporaryNumber | null>>,
  setError: Dispatch<SetStateAction<Error | null>>,
  intervalMs = 1_000,
) {
  const numberId = number?.id;
  const numberState = number?.state;

  useEffect(() => {
    if (!numberId || !["requested", "provisioning", "activating", "cleaning"].includes(numberState ?? "")) return;
    let current = true;
    let timer: number | undefined;

    const poll = async () => {
      try {
        const updated = await api.getNumber(numberId);
        if (current) {
          setError(null);
          setNumber(updated);
        }
      } catch (caught) {
        if (current) {
          setError(caught instanceof Error ? caught : new Error("The fax line status could not be refreshed."));
        }
      } finally {
        if (current) timer = window.setTimeout(poll, intervalMs);
      }
    };

    timer = window.setTimeout(poll, intervalMs);
    return () => {
      current = false;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [intervalMs, numberId, numberState, setError, setNumber]);
}
