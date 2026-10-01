/**
 * Stand-in for the `cloudflare:workers` module under Vitest in Node (aliased in vitest.config.ts).
 * The real base classes only store ctx and env; the runtime does the rest.
 */

export class DurableObject<Env = unknown> {
  protected ctx: DurableObjectState
  protected env: Env
  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx
    this.env = env
  }
}

export class WorkflowEntrypoint<Env = unknown> {
  protected ctx: ExecutionContext
  protected env: Env
  constructor(ctx: ExecutionContext, env: Env) {
    this.ctx = ctx
    this.env = env
  }
}
