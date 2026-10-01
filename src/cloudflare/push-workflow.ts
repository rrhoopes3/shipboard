/**
 * PushWorkflow: started by `triggers.events` for every `cf.artifacts.repo.pushed` in the namespace.
 * It maps the repo to its project (`projectIdOf`) and hands the push to that ProjectDO in a
 * retried step. The DO's onPushEvent is idempotent per (repo, after), and reconcile catches any
 * push whose event never arrives.
 *
 * Parse the documented Artifacts event from `event.payload`, with source.namespace/source.repoName
 * and payload.ref/payload.after. An unsupported envelope fails the Workflow visibly; reconcile
 * remains the fallback while deployment evidence is collected (docs/DEPLOY.md).
 * https://developers.cloudflare.com/queues/event-subscriptions/events-schemas/#pushed
 */

import { WorkflowEntrypoint } from "cloudflare:workers"
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers"
import { isProjectId, isRepoName, projectIdOf } from "../core/names.ts"
import type { Env } from "./env.ts"
import { namespaceOf } from "./env.ts"
import { projectStub } from "./host.ts"

export const PUSHED = "cf.artifacts.repo.pushed"
const SHA = /^[0-9a-f]{40}$/
const ZERO = /^0{40}$/

export type PushEvent = {
  repo: string
  ref: string
  after: string
  namespace: string
}

type Obj = Record<string, unknown>

function obj(value: unknown): Obj | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Obj) : null
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null
}

/** Read one documented push event, normalizing its hexadecimal head. Zero denotes ref deletion. */
export function parsePushEvent(input: unknown): PushEvent | null {
  const event = obj(input)
  if (event?.type !== PUSHED) return null
  const source = obj(event.source)
  const payload = obj(event.payload)
  const repo = text(source?.repoName)
  const namespace = text(source?.namespace)
  const ref = text(payload?.ref)
  const after = text(payload?.after)?.toLowerCase()
  if (!namespace || !repo || !isRepoName(repo) || !ref || !ref.startsWith("refs/") || !after || !SHA.test(after)) return null
  return { repo, ref, after, namespace }
}

export type PushOutcome =
  | { done: true; projectId: string; repo: string; after: string }
  | { skipped: string }
  | { refused: string; status: number }

/** Statuses worth another try: the project or a remote was busy or broken. 4xx answers are final. */
export function retryable(status: number): boolean {
  return status >= 500 || status === 409 || status === 429
}

export class PushWorkflow extends WorkflowEntrypoint<Env, unknown> {
  async run(event: Readonly<WorkflowEvent<unknown>>, step: WorkflowStep): Promise<PushOutcome> {
    return handlePush(this.env, event.payload, step)
  }
}

type StepRunner = Pick<WorkflowStep, "do">

export async function handlePush(env: Pick<Env, "PROJECT" | "ARTIFACTS_NAMESPACE">, payload: unknown, step: StepRunner): Promise<PushOutcome> {
  const push = parsePushEvent(payload)
  if (!push) {
    throw new Error("Unsupported Artifacts push event. Inspect this Workflow instance's input and verify the trigger envelope; see docs/DEPLOY.md.")
  }
  const namespace = namespaceOf(env)
  if (push.namespace !== namespace) return { skipped: `namespace ${push.namespace} is not ${namespace}` }
  if (push.ref !== "refs/heads/main") return { skipped: `${push.ref} is not main` }
  if (ZERO.test(push.after)) return { skipped: "deleted ref" }
  const projectId = projectIdOf(push.repo)
  if (!isProjectId(projectId)) return { skipped: `${push.repo} is not a shipboard repo` }

  return step.do(
    `assess ${push.repo} at ${push.after.slice(0, 12)}`,
    { retries: { limit: 5, delay: "10 seconds", backoff: "exponential" }, timeout: "5 minutes" },
    async (): Promise<PushOutcome> => {
      const result = await projectStub(env.PROJECT, projectId).onPushEvent({ repo: push.repo, ref: push.ref, after: push.after })
      if (result.ok) return { done: true, projectId, repo: push.repo, after: push.after }
      if (retryable(result.error.status)) throw new Error(`${push.repo}: ${result.error.message} (${result.error.status})`)
      return { refused: result.error.message, status: result.error.status }
    },
  )
}
