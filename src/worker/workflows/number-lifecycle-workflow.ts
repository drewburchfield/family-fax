import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";

import type { NumberCandidate } from "../../providers/fax-provider";
import type { TemporaryNumberState } from "../../shared/contracts";
import type { NumberLifecycleWorkflowParams, WorkerEnv } from "../env";
import { createServiceContainer } from "../services";

interface NumberSnapshot {
  state: TemporaryNumberState;
  releaseAt: string | null;
}

const PROVISIONING_WAIT = [
  "10 seconds",
  "20 seconds",
  "30 seconds",
  "1 minute",
  "2 minutes",
  "5 minutes",
  "10 minutes",
] as const;

export class NumberLifecycleWorkflow extends WorkflowEntrypoint<WorkerEnv, NumberLifecycleWorkflowParams> {
  async run(event: Readonly<WorkflowEvent<NumberLifecycleWorkflowParams>>, step: WorkflowStep) {
    const { numbers, repository } = createServiceContainer(this.env);
    let provisioned = await step.do<NumberSnapshot | null>(
      "provision selected fax number once",
      { retries: { limit: 0, delay: "1 second" }, timeout: "2 minutes" },
      async () => {
        let number;
        try {
          number = await numbers.provisionNumber(event.payload.numberId, {
            ...event.payload.candidate,
            raw: { source: "confirmed_number_quote" },
          } satisfies NumberCandidate);
        } catch {
          number = await repository.getTemporaryNumber(event.payload.numberId);
          if (number?.state === "active") {
            number = await numbers.reconcileProvisioning(number.id);
          } else if (number?.state === "requested" && !number.e164) {
            number = await numbers.abortNumberRequest(
              number.id,
              "The number request could not reach the provider.",
            );
          }
        }
        if (!number) return null;
        await repository.updateTemporaryNumber(number.id, { workflowId: event.instanceId });
        return { state: number.state, releaseAt: number.releaseAt ?? number.expiresAt };
      },
    );
    if (!provisioned) return { state: "provision_failed" };

    for (
      let attempt = 0;
      ["requested", "provisioning", "activating"].includes(provisioned.state) && attempt <= PROVISIONING_WAIT.length;
      attempt += 1
    ) {
      if (attempt > 0) {
        await step.sleep(
          `wait for fax configuration ${attempt}`,
          PROVISIONING_WAIT[attempt - 1]!,
        );
      }
      provisioned = await step.do<NumberSnapshot>(
        `reconcile fax configuration ${attempt + 1}`,
        { retries: { limit: 3, delay: "10 seconds", backoff: "exponential" } },
        async () => {
          const current = await numbers.reconcileProvisioning(event.payload.numberId);
          return { state: current.state, releaseAt: current.releaseAt ?? current.expiresAt };
        },
      );
    }
    if (["requested", "provisioning"].includes(provisioned.state)) {
      provisioned = await step.do<NumberSnapshot>(
        "clean up unfinished number provisioning",
        { retries: { limit: 0, delay: "1 second" } },
        async () => {
          const current = await numbers.failProvisioning(
            event.payload.numberId,
            "The provider did not finish fax configuration within the readiness window.",
          );
          return { state: current.state, releaseAt: current.releaseAt ?? current.expiresAt };
        },
      );
    }
    if (provisioned.state !== "active") return provisioned;

    const number = await repository.getTemporaryNumber(event.payload.numberId);
    if (number?.mode !== "receive-only" && number?.faxJobId) {
      const faxJobId = number.faxJobId;
      await step.do("start outbound fax workflow", async () => {
        await this.env.OUTBOUND_FAX_WORKFLOW.create({
          id: `outbound-${faxJobId}`,
          params: {
            faxJobId,
            temporaryNumberId: number.id,
            appBaseUrl: event.payload.appBaseUrl,
          },
          retention: { successRetention: "30 days", errorRetention: "30 days" },
        });
        return { started: true };
      });
    }

    for (let cycle = 0; cycle < 128; cycle += 1) {
      const snapshot = await step.do<NumberSnapshot>(`read expiration ${cycle + 1}`, async () => {
        const current = await repository.getTemporaryNumber(event.payload.numberId);
        return { state: current?.state ?? "released", releaseAt: current?.releaseAt ?? current?.expiresAt ?? null };
      });
      if (["released", "provision_failed"].includes(snapshot.state) || !snapshot.releaseAt) {
        return snapshot;
      }
      await step.sleepUntil(`hold number until scheduled release ${cycle + 1}`, new Date(snapshot.releaseAt));
      const decision = await step.do<{ expired: boolean; awaitingTerminalFax: boolean; state: string }>(
        `confirm expiration ${cycle + 1}`,
        async () => {
          const current = await repository.getTemporaryNumber(event.payload.numberId);
          const job = current?.faxJobId
            ? await repository.getFaxJob(current.faxJobId)
            : null;
          const awaitingTerminalFax = current?.releasePolicy === "after-send" && Boolean(
            job && !["delivered", "failed", "canceled", "completed"].includes(job.state),
          );
          return {
            expired: Boolean(
              (current?.releaseAt ?? current?.expiresAt) &&
              (current?.releaseAt ?? current?.expiresAt)! <= new Date().toISOString() &&
              !awaitingTerminalFax,
            ),
            awaitingTerminalFax,
            state: current?.state ?? "released",
          };
        },
      );
      if (["released", "provision_failed"].includes(decision.state)) return decision;
      if (decision.awaitingTerminalFax) {
        await step.sleep(`wait for terminal fax ${cycle + 1}`, "15 minutes");
        continue;
      }
      if (!decision.expired) continue;
      return step.do(
        "release expired fax number",
        { retries: { limit: 5, delay: "1 minute", backoff: "exponential" } },
        async () => {
          const released = await numbers.releaseNumber(event.payload.numberId);
          return { state: released.state, releaseAt: released.releaseAt ?? released.expiresAt };
        },
      );
    }
    return { state: "expiration_monitor_exhausted" };
  }
}
