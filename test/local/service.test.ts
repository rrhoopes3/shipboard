import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { defaultAgents } from "../../src/core/agents.ts"
import { GitWorkspace } from "../../src/core/git.ts"
import type { ReviewerPort } from "../../src/core/ports.ts"
import { ProjectService } from "../../src/core/service.ts"
import type { Review } from "../../src/core/types.ts"
import { JsonStateStore } from "../../src/local/state.ts"
import { allTasks, boot, cleanup, quiet, tempDir } from "./helpers.ts"

afterEach(cleanup)

describe("ProjectService on its own ports", () => {
  it("asks the reviewer about each new head and routes off-brief work to review", async () => {
    const server = await boot()
    const dir = await tempDir()
    const seen: string[] = []
    const reviewer: ReviewerPort = {
      review: async ({ brief, files, diff, headSha }): Promise<Review> => {
        seen.push(headSha)
        expect(brief.task).toBe("Reviewed work")
        expect(files.map((f) => f.path)).toEqual(["a.txt"])
        expect(diff).toContain("+reviewed")
        expect(diff).not.toContain(".shipboard")
        return { verdict: "off-brief", note: "Not what was asked.", model: "fake", headSha, at: new Date().toISOString() }
      },
    }
    const id = "reviewed-0001"
    const service = new ProjectService(
      id,
      { artifacts: server.host.artifacts, state: new JsonStateStore(path.join(dir, `${id}.json`)), reviewer, log: quiet },
      { agents: defaultAgents() },
    )
    await service.init({ id, name: "Reviewed" })
    await expect(service.init({ id, name: "Again" })).rejects.toThrow(/already exists/)
    const { attemptId } = await service.dispatch({ task: "Reviewed work", paths: ["a.txt"], agent: "manual" })
    const helper = new GitWorkspace(server.host.artifacts)
    const pushed = await helper.commit(attemptId, { "a.txt": "reviewed\n" }, "work")
    const board = await service.pushed(attemptId, pushed.sha)
    const task = allTasks(board).find((t) => t.current.id === attemptId)
    expect(seen).toEqual([pushed.sha])
    expect(task?.current.review?.verdict).toBe("off-brief")
    expect(task?.current.digest?.satisfies).toBe("unchecked")
    expect(task?.lane).toBe("review")
    expect(task?.current.primary).toBe("ship-anyway")
    // Same head again: no second review.
    await service.pushed(attemptId)
    expect(seen).toHaveLength(1)
    // Ship anyway is allowed.
    const shipped = await service.ship(attemptId)
    expect(allTasks(shipped).find((t) => t.current.id === attemptId)?.lane).toBe("shipped")
  })

  it("notices a direct push to main and re-checks every ready attempt", async () => {
    const server = await boot()
    const created = await server.host.createProject({ name: "Direct main" })
    const handle = await server.host.project(created.id)
    const { attemptId } = await handle.dispatch({ task: "Edit the page", paths: ["site/index.html"], agent: "manual" })
    const helper = new GitWorkspace(server.host.artifacts)
    await helper.commit(attemptId, { "site/index.html": "<p>fork</p>\n" }, "fork edit")
    await server.host.idle()
    let board = await handle.board({ reconcile: false })
    expect(allTasks(board)[0]?.lane).toBe("ship")

    const moved = await helper.commit(created.id, { "site/index.html": "<p>main</p>\n" }, "someone edited main")
    await server.host.idle()
    board = await handle.board({ reconcile: false })
    expect(board.project.mainSha).toBe(moved.sha)
    const task = allTasks(board)[0]
    expect(task?.lane).toBe("rerun")
    expect(task?.current.merge?.paths).toEqual(["site/index.html"])
    expect(task?.current.merge?.mainSha).toBe(moved.sha)
    expect(board.activity.some((entry) => entry.kind === "project" && entry.text.includes("outside shipboard"))).toBe(true)
    expect(board.activity.at(-1)?.kind).toBe("conflict")

    const rerun = await handle.rerun(attemptId)
    const fresh = allTasks(rerun.board)[0]
    expect(fresh?.current.baseSha).toBe(moved.sha)
    expect(fresh?.history[0]?.discardReason).toBe("Conflicted with main in site/index.html.")
  })

  it("reconciles a push that no event reported", async () => {
    const server = await boot()
    const dir = await tempDir()
    const id = "quiet-0001"
    const service = new ProjectService(
      id,
      { artifacts: server.host.artifacts, state: new JsonStateStore(path.join(dir, `${id}.json`)), log: quiet },
      { agents: defaultAgents() },
    )
    await service.init({ id, name: "Quiet" })
    const { attemptId } = await service.dispatch({ task: "Silent push", paths: ["a.txt"], agent: "manual" })
    // This service is not registered with the host, so the git route's push event never reaches it.
    await new GitWorkspace(server.host.artifacts).commit(attemptId, { "a.txt": "x\n" }, "silent")
    expect(allTasks(await service.board({ reconcile: false }))[0]?.current.status).toBe("waiting")
    const state = await new JsonStateStore(path.join(dir, `${id}.json`)).load()
    expect(state?.reconciledAt).toBeGreaterThan(0)
    // board() reconciles at most every 10 s; a service whose last reconcile is long past does it now.
    const fresh = new ProjectService(
      id,
      {
        artifacts: server.host.artifacts,
        state: {
          load: async () => (state ? { ...state, reconciledAt: 0 } : null),
          save: async () => {},
        },
        log: quiet,
      },
      { agents: defaultAgents() },
    )
    const board = await fresh.board()
    expect(allTasks(board)[0]?.current.status).toBe("ready")
  })
})
