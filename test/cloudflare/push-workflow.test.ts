import { describe, expect, it } from "vitest"
import { PUSHED, PushWorkflow, handlePush, parsePushEvent, parsePushEvents, retryable } from "../../src/cloudflare/push-workflow.ts"
import type { Envelope } from "../../src/cloudflare/rpc.ts"

const after = "def789aa012def789aa012def789aa012def7aaa"
const before = "abc123def456abc123def456abc123def456abc1"
const repo = "harbor-notes-3f2a--tint-the-pier-n-77de"

/** The documented `cf.artifacts.repo.pushed` CloudEvent. */
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

const expected = { repo, ref: "refs/heads/main", after, before, namespace: "shipboard" }

describe("parsePushEvent", () => {
  it("reads the CloudEvent however the trigger wraps it", () => {
    expect(parsePushEvent(cloudEvent())).toEqual(expected)
    expect(parsePushEvent({ payload: cloudEvent() })).toEqual(expected)
    expect(parsePushEvent({ body: JSON.stringify(cloudEvent()) })).toEqual(expected)
    expect(parsePushEvent({ body: cloudEvent() })).toEqual(expected)
    expect(parsePushEvent(JSON.stringify(cloudEvent()))).toEqual(expected)
    expect(parsePushEvent({ payload: { body: JSON.stringify(cloudEvent()) } })).toEqual(expected)
    expect(parsePushEvent({ type: "workflow", payload: cloudEvent() })).toEqual(expected)
  })

  it("accepts a bare payload that names its repo, and snake_case source keys", () => {
    expect(parsePushEvent({ repoName: repo, ref: "refs/heads/main", before, after })).toEqual({ ...expected, namespace: null })
    expect(parsePushEvent(cloudEvent({ source: { type: "artifacts.repo", namespace: "shipboard", repo_name: repo } }))).toEqual(expected)
    expect(parsePushEvent({ ...cloudEvent(), payload: JSON.stringify(cloudEvent().payload) })).toEqual(expected)
    expect(parsePushEvent(cloudEvent({}, { after: after.toUpperCase() }))?.after).toBe(after)
  })

  it("ignores other events, deleted refs, missing repos and junk", () => {
    expect(parsePushEvent(cloudEvent({ type: "cf.artifacts.repo.forked" }))).toBeNull()
    expect(parsePushEvent(cloudEvent({}, { after: "0".repeat(40) }))).toBeNull()
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

  it("reads a batch of events, dropping the ones that are not pushes", () => {
    const other = cloudEvent({ source: { type: "artifacts.repo", namespace: "shipboard", repoName: "harbor-notes-3f2a" } })
    expect(parsePushEvents([cloudEvent(), other])).toHaveLength(2)
    expect(parsePushEvents({ events: [cloudEvent(), { type: "cf.artifacts.repo.forked" }] })).toEqual([expected])
    expect(parsePushEvents({ messages: [{ body: JSON.stringify(cloudEvent()) }] })).toEqual([expected])
    expect(parsePushEvents(cloudEvent())).toEqual([expected])
    expect(parsePushEvents({ nothing: true })).toEqual([])
  })

  it("keeps a malformed before out of the result", () => {
    expect(parsePushEvent(cloudEvent({}, { before: "0".repeat(40) }))?.before).toBe("0".repeat(40))
    expect(parsePushEvent(cloudEvent({}, { before: "x" }))?.before).toBeNull()
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

  it("skips other namespaces, other refs and events it cannot read, without touching a project", async () => {
    const { ns, calls } = fakeProjects(() => ({ ok: true, value: undefined }))
    const env = { PROJECT: ns, ARTIFACTS_NAMESPACE: "shipboard" }
    expect(await handlePush(env, cloudEvent({ source: { namespace: "other", repoName: repo } }), fakeStep() as never)).toEqual({
      skipped: "namespace other is not shipboard",
    })
    expect(await handlePush(env, cloudEvent({}, { ref: "refs/heads/feature" }), fakeStep() as never)).toEqual({
      skipped: "refs/heads/feature is not main",
    })
    expect(await handlePush(env, cloudEvent({}, { ref: "refs/tags/v1" }), fakeStep() as never)).toEqual({ skipped: "refs/tags/v1 is not main" })
    expect(await handlePush(env, { hello: "world" }, fakeStep() as never)).toEqual({ skipped: "not a push event" })
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

  it("handles each push of a batch in its own step", async () => {
    const { ns, calls } = fakeProjects(() => ({ ok: true, value: undefined }))
    const step = fakeStep()
    const main = cloudEvent({ source: { type: "artifacts.repo", namespace: "shipboard", repoName: "harbor-notes-3f2a" } })
    const out = await handlePush({ PROJECT: ns }, [cloudEvent(), main], step as never)
    expect(out).toMatchObject({ batch: [{ done: true, repo }, { done: true, repo: "harbor-notes-3f2a" }] })
    expect(step.steps.map((s) => s.name)).toEqual([`assess ${repo} at ${after.slice(0, 12)}`, `assess harbor-notes-3f2a at ${after.slice(0, 12)}`])
    expect(calls).toHaveLength(2)
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
