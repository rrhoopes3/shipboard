import { afterEach, describe, expect, it } from "vitest"
import type { ClaimedJob } from "../../src/core/types.ts"
import { api, boot, cleanup } from "./helpers.ts"

afterEach(cleanup)

const BOARD = "board-secret"
const RUNNER = "runner-secret"

async function dispatch(board: ReturnType<typeof api>, projectId: string, task: string, agent: string): Promise<string> {
  const res = await board.post(`/api/projects/${projectId}/tasks`, { task, paths: ["notes.txt"], agent })
  expect(res.status).toBe(201)
  return (await board.json<{ attemptId: string }>(res)).attemptId
}

describe("targeted claim and cancellation", () => {
  it("claims one named job, and parking it cancels the runner's lease", async () => {
    const server = await boot({ boardToken: BOARD, runnerToken: RUNNER })
    const board = api(server.url, BOARD)
    const runner = api(server.url, RUNNER)
    const { project } = await board.json<{ project: { id: string } }>(await board.post("/api/projects", { name: "Claim yard" }))

    const first = await dispatch(board, project.id, "First note", "claude-code")
    const second = await dispatch(board, project.id, "Second note", "claude-code")

    // Without a target the oldest job comes first; with one, exactly that job.
    const targeted = await runner.post("/api/runner/claim", { runnerId: "mod-1", agents: ["claude-code"], attemptId: second })
    expect(targeted.status).toBe(200)
    expect((await runner.json<ClaimedJob>(targeted)).attemptId).toBe(second)

    // A target the runner's agents cannot take is a 204, not someone else's job.
    const wrongAgent = await runner.post("/api/runner/claim", { runnerId: "box-1", agents: ["grok"], attemptId: first })
    expect(wrongAgent.status).toBe(204)

    expect((await runner.post(`/api/runner/jobs/${second}/heartbeat`, { runnerId: "mod-1" })).status).toBe(200)
    expect((await board.post(`/api/attempts/${second}/park`, {})).status).toBe(200)

    // The lease is gone: heartbeat and credentials refuse, finish stays idempotent.
    expect((await runner.post(`/api/runner/jobs/${second}/heartbeat`, { runnerId: "mod-1" })).status).toBe(409)
    expect((await runner.post(`/api/runner/jobs/${second}/credentials`, { runnerId: "mod-1", scope: "write" })).status).toBe(409)
    const finish = await runner.post(`/api/runner/jobs/${second}/finish`, {
      runnerId: "mod-1",
      outcome: { reason: "no_changes", summary: "Stopped." },
    })
    expect(finish.status).toBe(200)

    const config = await board.json<{ agents: Array<{ id: string; label: string }> }>(await board.get("/api/config"))
    expect(config.agents.find((agent) => agent.id === "claude-code")?.label).toBe("Claude Code (interactive)")
  })
})
