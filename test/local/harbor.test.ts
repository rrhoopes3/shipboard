import { afterEach, describe, expect, it } from "vitest"
import type { BoardView } from "../../src/core/types.ts"
import { allTasks, api, boot, cleanup, taskByTitle } from "./helpers.ts"

afterEach(cleanup)

const decode = (bytes: Uint8Array | null) => (bytes ? new TextDecoder().decode(bytes) : "")

describe("harbor demo", () => {
  it("ships two, re-runs the conflict on the new main with the same brief bytes, then ships it", async () => {
    const server = await boot()
    const a = api(server.url)
    const artifacts = server.host.artifacts

    const created = await a.post("/api/demo")
    expect(created.status).toBe(201)
    const { projectId } = await a.json<{ projectId: string }>(created)
    await server.host.idle()

    let board = await a.json<BoardView>(await a.get(`/api/projects/${projectId}`))
    expect(allTasks(board)).toHaveLength(3)
    for (const task of allTasks(board)) {
      expect(task.current.status).toBe("ready")
      expect(task.current.agent).toBe("demo")
      expect(task.current.agentLabel).toBe("Demo (scripted)")
      expect(task.current.merge?.state).toBe("clean")
      expect(task.current.digest?.satisfies).toBe("yes")
      expect(task.lane).toBe("ship")
      expect(task.current.primary).toBe("ship")
      expect(task.current.previewUrl).toBe(`/preview/${projectId}/${task.current.id}/`)
    }
    const footer = taskByTitle(board, "footer").current
    const rename = taskByTitle(board, "Rename").current
    const tint = taskByTitle(board, "Tint").current

    let res = await a.post(`/api/attempts/${footer.id}/ship`, { expectedHead: footer.headSha })
    expect(res.status).toBe(200)
    res = await a.post(`/api/attempts/${rename.id}/ship`, { expectedHead: rename.headSha })
    expect(res.status).toBe(200)
    board = (await a.json<{ board: BoardView }>(res)).board

    const conflicted = taskByTitle(board, "Tint")
    expect(conflicted.lane).toBe("rerun")
    expect(conflicted.current.primary).toBe("rerun")
    expect(conflicted.current.merge?.state).toBe("conflict")
    expect(conflicted.current.merge?.paths).toEqual(["site/index.html"])
    expect(taskByTitle(board, "footer").lane).toBe("shipped")
    expect(taskByTitle(board, "Rename").lane).toBe("shipped")
    expect(board.lanes.find((lane) => lane.lane === "rerun")?.tasks).toHaveLength(1)

    res = await a.post(`/api/attempts/${tint.id}/ship`, {})
    expect(res.status).toBe(409)

    res = await a.post(`/api/attempts/${tint.id}/rerun`, {})
    expect(res.status).toBe(200)
    const { attemptId } = await a.json<{ attemptId: string }>(res)
    expect(attemptId).not.toBe(tint.id)
    await server.host.idle()

    board = await a.json<BoardView>(await a.get(`/api/projects/${projectId}`))
    const rerun = taskByTitle(board, "Tint")
    expect(rerun.current.id).toBe(attemptId)
    expect(rerun.current.number).toBe(2)
    expect(rerun.current.replaces).toBe(tint.id)
    expect(rerun.current.status).toBe("ready")
    expect(rerun.current.merge?.state).toBe("clean")
    expect(rerun.current.baseSha).toBe(board.project.mainSha)
    expect(rerun.lane).toBe("ship")
    const old = rerun.history[0]
    expect(old?.id).toBe(tint.id)
    expect(old?.status).toBe("discarded")
    expect(old?.replacedBy).toBe(attemptId)
    expect(old?.discardReason).toBe('Conflicted with main in site/index.html after "Rename the pier mark to the night board" shipped.')

    const briefFile = `.shipboard/briefs/${rerun.brief.id}.json`
    const oldBytes = await artifacts.readFile(tint.repo, tint.briefSha, briefFile)
    const newBytes = await artifacts.readFile(rerun.current.repo, rerun.current.briefSha, briefFile)
    expect(oldBytes).not.toBeNull()
    expect(Buffer.from(newBytes ?? []).equals(Buffer.from(oldBytes ?? []))).toBe(true)

    res = await a.post(`/api/attempts/${attemptId}/ship`, { expectedHead: rerun.current.headSha })
    expect(res.status).toBe(200)
    board = (await a.json<{ board: BoardView }>(res)).board
    expect(board.project.counts.shipped).toBe(3)
    expect(board.project.counts.rerun).toBe(0)

    const html = decode(await artifacts.readFile(projectId, "main", "site/index.html"))
    expect(html).toContain("Northline night board")
    expect(html).toContain("color:#1F6F78")
    expect(html).toContain("Posted by the night clerk.")
    for (const task of allTasks(board)) {
      expect(await artifacts.readFile(projectId, "main", `.shipboard/briefs/${task.brief.id}.json`)).not.toBeNull()
    }

    const diff = await a.json<{ diff: string; truncated: boolean; base: string; head: string }>(
      await a.get(`/api/attempts/${footer.id}/diff`),
    )
    expect(diff.diff).toContain("+<footer>Posted by the night clerk.</footer>")
    expect(diff.diff).not.toContain(".shipboard/briefs")
    expect(diff.truncated).toBe(false)
    expect(diff.head).toBe(footer.headSha)

    const preview = await a.get(`/preview/${projectId}/main/site/index.html`)
    expect(preview.status).toBe(200)
    expect(preview.headers.get("content-type")).toContain("text/html")
    expect(preview.headers.get("content-security-policy")).toContain("default-src 'none'")
    expect(preview.headers.get("content-security-policy")).toContain("sandbox")
    expect(await preview.text()).toContain("Northline night board")

    const bare = await fetch(`${server.url}/preview/${projectId}/main/`, { redirect: "manual" })
    expect(bare.status).toBe(302)
    expect(bare.headers.get("location")).toBe(`/preview/${projectId}/main/site/`)
    const dir = await a.get(`/preview/${projectId}/${footer.id}/site/`)
    expect(dir.status).toBe(200)
    expect(await dir.text()).toContain("night clerk")
  })
})
