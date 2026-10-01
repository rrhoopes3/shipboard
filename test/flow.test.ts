import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { BoardError } from "../worker/src/errors.ts"
import { BoardService } from "../worker/src/service.ts"

const dirs: string[] = []

async function openService(): Promise<BoardService> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "shipboard-"))
  dirs.push(dir)
  return BoardService.open(dir)
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

describe("board flow", () => {
  it("dispatches, pushes, and ships a clean fork", async () => {
    const service = await openService()
    const project = await service.createProject({ name: "Keel notes", description: "A quiet page." })
    let board = await service.createFork(project.id, {
      task: "Set the lede",
      paths: ["site/index.html"],
      acceptance: 'contains site/index.html "ready for sea"',
      agent: "cursor",
    })
    const fork = board.forks.find((item) => item.action === "wait")
    expect(fork).toBeTruthy()
    if (!fork) return

    await expect(
      service.pushFiles(fork.id, { files: [{ path: "../secret.txt", content: "nope" }] }),
    ).rejects.toThrow(/relative path/)

    const page = `<!DOCTYPE html><html><body><p id="lede">ready for sea</p></body></html>\n`
    board = await service.pushFiles(fork.id, {
      files: [{ path: "site/index.html", content: page }],
    })
    const pushed = board.forks.find((item) => item.id === fork.id)
    expect(pushed?.action).toBe("ship")
    expect(pushed?.digest.satisfies).toBe("yes")
    expect(pushed?.merge.state).toBe("clean")

    board = await service.ship(fork.id)
    expect(board.forks.find((item) => item.id === fork.id)?.action).toBe("shipped")
    const preview = await service.readPreview(project.id, "main", "site/index.html")
    expect(preview.body.toString("utf8")).toContain("ready for sea")
    expect(preview.type).toContain("text/html")
  })

  it("ships two clean forks, then re-runs the one that conflicts", async () => {
    const service = await openService()
    const board = await service.runPierDemo()
    const open = board.forks.filter((fork) => fork.status === "open")
    expect(open).toHaveLength(3)
    expect(open.every((fork) => fork.merge.state === "clean")).toBe(true)

    const footer = open.find((fork) => fork.task.includes("footer"))
    const rename = open.find((fork) => fork.task.includes("Rename"))
    const tint = open.find((fork) => fork.task.includes("Tint"))
    expect(footer && rename && tint).toBeTruthy()
    if (!footer || !rename || !tint) return

    await service.ship(footer.id)
    await service.ship(rename.id)
    const after = await service.getBoard(board.project.id)
    const tintAfter = after.forks.find((fork) => fork.id === tint.id)
    expect(tintAfter?.action).toBe("rerun")
    expect(tintAfter?.merge.paths).toEqual(["site/index.html"])

    await expect(service.ship(tint.id)).rejects.toThrow(BoardError)

    const rerun = await service.rerun(tint.id)
    expect(rerun.notice).toMatch(/agent pushed/i)
    const fresh = rerun.board.forks.find((fork) => fork.parentForkId === tint.id)
    expect(fresh?.action).toBe("ship")
    expect(fresh?.merge.state).toBe("clean")
    const preview = fresh ? await service.readPreview(board.project.id, fresh.id, "site/index.html") : null
    expect(preview?.body.toString("utf8")).toContain("Northline night board")
    expect(preview?.body.toString("utf8")).toContain("color:#1F6F78")

    if (!fresh) return
    const shipped = await service.ship(fresh.id)
    const main = await service.readPreview(board.project.id, "main", "site/index.html")
    const html = main.body.toString("utf8")
    expect(html).toContain("Northline night board")
    expect(html).toContain("color:#1F6F78")
    expect(html).toContain("Posted by the night clerk.")
    expect(shipped.forks.find((fork) => fork.id === tint.id)?.action).toBe("superseded")
  })

  it("parks a fork and will not ship a brief that has not been pushed", async () => {
    const service = await openService()
    const project = await service.createProject({ name: "Hold" })
    const board = await service.createFork(project.id, {
      task: "Wait here",
      paths: ["site/index.html"],
      acceptance: "Look at it.",
    })
    const fork = board.forks[0]
    expect(fork?.action).toBe("wait")
    if (!fork) return
    await expect(service.ship(fork.id)).rejects.toThrow(/Nothing has been pushed/)
    const parked = await service.park(fork.id)
    expect(parked.forks[0]?.action).toBe("parked")
    const returned = await service.returnToBoard(fork.id)
    expect(returned.forks[0]?.action).toBe("wait")
  })
})
