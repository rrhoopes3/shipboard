import { describe, expect, it } from "vitest"
import { PUSHED, PushWorkflow, handlePush, parsePushEvent, retryable } from "../../src/cloudflare/push-workflow.ts"
import type { Envelope } from "../../src/cloudflare/rpc.ts"

const after = "def789aa012def789aa012def789aa012def7aaa"
const before = "abc123def456abc123def456abc123def456abc1"
const repo = "harbor-notes-3f2a--tint-the-pier-n-77de"

/** Synthetic example of the documented event shape, NOT a captured live event.
 * https://developers.cloudflare.com/queues/event-subscriptions/events-schemas/#pushed
 * A real Workflow input still needs to be captured after account login; see docs/DEPLOY.md.
 */
function cloudEvent(overrides: Record<string, unknown> = {}, payload: Record<string, unknown> = {}) {
  return {
    type: PUSHED,
    source: { type: "artifacts.repo", namespace: "shipboard", repoName: repo },
    payload: {
      ref: "refs/heads/main",
      before,
      after,
      commits: [{ id: after, message: "Tint the pier", parents: [before] }],
      totalCommitsCount: 1,
      commitsTruncated: false,
      ...payload,
    },
    metadata: { accountId: "acc", eventSubscriptionId: "sub", eventSchemaVersion: 1, eventTimestamp: "2026-10-01T00:00:00Z" },
    ...overrides,
  }
}

const expected = { repo, ref: "refs/heads/main", after, namespace: "shipboard" }

describe("parsePushEvent", () => {
  it("reads one event with the documented source and payload fields", () => {
    expect(parsePushEvent(cloudEvent())).toEqual(expected)
    expect(parsePushEvent(cloudEvent({}, { after: after.toUpperCase() }))).toEqual(expected)
  })

  it("rejects speculative wrappers, aliases, JSON strings and batches", () => {
    for (const input of [
      JSON.stringify(cloudEvent()),
      { payload: cloudEvent() },
      { body: cloudEvent() },
      { event: cloudEvent() },
      { data: cloudEvent() },
      { body: JSON.stringify(cloudEvent()) },
      { payload: { body: cloudEvent() } },
      { repoName: repo, namespace: "shipboard", ref: "refs/heads/main", before, after },
      cloudEvent({ source: { namespace: "shipboard", repo_name: repo } }),
      cloudEvent({ source: { namespace: "shipboard", repo } }),
      cloudEvent({ payload: JSON.stringify(cloudEvent().payload) }),
      [cloudEvent()],
      { events: [cloudEvent()] },
      { messages: [cloudEvent()] },
      { payload: [cloudEvent()] },
    ]) expect(parsePushEvent(input)).toBeNull()
  })

  it("rejects other events, missing repos and junk", () => {
    expect(parsePushEvent(cloudEvent({ type: "cf.artifacts.repo.forked" }))).toBeNull()
    expect(parsePushEvent(cloudEvent({ type: undefined }))).toBeNull()
    expect(parsePushEvent(cloudEvent({ source: { repoName: repo } }))).toBeNull()
    expect(parsePushEvent(cloudEvent({ source: { namespace: "", repoName: repo } }))).toBeNull()
    expect(parsePushEvent(cloudEvent({}, { after: "nope" }))).toBeNull()
    expect(parsePushEvent(cloudEvent({}, { ref: "main" }))).toBeNull()
    expect(parsePushEvent(cloudEvent({ source: { type: "artifacts.repo", namespace: "shipboard" } }))).toBeNull()
    expect(parsePushEvent(cloudEvent({ source: { repoName: "../etc" } }))).toBeNull()
    expect(parsePushEvent({ ref: "refs/heads/main", before, after })).toBeNull()
    expect(parsePushEvent({ body: "{not json" })).toBeNull()
    expect(parsePushEvent(null)).toBeNull()
    expect(parsePushEvent(42)).toBeNull()
    expect(parsePushEvent([cloudEvent()])).toBeNull()
  })


})

type PushCall = { repo: string; ref: string; after: string }

function fakeProjects(answer: () => Envelope<void>) {
  const calls: Array<{ name: string; event: PushCall }> = []
  const ns = {
    idFromName: (name: string) => ({ name, toString: () => name }),
    get: (id: { name: string }) => ({
      onPushEvent: async (event: PushCall) => {
        calls.push({ name: id.name, event })
        return answer()
      },
    }),
  }
  return { ns: ns as unknown as DurableObjectNamespace, calls }
}

