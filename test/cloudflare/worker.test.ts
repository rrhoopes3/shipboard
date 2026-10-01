/**
 * The Worker end to end in Node: worker.fetch → shared API → CloudflareHost → ProjectDO (over a
 * fake RPC boundary) → core → CloudflareArtifacts → FakeArtifacts → real git over HTTP.
 */

import fs from "node:fs/promises"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { BUSY_TICK_MS, IDLE_TICK_MS, nextTickAt } from "../../src/cloudflare/project-do.ts"
import { handlePush, PUSHED } from "../../src/cloudflare/push-workflow.ts"
import worker from "../../src/cloudflare/worker.ts"
import type { BoardView, ClaimedJob, GitCredentials, ProjectState } from "../../src/core/types.ts"
import { allTasks, bearer, cleanup, git, laneOf, taskByTitle, tempDir } from "../local/helpers.ts"
import { FakeArtifacts, fakeCtx, gitBackend, makeEnv } from "./fakes.ts"
import type { TestEnv } from "./fakes.ts"

const BOARD = "board-secret"
const RUNNER = "runner-secret"

let fake: FakeArtifacts
let close: () => Promise<void>

beforeEach(async () => {
  const backend = await gitBackend()
  close = backend.close
  fake = new FakeArtifacts(backend.local)
})

afterEach(async () => {
  await close()
  await cleanup()
})

type Client = {
  get(p: string, token?: string): Promise<Response>
  post(p: string, body?: unknown, token?: string, headers?: Record<string, string>): Promise<Response>
}

