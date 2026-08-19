export class WorkflowEntrypoint<Environment, Payload> {
  protected env!: Environment;
  protected ctx!: ExecutionContext;

  async run(_event: WorkflowEvent<Payload>, _step: WorkflowStep): Promise<unknown> {
    throw new Error("WorkflowEntrypoint test stub");
  }
}