function fakeStep() {
  const steps: Array<{ name: string; config: unknown }> = []
  return {
    steps,
    async do(name: string, config: unknown, fn?: () => Promise<unknown>) {
      steps.push({ name, config })
      const run = typeof config === "function" ? (config as () => Promise<unknown>) : fn
      if (!run) throw new Error("no callback")
      return run()
    },
  }
}

describe("handlePush", () => {
  it("routes a main push to the project's object inside one retried step", async () => {
    const { ns, calls } = fakeProjects(() => ({ ok: true, value: undefined }))
    const step = fakeStep()
    const out = await handlePush({ PROJECT: ns, ARTIFACTS_NAMESPACE: "shipboard" }, cloudEvent(), step as never)
    expect(out).toEqual({ done: true, projectId: "harbor-notes-3f2a", repo, after })
    expect(calls).toEqual([{ name: "harbor-notes-3f2a", event: { repo, ref: "refs/heads/main", after } }])
    expect(step.steps[0]?.name).toBe(`assess ${repo} at ${after.slice(0, 12)}`)
    expect(step.steps[0]?.config).toMatchObject({ retries: { limit: 5, backoff: "exponential" } })
  })

  it("routes a push to a project's main repo by its own name", async () => {
    const { ns, calls } = fakeProjects(() => ({ ok: true, value: undefined }))
    const event = cloudEvent({ source: { type: "artifacts.repo", namespace: "shipboard", repoName: "harbor-notes-3f2a" } })
    await handlePush({ PROJECT: ns }, event, fakeStep() as never)
    expect(calls[0]?.name).toBe("harbor-notes-3f2a")
  })

  it("skips other namespaces, other refs and ref deletion without touching a project", async () => {
    const { ns, calls } = fakeProjects(() => ({ ok: true, value: undefined }))
    const env = { PROJECT: ns, ARTIFACTS_NAMESPACE: "shipboard" }
    expect(await handlePush(env, cloudEvent({ source: { namespace: "other", repoName: repo } }), fakeStep() as never)).toEqual({
      skipped: "namespace other is not shipboard",
    })
    expect(await handlePush(env, cloudEvent({}, { ref: "refs/heads/feature" }), fakeStep() as never)).toEqual({
      skipped: "refs/heads/feature is not main",
    })
    expect(await handlePush(env, cloudEvent({}, { ref: "refs/tags/v1" }), fakeStep() as never)).toEqual({ skipped: "refs/tags/v1 is not main" })
    expect(await handlePush(env, cloudEvent({}, { after: "0".repeat(40) }), fakeStep() as never)).toEqual({ skipped: "deleted ref" })
    expect(calls).toHaveLength(0)
  })

  it("fails the Workflow visibly for an unsupported envelope or malformed push", async () => {
    const { ns, calls } = fakeProjects(() => ({ ok: true, value: undefined }))
    const workflow = new PushWorkflow({} as ExecutionContext, { PROJECT: ns } as never)
    for (const input of [{ body: cloudEvent() }, JSON.stringify(cloudEvent()), [cloudEvent()], cloudEvent({}, { after: "bad" })]) {
      const step = fakeStep()
      await expect(workflow.run(
        { payload: input, timestamp: new Date(), instanceId: "bad-input", workflowName: "shipboard-push" }, step as never,
      )).rejects.toThrow("Unsupported Artifacts push event")
      expect(step.steps).toHaveLength(0)
    }
    expect(calls).toHaveLength(0)
  })

  it("throws inside the step on retryable answers so Workflows retries, and settles on final ones", async () => {
    let status = 503
    const { ns } = fakeProjects(() => ({ ok: false, error: { message: "busy", status, code: "busy" } }))
    await expect(handlePush({ PROJECT: ns }, cloudEvent(), fakeStep() as never)).rejects.toThrow(/busy \(503\)/)
    status = 404
    expect(await handlePush({ PROJECT: ns }, cloudEvent(), fakeStep() as never)).toEqual({ refused: "busy", status: 404 })
    expect(retryable(500)).toBe(true)
    expect(retryable(409)).toBe(true)
    expect(retryable(429)).toBe(true)
    expect(retryable(400)).toBe(false)
    expect(retryable(404)).toBe(false)
  })

  it("runs as the Workflow entrypoint on event.payload", async () => {
    const { ns, calls } = fakeProjects(() => ({ ok: true, value: undefined }))
    const workflow = new PushWorkflow({} as ExecutionContext, { PROJECT: ns, ARTIFACTS_NAMESPACE: "shipboard" } as never)
    const out = await workflow.run(
      { payload: cloudEvent(), timestamp: new Date(), instanceId: "i-1", workflowName: "shipboard-push" },
      fakeStep() as never,
    )
    expect(out).toMatchObject({ done: true })
    expect(calls).toHaveLength(1)
  })
})
