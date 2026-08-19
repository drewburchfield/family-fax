import type { WorkerEnv } from "./env";
import { handleScheduled } from "./scheduled";
import { createApp } from "../server/http/app";

export { NumberLifecycleWorkflow } from "./workflows/number-lifecycle-workflow";
export { OutboundFaxWorkflow } from "./workflows/outbound-fax-workflow";

const app = createApp();

const worker = {
  async fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext): Promise<Response> {
    return app.fetch(request, env, ctx);
  },
  async scheduled(_controller: ScheduledController, env: WorkerEnv, ctx: ExecutionContext) {
    ctx.waitUntil(handleScheduled(env));
  },
};

export default worker;