function client(env: TestEnv): Client {
  const send = async (request: Request) => {
    const ctx = fakeCtx()
    const res = await worker.fetch(request as Parameters<typeof worker.fetch>[0], env, ctx)
    await ctx.idle()
    return res
  }
  const auth = (token?: string): Record<string, string> => (token ? { Authorization: `Bearer ${token}` } : {})
  return {
    get: (p, token = BOARD) => send(new Request(`https://shipboard.example.workers.dev${p}`, { headers: auth(token) })),
    post: (p, body = {}, token = BOARD, headers = {}) =>
      send(
        new Request(`https://shipboard.example.workers.dev${p}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...auth(token), ...headers },
          body: JSON.stringify(body),
        }),
      ),
  }
}

async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T
}

async function storedState(env: TestEnv, projectId: string): Promise<ProjectState | undefined> {
  return env.PROJECT.entry(projectId).state.storage.get<ProjectState>("state")
}

describe("the Worker on fake Cloudflare bindings", () => {
  it("runs the harbor demo: ship two, the third conflicts, re-run it, ship it", async () => {
    fake.forkBusyGets = 1
    const env = makeEnv(fake)
    const api = client(env)

    const config = await json<{ mode: string; namespace: string; boardAuth: boolean; publicRead: boolean }>(await api.get("/api/config", ""))
    expect(config).toMatchObject({ mode: "cloudflare", namespace: "shipboard", boardAuth: true, publicRead: true })

    const created = await api.post("/api/demo")
    expect(created.status).toBe(201)
    const { projectId } = await json<{ projectId: string }>(created)
    await env.PROJECT.idle()

    const listed = await json<{ projects: Array<{ id: string }> }>(await api.get("/api/projects", ""))
    expect(listed.projects.map((p) => p.id)).toEqual([projectId])

    let board = await json<BoardView>(await api.get(`/api/projects/${projectId}`, ""))
    expect(allTasks(board)).toHaveLength(3)
    for (const task of allTasks(board)) {
      expect(task.current.status).toBe("ready")
      expect(task.current.merge?.state).toBe("clean")
      expect(task.lane).toBe("ship")
    }
    const footer = taskByTitle(board, "footer").current
    const rename = taskByTitle(board, "Rename").current
    const tint = taskByTitle(board, "Tint").current

    expect((await api.post(`/api/attempts/${footer.id}/ship`, { expectedHead: footer.headSha })).status).toBe(200)
    const shipped = await api.post(`/api/attempts/${rename.id}/ship`, { expectedHead: rename.headSha })
    expect(shipped.status).toBe(200)
    board = (await json<{ board: BoardView }>(shipped)).board
    const conflicted = taskByTitle(board, "Tint")
    expect(conflicted.lane).toBe("rerun")
    expect(conflicted.current.merge?.paths).toEqual(["site/index.html"])

    // The conflict's 409 and its sentence survive the RPC boundary.
    const refused = await api.post(`/api/attempts/${tint.id}/ship`, {})
    expect(refused.status).toBe(409)
    expect((await json<{ error: string }>(refused)).error).toMatch(/Re-run it/)

    const rerun = await api.post(`/api/attempts/${tint.id}/rerun`, {})
    expect(rerun.status).toBe(200)
    const { attemptId } = await json<{ attemptId: string }>(rerun)
    await env.PROJECT.idle()

    board = await json<BoardView>(await api.get(`/api/projects/${projectId}`))
    const again = taskByTitle(board, "Tint")
    expect(again.current.id).toBe(attemptId)
    expect(again.current.number).toBe(2)
    expect(again.current.baseSha).toBe(board.project.mainSha)
    expect(again.history[0]?.status).toBe("discarded")
    expect(again.history[0]?.discardReason).toBe("Conflicted with main in site/index.html.")
    const briefFile = `.shipboard/briefs/${again.brief.id}.json`
    expect(Buffer.from((await fake.local.readFile(attemptId, again.current.briefSha, briefFile)) ?? []).toString()).toBe(
      Buffer.from((await fake.local.readFile(tint.repo, tint.briefSha, briefFile)) ?? []).toString(),
    )

    const last = await api.post(`/api/attempts/${attemptId}/ship`, { expectedHead: again.current.headSha })
    expect(last.status).toBe(200)
    board = (await json<{ board: BoardView }>(last)).board
    expect(board.project.counts.shipped).toBe(3)
    const html = Buffer.from((await fake.local.readFile(projectId, "main", "site/index.html")) ?? []).toString()
    expect(html).toContain("Northline night board")
    expect(html).toContain("color:#1F6F78")
    expect(html).toContain("Posted by the night clerk.")

    const preview = await api.get(`/preview/${projectId}/${footer.id}/site/index.html`, "")
    expect(preview.status).toBe(200)
    expect(preview.headers.get("content-type")).toContain("text/html")
    expect(preview.headers.get("content-security-policy")).toContain("sandbox")
    expect(await preview.text()).toContain("night clerk")
    const bare = await api.get(`/preview/${projectId}/main/`, "")
    expect(bare.status).toBe(302)
    expect(bare.headers.get("location")).toBe(`/preview/${projectId}/main/site/`)

    const diff = await json<{ diff: string }>(await api.get(`/api/attempts/${footer.id}/diff`, ""))
    expect(diff.diff).toContain("+<footer>Posted by the night clerk.</footer>")

    // The whole project is one stored value, and a fresh object (after eviction) reads it back.
    const stored = await storedState(env, projectId)
    expect(stored?.version).toBe(board.version)
    env.PROJECT.evict(projectId)
    const reloaded = await json<BoardView>(await api.get(`/api/projects/${projectId}`))
    expect(reloaded.version).toBe(board.version)
    expect(reloaded.project.counts.shipped).toBe(3)
    expect(fake.disposed).toBe(fake.opened)
  })

  it("takes a manual push, hears about it through PushWorkflow, and reviews it", async () => {
    const replies: string[] = []
    const env = makeEnv(fake, {
      REVIEW_MODEL: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
      AI: {
        run: async (_model: string, _inputs: unknown) => {
          replies.push("asked")
          return { response: '{"verdict":"satisfies","note":"The lede reads ready for sea."}' }
        },
      } as unknown as Ai,
    })
    const api = client(env)
    const made = await api.post("/api/projects", { name: "Keel notes", description: "A quiet page." })
    expect(made.status).toBe(201)
    const { project } = await json<{ project: { id: string } }>(made)

    const res = await api.post(`/api/projects/${project.id}/tasks`, {
      task: "Set the lede",
      paths: ["site/index.html"],
      acceptance: 'contains site/index.html "ready for sea"',
      agent: "manual",
      credentials: true,
    })
    expect(res.status).toBe(201)
    const out = await json<{ board: BoardView; attemptId: string; credentials: GitCredentials }>(res)
    expect(out.credentials.scope).toBe("write")
    expect(out.credentials.token).toMatch(/^art_v1_[0-9a-f]{40}\?expires=\d+$/)
    expect(out.credentials.remote).toBe(fake.local.remote(out.attemptId))
    expect(laneOf(out.board, out.attemptId)).toBe("working")

    // A waiting attempt keeps the alarm armed, so reconcile runs even if no event arrives.
    const alarm = env.PROJECT.entry(project.id).state.storage.alarm
    expect(alarm).not.toBeNull()

    const work = await tempDir()
    expect((await git([...bearer(out.credentials.token), "clone", out.credentials.remote, work])).code).toBe(0)
    await fs.writeFile(path.join(work, "site", "index.html"), "<!DOCTYPE html><p id=lede>ready for sea</p>\n")
    expect((await git(["commit", "-am", "Set the lede"], { cwd: work })).code).toBe(0)
    const push = await git([...bearer(out.credentials.token), "push", "origin", "HEAD:main"], { cwd: work })
    expect(push.code, push.stderr).toBe(0)
    const after = (await git(["rev-parse", "HEAD"], { cwd: work })).stdout.trim()

    const event = {
      type: PUSHED,
      source: { type: "artifacts.repo", namespace: "shipboard", repoName: out.attemptId },
      payload: { ref: "refs/heads/main", before: out.board.lanes[0]?.tasks[0]?.current.headSha, after, commits: [] },
    }
    const step = { do: async (_name: string, _config: unknown, fn: () => Promise<unknown>) => fn() }
    expect(await handlePush(env, event, step as never)).toMatchObject({ done: true, repo: out.attemptId, after })
    // The same event again (at-least-once delivery) changes nothing.
    const version = (await storedState(env, project.id))?.version
    await handlePush(env, event, step as never)
    expect((await storedState(env, project.id))?.version).toBe(version)

    const board = await json<BoardView>(await api.get(`/api/projects/${project.id}`))
    const task = allTasks(board).find((t) => t.current.id === out.attemptId)
    expect(task?.current.status).toBe("ready")
    expect(task?.current.headSha).toBe(after)
    expect(task?.current.digest?.satisfies).toBe("yes")
    expect(task?.current.review).toMatchObject({ verdict: "satisfies", model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast", headSha: after })
    expect(task?.lane).toBe("ship")
    expect(replies).toHaveLength(1)
  })

  it("serves the runner protocol and keeps the alarm on while a job runs", async () => {
    const env = makeEnv(fake)
    const api = client(env)
    const { project } = await json<{ project: { id: string } }>(await api.post("/api/projects", { name: "Keel notes" }))
    const dispatched = await api.post(`/api/projects/${project.id}/tasks`, { task: "Set the lede", paths: "site/index.html", agent: "claude" })
    expect(dispatched.status).toBe(201)
    const { attemptId } = await json<{ attemptId: string }>(dispatched)

    // The runner token cannot press board buttons.
    expect((await api.post(`/api/attempts/${attemptId}/park`, {}, RUNNER)).status).toBe(401)

    const claim = await api.post("/api/runner/claim", { runnerId: "vps-1", agents: ["claude"] }, RUNNER)
    expect(claim.status).toBe(200)
    const job = await json<ClaimedJob>(claim)
    expect(job.attemptId).toBe(attemptId)
    expect(job.remote).toBe(fake.local.remote(attemptId))
    expect(job.briefPath).toBe(`.shipboard/briefs/${job.brief.id}.json`)
    expect((await api.post("/api/runner/claim", { runnerId: "vps-1", agents: ["claude"] }, RUNNER)).status).toBe(204)

    const read = await json<GitCredentials>(await api.post(`/api/runner/jobs/${attemptId}/credentials`, { runnerId: "vps-1", scope: "read" }, RUNNER))
    expect(read.scope).toBe("read")
    expect(fake.local.tokens.check(read.token, attemptId, "write")).toBe("forbidden")
    const other = await api.post(`/api/runner/jobs/${attemptId}/credentials`, { runnerId: "vps-2", scope: "write" }, RUNNER)
    expect(other.status).toBe(409)
    expect((await api.post(`/api/runner/jobs/${attemptId}/heartbeat`, { runnerId: "vps-1" }, RUNNER)).status).toBe(200)

    const state = env.PROJECT.entry(project.id).state
    expect(state.storage.alarm).not.toBeNull()
    const object = env.PROJECT.entry(project.id).object
    state.storage.alarm = null
    await object.alarm()
    expect(state.storage.alarm).not.toBeNull()

    const agents = await json<{ agents: Array<{ id: string; lastSeenAt?: string }> }>(await api.get("/api/config", ""))
    expect(agents.agents.find((a) => a.id === "claude")?.lastSeenAt).toBeDefined()

    const finish = await api.post(
      `/api/runner/jobs/${attemptId}/finish`,
      { runnerId: "vps-1", outcome: { reason: "agent_error", summary: "The agent crashed." } },
      RUNNER,
    )
    expect(finish.status).toBe(200)
    const board = await json<BoardView>(await api.get(`/api/projects/${project.id}`))
    expect(laneOf(board, attemptId)).toBe("rerun")
    // Nothing left to watch: the alarm lapses after its next run.
    state.storage.alarm = null
    await object.alarm()
    expect(state.storage.alarm).toBeNull()
  })

  it("applies the Cloudflare auth rules and leaves other paths to static assets", async () => {
    let api = client(makeEnv(fake, { BOARD_TOKEN: undefined, RUNNER_TOKEN: undefined }))
    const unset = await api.post("/api/projects", { name: "Keel" }, "")
    expect(unset.status).toBe(503)
    expect((await json<{ error: string }>(unset)).error).toContain("BOARD_TOKEN")
    const runner = await api.post("/api/runner/claim", { runnerId: "r", agents: ["claude"] }, "")
    expect(runner.status).toBe(503)
    expect((await json<{ error: string }>(runner)).error).toContain("RUNNER_TOKEN")
    expect((await api.get("/api/projects", "")).status).toBe(200)

    api = client(makeEnv(fake, { PUBLIC_READ: "false" }))
    expect((await api.get("/api/projects", "")).status).toBe(401)
    expect((await api.get("/api/projects", "wrong")).status).toBe(401)
    expect((await api.get("/api/projects", BOARD)).status).toBe(200)
    expect((await api.post("/api/projects", { name: "Keel" }, RUNNER)).status).toBe(401)

    // No Host/Origin pinning on Cloudflare: the token is the guard.
    api = client(makeEnv(fake))
    const foreign = await api.post("/api/projects", { name: "Keel" }, BOARD, { Origin: "https://elsewhere.example" })
    expect(foreign.status).toBe(201)

    const missing = await api.get("/api/projects/ghost-0000", "")
    expect(missing.status).toBe(404)
    expect(await json<{ error: string }>(missing)).toEqual({ error: "No project with that id." })
    expect((await api.post("/api/attempts/ghost-0000--lede-0001/ship", {})).status).toBe(404)

    const page = await api.get("/p/keel-0001", "")
    expect(await page.text()).toBe("asset /p/keel-0001")
    const apiMiss = await api.get("/api/nothing", "")
    expect(apiMiss.status).toBe(404)
    expect(apiMiss.headers.get("x-content-type-options")).toBe("nosniff")
  })
})

describe("alarm schedule", () => {
  const base = { schema: 1, version: 1, briefs: [], activity: [], reconciledAt: 0 } as unknown as ProjectState
  const now = Date.parse("2026-10-01T12:00:00.000Z")
  const attempt = (status: string, updatedAt: string) => ({ status, updatedAt }) as unknown as ProjectState["attempts"][number]
  const job = (state: string) => ({ state }) as unknown as ProjectState["jobs"][number]

  it("ticks fast while a job is live, slowly for a recent waiting attempt, and not at all otherwise", () => {
    expect(nextTickAt({ ...base, attempts: [], jobs: [job("running")] }, now)).toBe(now + BUSY_TICK_MS)
    expect(nextTickAt({ ...base, attempts: [], jobs: [job("queued")] }, now)).toBe(now + BUSY_TICK_MS)
    expect(nextTickAt({ ...base, attempts: [attempt("waiting", "2026-10-01T11:00:00.000Z")], jobs: [job("done")] }, now)).toBe(now + IDLE_TICK_MS)
    expect(nextTickAt({ ...base, attempts: [attempt("waiting", "2026-09-29T11:00:00.000Z")], jobs: [] }, now)).toBeNull()
    expect(nextTickAt({ ...base, attempts: [attempt("ready", "2026-10-01T11:00:00.000Z")], jobs: [job("failed")] }, now)).toBeNull()
  })
})
