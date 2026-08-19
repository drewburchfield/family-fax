import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowSleepDuration,
  type WorkflowStep,
} from "cloudflare:workers";

import type { FaxState } from "../../shared/contracts";
import type { OutboundFaxWorkflowParams, WorkerEnv } from "../env";
import { createServiceContainer } from "../services";
import {
  pollDelayForAttempt,
  providerInteractionBaseUrl,
  shouldPollFax,
} from "./workflow-policy";

interface FaxSnapshot {
  state: FaxState;
  providerFaxId: string | null;
  failureCode: string | null;
}

const terminalFaxStates: FaxState[] = ["delivered", "failed", "canceled", "completed"];

export class OutboundFaxWorkflow extends WorkflowEntrypoint<WorkerEnv, OutboundFaxWorkflowParams> {
  async run(event: Readonly<WorkflowEvent<OutboundFaxWorkflowParams>>, step: WorkflowStep) {
    const { fax, terminal, repository, config, provider } = createServiceContainer(this.env);
    const baseUrl = config.appBaseUrl ?? event.payload.appBaseUrl;
    const providerBaseUrl = providerInteractionBaseUrl(baseUrl, config.webhook);
    const callbackUrl = buildCallbackUrl(baseUrl, config.webhook, provider.name);

    let snapshot = await step.do<FaxSnapshot>(
      "submit fax exactly once",
      { retries: { limit: 0, delay: "1 second" }, timeout: "2 minutes" },
      async () => {
        const token = await fax.createProviderContentToken(event.payload.faxJobId, providerBaseUrl);
        try {
          const job = await fax.submitOutbound(event.payload.faxJobId, {
            contentUrl: token.url,
            callbackUrl,
          });
          return {
            state: job.state,
            providerFaxId: job.providerFaxId,
            failureCode: job.failureCode,
          };
        } catch (error) {
          const current = await repository.getFaxJob(event.payload.faxJobId);
          if (current && [
            "status_unknown",
            "submitted",
            "sending",
            "delivered",
            "failed",
            "canceled",
            "completed",
          ].includes(current.state)) {
            return {
              state: current.state,
              providerFaxId: current.providerFaxId,
              failureCode: current.failureCode,
            };
          }
          throw error;
        }
      },
    );

    for (
      let attempt = 0;
      attempt < 12 && shouldPollFax(snapshot.state, snapshot.failureCode);
      attempt += 1
    ) {
      await step.sleep(
        `wait for webhook ${attempt + 1}`,
        pollDelayForAttempt(attempt) as WorkflowSleepDuration,
      );
      snapshot = await step.do<FaxSnapshot>(
        `poll provider status ${attempt + 1}`,
        { retries: { limit: 3, delay: "10 seconds", backoff: "exponential" } },
        async () => {
          const current = await repository.getFaxJob(event.payload.faxJobId);
          if (!current || terminalFaxStates.includes(current.state)) {
            return {
              state: current?.state ?? "status_unknown",
              providerFaxId: current?.providerFaxId ?? null,
              failureCode: current?.failureCode ?? null,
            };
          }
          const reconciled = await fax.reconcileOutbound(event.payload.faxJobId);
          return {
            state: reconciled.state,
            providerFaxId: reconciled.providerFaxId,
            failureCode: reconciled.failureCode,
          };
        },
      );
    }

    const finalJob = await step.do<FaxSnapshot>("read final fax state", async () => {
      const job = await repository.getFaxJob(event.payload.faxJobId);
      return {
        state: job?.state ?? "status_unknown",
        providerFaxId: job?.providerFaxId ?? null,
        failureCode: job?.failureCode ?? null,
      };
    });
    if (terminalFaxStates.includes(finalJob.state)) {
      await step.do(
        "complete terminal fax",
        { retries: { limit: 5, delay: "1 minute", backoff: "exponential" } },
        () => terminal.complete(event.payload.faxJobId),
      );
    }
    return finalJob;
  }
}

function buildCallbackUrl(
  baseUrl: string,
  webhook: { baseUrl: string; username: string; password: string } | undefined,
  provider: "demo" | "sinch" | "signalwire",
): string {
  const path = provider === "signalwire" ? "/webhooks/signalwire/fax" : "/webhooks/sinch";
  const url = new URL(path, webhook?.baseUrl ?? baseUrl);
  if (webhook) {
    url.username = webhook.username;
    url.password = webhook.password;
  }
  return url.toString();
}
