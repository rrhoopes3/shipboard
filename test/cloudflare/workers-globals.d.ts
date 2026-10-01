/**
 * Lets the Node test project (root tsconfig.json) typecheck src/cloudflare and these tests.
 * Mixing the ambient @cloudflare/workers-types with @types/node breaks Node's Buffer typings in
 * src/local, so here the binding types come from the module form of workers-types instead, and
 * the request-shaped types are Node's own. src/cloudflare/tsconfig.json still checks the Worker
 * against the real ambient types.
 */

type Artifacts = import("@cloudflare/workers-types/index.ts").Artifacts
type ArtifactsRepo = import("@cloudflare/workers-types/index.ts").ArtifactsRepo
type ArtifactsError = import("@cloudflare/workers-types/index.ts").ArtifactsError
type ArtifactsErrorCode = import("@cloudflare/workers-types/index.ts").ArtifactsErrorCode
type ArtifactsCreateRepoResult = import("@cloudflare/workers-types/index.ts").ArtifactsCreateRepoResult
type ArtifactsRepoListResult = import("@cloudflare/workers-types/index.ts").ArtifactsRepoListResult
type ArtifactsCreateTokenResult = import("@cloudflare/workers-types/index.ts").ArtifactsCreateTokenResult
type ArtifactsTokenListResult = import("@cloudflare/workers-types/index.ts").ArtifactsTokenListResult
type ArtifactsRepoInfo = import("@cloudflare/workers-types/index.ts").ArtifactsRepoInfo
type ArtifactsTreeEntry = import("@cloudflare/workers-types/index.ts").ArtifactsTreeEntry
type ArtifactsCommitMetadata = import("@cloudflare/workers-types/index.ts").ArtifactsCommitMetadata
type DurableObjectState = import("@cloudflare/workers-types/index.ts").DurableObjectState
type DurableObjectNamespace = import("@cloudflare/workers-types/index.ts").DurableObjectNamespace
type DurableObjectId = import("@cloudflare/workers-types/index.ts").DurableObjectId
type DurableObjectStub = import("@cloudflare/workers-types/index.ts").DurableObjectStub
type Workflow = import("@cloudflare/workers-types/index.ts").Workflow
type Ai = import("@cloudflare/workers-types/index.ts").Ai
type Fetcher = { fetch(input: Request | string, init?: RequestInit): Promise<Response> }
type ExecutionContext = { waitUntil(promise: Promise<unknown>): void; passThroughOnException(): void; props: unknown }
type ExportedHandler<Env = unknown> = {
  fetch?(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response>
}

declare module "cloudflare:workers" {
  export type WorkflowEvent<T> = import("@cloudflare/workers-types/index.ts").CloudflareWorkersModule.WorkflowEvent<T>
  export type WorkflowStep = import("@cloudflare/workers-types/index.ts").CloudflareWorkersModule.WorkflowStep
  export abstract class DurableObject<Env = unknown> {
    protected ctx: DurableObjectState
    protected env: Env
    constructor(ctx: DurableObjectState, env: Env)
    alarm?(): void | Promise<void>
  }
  export abstract class WorkflowEntrypoint<Env = unknown, T = unknown> {
    protected ctx: ExecutionContext
    protected env: Env
    constructor(ctx: ExecutionContext, env: Env)
    run(event: Readonly<WorkflowEvent<T>>, step: WorkflowStep): Promise<unknown>
  }
}
