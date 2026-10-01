import fs from "node:fs/promises"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { canonicalBrief } from "../../src/core/brief.ts"
import type { ProjectService } from "../../src/core/service.ts"
import type { BoardView, ClaimedJob, GitCredentials } from "../../src/core/types.ts"
import { TestClock, allTasks, api, bearer, boot, cleanup, git, tempDir } from "./helpers.ts"

afterEach(cleanup)

const BOARD = "board-secret"
const RUNNER = "runner-secret"

describe("runner protocol", () => {
  it("claims, clones with a read token, pushes with a write token, reports and finishes", async () => {
    const server = await boot({ boardToken: BOARD, runnerToken: RUNNER })
    const board = api(server.url, BOARD)
    const runner = api(server.url, RUNNER)
    const { project } = await board.json<{ project: { id: string } }>(await board.post("/api/projects", { name: "Runner yard" }))
    const dispatched = await board.json<{ attemptId: string; credentials?: GitCredentials }>(
      await board.post(`/api/projects/${project.id}/tasks`, {
        task: "Write the hello file",
        paths: ["hello.txt"],
        acceptance: 'contains hello.txt "hello"',
        constraints: ["Keep it short"],
        agent: "claude",
        credentials: true,
      }),
    )
    expect(dispatched.credentials).toBeUndefined()

    const nothing = await runner.post("/api/runner/claim", { runnerId: "box-1", agents: ["grok"] })
    expect(nothing.status).toBe(204)

    const claimRes = await runner.post("/api/runner/claim", { runnerId: "box-1", agents: ["claude", "codex"] })
    expect(claimRes.status).toBe(200)
    const job = await runner.json<ClaimedJob>(claimRes)
    expect(job.attemptId).toBe(dispatched.attemptId)
    expect(job.projectId).toBe(project.id)
    expect(job.agent).toBe("claude")
    expect(job.attemptNumber).toBe(1)
    expect(job.previous).toBeUndefined()
    expect(job.briefPath).toBe(`.shipboard/briefs/${job.brief.id}.json`)
    expect(job.remote).toBe(`${server.url}/git/local/${job.attemptId}.git`)
    expect(JSON.stringify(job)).not.toMatch(/art_v1_/)
    expect((await runner.post("/api/runner/claim", { runnerId: "box-2", agents: ["claude"] })).status).toBe(204)

    const config = await board.json<{ agents: Array<{ id: string; lastSeenAt?: string }> }>(await board.get("/api/config"))
    expect(config.agents.find((agent) => agent.id === "claude")?.lastSeenAt).toBeTruthy()
    expect(config.agents.find((agent) => agent.id === "grok")?.lastSeenAt).toBeTruthy()
    expect(config.agents.find((agent) => agent.id === "cursor")?.lastSeenAt).toBeUndefined()

    const other = await runner.post(`/api/runner/jobs/${job.attemptId}/credentials`, { runnerId: "box-2", scope: "read" })
    expect(other.status).toBe(409)

    const read = await runner.json<GitCredentials>(
      await runner.post(`/api/runner/jobs/${job.attemptId}/credentials`, { runnerId: "box-1", scope: "read" }),
    )
    expect(read.scope).toBe("read")
    const work = await tempDir()
    expect((await git([...bearer(read.token), "clone", read.remote, work])).code).toBe(0)
    const briefText = await fs.readFile(path.join(work, job.briefPath), "utf8")
    expect(briefText).toBe(canonicalBrief(job.brief))
    const log = await git(["log", "--format=%H %s", `${job.baseSha}..HEAD`], { cwd: work })
    expect(log.stdout.trim()).toBe(`${job.briefSha} brief: Write the hello file`)

    await fs.writeFile(path.join(work, "hello.txt"), "hello\n")
    await git(["add", "hello.txt"], { cwd: work })
    await git(["commit", "-m", "Write the hello file", "-m", `Shipboard-Attempt: ${job.attemptId}\nShipboard-Agent: claude`], { cwd: work })
    expect((await git([...bearer(read.token), "push", read.remote, "HEAD:main"], { cwd: work })).code).not.toBe(0)

    const write = await runner.json<GitCredentials>(
      await runner.post(`/api/runner/jobs/${job.attemptId}/credentials`, { runnerId: "box-1", scope: "write" }),
    )
    const push = await git([...bearer(write.token), "push", write.remote, "HEAD:main"], { cwd: work })
    expect(push.code, push.stderr).toBe(0)
    const head = (await git(["rev-parse", "HEAD"], { cwd: work })).stdout.trim()

    const beat = await runner.json<{ leaseExpiresAt: string }>(
      await runner.post(`/api/runner/jobs/${job.attemptId}/heartbeat`, { runnerId: "box-1" }),
    )
    expect(Date.parse(beat.leaseExpiresAt)).toBeGreaterThanOrEqual(Date.parse(job.leaseExpiresAt))

    const pushed = await runner.post(`/api/attempts/${job.attemptId}/pushed`, { sha: head })
    expect(pushed.status).toBe(200)
    let view = (await runner.json<{ board: BoardView }>(pushed)).board
    let task = allTasks(view).find((t) => t.current.id === job.attemptId)
    expect(task?.current.status).toBe("ready")
    expect(task?.current.headSha).toBe(head)
    expect(task?.current.digest?.satisfies).toBe("yes")
    expect(task?.lane).toBe("ship")
    // Idempotent: the same head again changes nothing.
    const again = await runner.json<{ board: BoardView }>(await runner.post(`/api/attempts/${job.attemptId}/pushed`, { sha: head }))
    expect(again.board.version).toBe(view.version)

    const finish = await runner.post(`/api/runner/jobs/${job.attemptId}/finish`, {
      runnerId: "box-1",
      outcome: { reason: "pushed", summary: "Wrote hello.txt.", commitSha: head, changedPaths: ["hello.txt"], turns: 3 },
    })
    expect(finish.status).toBe(200)
    expect(await finish.json()).toEqual({ ok: true })
    expect((await runner.post(`/api/runner/jobs/${job.attemptId}/finish`, { runnerId: "box-1", outcome: { reason: "pushed", summary: "" } })).status).toBe(200)
    await server.host.idle()

    view = await board.json<BoardView>(await board.get(`/api/projects/${project.id}`))
    task = allTasks(view).find((t) => t.current.id === job.attemptId)
    expect(task?.current.job?.state).toBe("done")
    expect(task?.current.job?.outcome?.summary).toBe("Wrote hello.txt.")
    expect(view.activity.map((entry) => entry.kind)).toEqual(expect.arrayContaining(["dispatched", "claimed", "pushed", "assessed"]))

    // The runner token cannot ship; the board token can.
    expect((await runner.post(`/api/attempts/${job.attemptId}/ship`, {})).status).toBe(401)
    expect((await board.post(`/api/attempts/${job.attemptId}/ship`, { expectedHead: head })).status).toBe(200)
    expect((await runner.post(`/api/runner/jobs/${job.attemptId}/heartbeat`, { runnerId: "box-1" })).status).toBe(409)
  })

  it("re-queues an expired lease three times, then fails the attempt", async () => {
    const clock = new TestClock()
    const server = await boot({ clock })
    const created = await server.host.createProject({ name: "Lease" })
    const handle = (await server.host.project(created.id)) as ProjectService
    const { attemptId } = await handle.dispatch({ task: "Slow work", paths: ["a.txt"], agent: "codex" })

    for (let round = 1; round <= 3; round++) {
      const job = await handle.claim(`box-${round}`, ["codex"])
      expect(job?.attemptId).toBe(attemptId)
      expect(await handle.nextJobAt(["codex"])).toBeNull()
      clock.advance(4 * 60_000)
      await handle.tick()
      const view = await handle.board({ reconcile: false })
      const task = allTasks(view).find((t) => t.current.id === attemptId)
      expect(task?.current.job?.state).toBe("queued")
      expect(task?.current.job?.requeues).toBe(round)
      expect(task?.current.status).toBe("waiting")
      expect(view.activity.at(-1)?.text).toMatch(/lease_expired/)
      // The old lease holder is cut off.
      await expect(handle.jobCredentials(attemptId, `box-${round}`, "read")).rejects.toThrow(/does not hold the lease/)
    }

    expect(await handle.claim("box-4", ["codex"])).not.toBeNull()
    await expect(handle.heartbeat(attemptId, "box-4")).resolves.toHaveProperty("leaseExpiresAt")
    clock.advance(4 * 60_000)
    await handle.tick()
    const view = await handle.board({ reconcile: false })
    const task = allTasks(view).find((t) => t.current.id === attemptId)
    expect(task?.current.job?.state).toBe("failed")
    expect(task?.current.job?.outcome?.reason).toBe("lease_expired")
    expect(task?.current.status).toBe("failed")
    expect(task?.lane).toBe("rerun")
    expect(await handle.claim("box-5", ["codex"])).toBeNull()

    // A failed attempt re-runs with the job outcome as the reason, and the runner sees why.
    const rerun = await handle.rerun(attemptId)
    const job = await handle.claim("box-6", ["codex"])
    expect(job?.attemptId).toBe(rerun.attemptId)
    expect(job?.attemptNumber).toBe(2)
    expect(job?.previous).toEqual({ attemptId, reason: "The agent run failed: The runner lease expired 4 times." })
  })

  it("marks an attempt failed when the agent gives up without pushing", async () => {
    const server = await boot()
    const created = await server.host.createProject({ name: "Giving up" })
    const handle = await server.host.project(created.id)
    const { attemptId } = await handle.dispatch({ task: "Impossible", paths: ["a.txt"], agent: "grok" })
    await handle.claim("box", ["grok"])
    await expect(handle.finish(attemptId, "other", { reason: "agent_error", summary: "x" })).rejects.toThrow(/lease/)
    await expect(handle.finish(attemptId, "box", { reason: "nope", summary: "x" } as never)).rejects.toThrow(/reason/)
    const view = await handle.finish(attemptId, "box", { reason: "timeout", summary: "Ran out of time." })
    const task = allTasks(view).find((t) => t.current.id === attemptId)
    expect(task?.current.status).toBe("failed")
    expect(task?.current.job?.state).toBe("failed")
    expect(task?.current.primary).toBe("rerun")
    expect(view.activity.at(-1)?.text).toContain("Ran out of time.")
  })
})
