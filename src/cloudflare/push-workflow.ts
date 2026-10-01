/**
 * PushWorkflow: started by `triggers.events` for every `cf.artifacts.repo.pushed` in the namespace.
 * It maps the repo to its project (`projectIdOf`) and hands the push to that ProjectDO in a
 * retried step. The DO's onPushEvent is idempotent per (repo, after), and reconcile catches any
 * push whose event never arrives.
 *
 * How the trigger delivers the event to `run()` is not documented, so parsing accepts the
 * CloudEvent itself, a wrapper whose `payload` or `body` (object or JSON text) is the CloudEvent,
 * the bare inner payload when it names the repo, or a batch of any of those.
 */

import { WorkflowEntrypoint } from "cloudflare:workers"
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers"
import { isProjectId, isRepoName, projectIdOf } from "../core/names.ts"
import type { Env } from "./env.ts"
import { namespaceOf, workerLog } from "./env.ts"
import { projectStub } from "./host.ts"

export const PUSHED = "cf.artifacts.repo.pushed"
const SHA = /^[0-9a-f]{40}$/
const ZERO = /^0{40}$/

export type PushEvent = {
  repo: string
  ref: string
  after: string
  before: string | null
  /** Null when the event did not say. */
  namespace: string | null
}

type Obj = Record<string, unknown>

function obj(value: unknown): Obj | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Obj) : null
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null
}

function parsed(value: unknown): unknown {
  if (typeof value !== "string") return value
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

/** Peels wrappers until something looks like the push itself: it has a `type`, a `source`, or a push payload. */
function unwrap(input: unknown): Obj | null {
  let current = obj(parsed(input))
  for (let depth = 0; current && depth < 4; depth++) {
    if (text(current.type)?.startsWith("cf.") || obj(current.source) || text(current.after)) return current
    const inner = current.body ?? current.payload ?? current.event ?? current.data
    current = obj(parsed(inner))
  }
  return null
}

/** The push in any of the shapes above, or null for other events, deleted refs and anything malformed. */
export function parsePushEvent(input: unknown): PushEvent | null {
  const event = unwrap(input)
  if (!event) return null
  const type = text(event.type)
  if (type && type !== PUSHED) return null
  const source = obj(event.source)
  const inner = obj(parsed(event.payload))
  const data = inner && (text(inner.after) || text(inner.ref)) ? inner : event
  const repo =
    text(source?.repoName) ??
    text(source?.repo_name) ??
    text(source?.repo) ??
    text(data.repoName) ??
    text(data.repo_name) ??
    text(data.repo) ??
    text(event.repoName)
  const namespace = text(source?.namespace) ?? text(data.namespace) ?? text(event.namespace)
  const ref = text(data.ref)
  const after = text(data.after)?.toLowerCase() ?? null
  const before = text(data.before)?.toLowerCase() ?? null
  if (!repo || !isRepoName(repo) || !ref || !ref.startsWith("refs/") || !after || !SHA.test(after) || ZERO.test(after)) return null
  return { repo, ref, after, before: before && SHA.test(before) ? before : null, namespace }
}

/** Every push in the input: one event, or a batch (`[...]`, `{ events: [...] }`, `{ messages: [...] }`). */
export function parsePushEvents(input: unknown): PushEvent[] {
  const value = parsed(input)
  const holder = obj(value)
  const batch = Array.isArray(value)
    ? value
    : [holder?.events, holder?.messages, parsed(holder?.payload)].find((item): item is unknown[] => Array.isArray(item))
  const items = batch ?? [value]
  return items.map((item) => parsePushEvent(item)).filter((push): push is PushEvent => push !== null)
}

export type PushOutcome =
  | { done: true; projectId: string; repo: string; after: string }
  | { skipped: string }
  | { refused: string; status: number }
  | { batch: PushOutcome[] }

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
  const pushes = parsePushEvents(payload)
  if (pushes.length === 0) {
    workerLog.warn("push workflow got an event it does not understand", { sample: JSON.stringify(payload ?? null).slice(0, 300) })
    return { skipped: "not a push event" }
  }
  const outcomes: PushOutcome[] = []
  for (const push of pushes) outcomes.push(await handleOne(env, push, step))
  return outcomes.length === 1 && outcomes[0] ? outcomes[0] : { batch: outcomes }
}

async function handleOne(env: Pick<Env, "PROJECT" | "ARTIFACTS_NAMESPACE">, push: PushEvent, step: StepRunner): Promise<PushOutcome> {
  const namespace = namespaceOf(env)
  if (push.namespace && push.namespace !== namespace) return { skipped: `namespace ${push.namespace} is not ${namespace}` }
  if (push.ref !== "refs/heads/main") return { skipped: `${push.ref} is not main` }
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
