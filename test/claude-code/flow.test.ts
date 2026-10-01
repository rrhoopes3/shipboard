import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { authHeader, base64, secretOf } from "../../integrations/claude-code/hooks/git.ts"
import { HEARTBEAT_MS, POLL_MS } from "../../integrations/claude-code/hooks/session.ts"
import { harness, textOf, type Harness } from "./harness.ts"
import { git, MockBoard } from "./mock-board.ts"

let root: string
let board: MockBoard

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "shipboard-mod-")))
  await fs.mkdir(path.join(root, "board"))
  board = await new MockBoard(path.join(root, "board")).start()
})

afterEach(async () => {
  await board.close()
  await fs.rm(root, { recursive: true, force: true })
})

async function session(opts: { cwd?: string; emptyCwd?: boolean; withBoardToken?: boolean; options?: Record<string, string | boolean>; store?: Map<string, unknown> } = {}): Promise<Harness> {
  const cwd = opts.cwd ?? path.join(root, "session")
  await fs.mkdir(cwd, { recursive: true })
  if (!opts.emptyCwd) await fs.writeFile(path.join(cwd, "NOTES.md"), "the user's own project\n")
  const h = await harness({
    cwd,
    store: opts.store,
    options: opts.options,
    env: {
      SHIPBOARD_URL: board.url,
      SHIPBOARD_RUNNER_TOKEN: board.runnerToken,
      ...(opts.withBoardToken ? { SHIPBOARD_TOKEN: board.boardToken } : {}),
      SHIPBOARD_PROJECT: board.projectId,
      HOME: "/Users/someone",
    },
    // Keep the developer's own git config out of the test; the mod's commit falls back to its own identity.
    childEnv: { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
  })
  await h.start()
  return h
}

/** Every spelling of every token the board minted or the session was given. */
function secrets(): string[] {
  const minted = board.minted.flatMap((c) => [c.token, secretOf(c.token), base64(`x:${secretOf(c.token)}`), authHeader(c.token)])
  return [...minted, board.runnerToken, board.boardToken]
}

function expectNoSecrets(h: Harness, where: string[]): void {
  const runs = h.runs.map((r) => r.argv.join(" "))
  for (const secret of secrets()) {
    for (const text of [...h.said, ...runs, ...where]) expect(text).not.toContain(secret)
  }
}

describe("claim → work → push → done", () => {
  it("joins the board as claude-code, verifies the brief, guards git push, pushes through a scoped token, and finishes", async () => {
    board.queue({ task: "Headless only", agent: "claude" })
    const queued = board.queue({ task: "Set the lede" })
    const id = queued.job.attemptId
    const h = await session()

    // Registration and config
    expect(h.commands).toEqual([expect.objectContaining({ name: "shipboard" })])
    expect(h.tools).toEqual([expect.objectContaining({ name: "push" })])
    expect(h.env.has("SHIPBOARD_RUNNER_TOKEN")).toBe(false)

    // Claim: only claude-code jobs, with a runner id that names the session
    const claimed = await h.command("claim --no-start")
    expect(claimed).toContain(`Claimed ${id} (attempt 1)`)
    expect(claimed).toContain(`Brief verified at ${queued.job.briefSha.slice(0, 7)}`)
    const claim = board.requests.find((r) => r.path === "/api/runner/claim")
    expect(claim?.body).toEqual({ runnerId: expect.stringMatching(/^claude-code-mod\/[A-Za-z0-9.-]+\/session-1$/), agents: ["claude-code"] })
    expect(claim?.auth).toBe(`Bearer ${board.runnerToken}`)
    expect(board.find(id)?.state).toBe("running")
    expect(board.jobs[0]?.state).toBe("queued")
    expect(h.opened).toEqual([{ id: "shipboard", title: "Shipboard" }])

    // The session directory is not empty, so the fork lands in ./shipboard/<attemptId>
    const dir = path.join(root, "session", "shipboard", id)
    expect(await fs.readFile(path.join(dir, "site/index.html"), "utf8")).toContain("Harbor notes")
    const gitConfig = await fs.readFile(path.join(dir, ".git/config"), "utf8")
    expect(gitConfig).toContain(queued.job.remote)
    expect(gitConfig).not.toMatch(/extraheader|credential|art_v1_/i)

    // The clone authenticated with a read token, through env-scoped config only
    const cloneRun = h.runs.find((r) => r.argv[1] === "clone")
    expect(cloneRun?.argv).toEqual(["git", "clone", "--quiet", "--branch", "main", "--", queued.job.remote, dir])
    expect(cloneRun?.env).toMatchObject({ GIT_CONFIG_COUNT: "2", GIT_CONFIG_KEY_0: "http.extraHeader", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" })
    expect(cloneRun?.env?.GIT_CONFIG_VALUE_0).toBe(authHeader(board.minted[0]?.token ?? ""))
    expect(board.minted.map((c) => c.scope)).toEqual(["read"])

    // The brief rides along with the first prompt, a one-line reminder after that
    const [first] = await h.prompt("go")
    expect(first).toContain(`[shipboard] You are working shipboard job ${id}`)
    expect(first).toContain("Task: Set the lede")
    expect(first).toContain('contains site/index.html "ready for sea"')
    expect(first).toContain("- site/index.html")
    expect(first).toContain(`Working copy: ${dir}. Run commands there`)
    expect(first).toContain("mcp__shipboard__push")
    const [second] = await h.prompt("and?")
    expect(second).toMatch(new RegExp(`^\\[shipboard\\] Job ${id} is active`))

    // The tripwire
    const denied = await h.bash(`cd ${dir} && git push origin HEAD:main`)
    expect(denied).toContain("mcp__shipboard__push")
    expect(await h.bash("git -C shipboard/x remote set-url origin https://evil.example/x.git")).toContain("Do not change git remotes")
    expect(await h.bash(`cd ${dir} && git status && git add -A`)).toBeNull()
    expect(await h.bash("git reset --hard")).toContain("only allowed inside the job's working copy")
    h.state.cwd = dir
    expect(await h.bash("git reset --hard")).toBeNull()
    h.state.cwd = path.join(root, "session")
    expect(await h.edit(path.join(dir, ".git/config"))).toContain("inside a .git directory")
    expect(await h.edit(path.join(dir, "site/index.html"))).toBeNull()

    // Claude does the work, including a commit of its own that the push folds in
    await fs.writeFile(path.join(dir, "site/index.html"), "<!DOCTYPE html><p id=lede>Harbor notes: ready for sea</p>\n")
    git(dir, "commit", "--quiet", "-am", "wip")
    const pushed = await h.push("Set the lede to ready for sea")
    const head = board.head(id)
    expect(pushed).toContain(`Pushed ${head.slice(0, 7)} to ${id}: Set the lede to ready for sea (1 file: site/index.html).`)
    expect(pushed).toContain("Merge: clean against main")
    expect(pushed).toContain('pass: contains site/index.html "ready for sea"')
    expect(pushed).toContain(`Preview: ${board.url}/preview/${board.projectId}/${id}/`)
    expect(pushed).toContain("Board action: Ship.")
    expect(git(dir, "rev-parse", "HEAD")).toBe(head)
    expect(git(dir, "rev-parse", "HEAD^")).toBe(queued.job.briefSha)
    expect(board.log(id)).toBe(`Set the lede to ready for sea\n\nShipboard-Attempt: ${id}\nShipboard-Agent: claude-code`)
    expect(board.minted.map((c) => c.scope)).toEqual(["read", "write"])
    const pushRun = h.runs.find((r) => r.argv.includes("push"))
    expect(pushRun?.argv).toEqual(["git", "-C", dir, "push", "--quiet", "--no-verify", "--", queued.job.remote, "HEAD:refs/heads/main"])
    expect(pushRun?.env?.GIT_CONFIG_VALUE_0).toBe(authHeader(board.minted[1]?.token ?? ""))
    expect(board.requests.find((r) => r.path === `/api/attempts/${id}/pushed`)?.body).toEqual({ sha: head })

    // The pane shows the verdict; polling asks with ?since and takes a 304
    const pane = textOf(await h.render())
    expect(pane).toContain("✓ clean")
    expect(pane).toContain("▶ Ship")
    expect(pane).toContain(`${board.url}/preview/${board.projectId}/${id}/`)
    await h.tick(POLL_MS)
    expect(board.requests.at(-1)?.path).toBe(`/api/projects/${board.projectId}?since=${board.version}`)
    await h.tick(HEARTBEAT_MS)
    expect(board.requests.at(-1)?.path).toBe(`/api/runner/jobs/${id}/heartbeat`)

    // A second push with nothing new says so
    expect(await h.push("again")).toContain(`Nothing new to push since ${head.slice(0, 7)}`)

    // Done reports the push
    const done = await h.command("done")
    expect(done).toContain(`Finished ${id} as pushed.`)
    expect(board.finished).toEqual([
      {
        attemptId: id,
        runnerId: expect.stringContaining("claude-code-mod/"),
        outcome: expect.objectContaining({ reason: "pushed", commitSha: head, changedPaths: ["site/index.html"], sessionId: "session-1" }),
      },
    ])
    expect(h.liveTimers()).toHaveLength(0)
    expect(await h.bash("git push")).toBeNull()
    expect(textOf(await h.render())).toContain(`Finished ${id} as pushed.`)

    // Nothing Claude or the user saw, no argv, and no .git/config ever held a token
    expectNoSecrets(h, [await fs.readFile(path.join(dir, ".git/config"), "utf8")])
    expect(board.gitAuth.length).toBeGreaterThan(3)
    expect(board.gitAuth.every((a) => a.startsWith("Basic "))).toBe(true)
  })

  it("fails closed when the guard itself breaks during a job", async () => {
    board.queue({ task: "Set the lede" })
    const h = await session()
    await h.command("claim --no-start")
    h.$.session.cwd = async () => {
      throw new Error("boom")
    }
    expect(await h.bash("ls")).toContain("push guard failed")
  })

  it("clones into the session directory when it is empty", async () => {
    const queued = board.queue({ task: "Set the lede" })
    const cwd = path.join(root, "empty")
    const h = await session({ cwd, emptyCwd: true })
    const text = await h.command("claim --no-start")
    expect(text).toContain(`Working copy: ${cwd}.`)
    expect(git(cwd, "rev-parse", "HEAD")).toBe(queued.job.briefSha)
    const [context] = await h.prompt("go")
    expect(context).toContain(`Working copy: ${cwd} (the session directory).`)
  })

  it("starts Claude on the job unless told not to", async () => {
    const queued = board.queue({ task: "Set the lede" })
    const h = await session()
    await h.command("claim")
    expect(h.submitted).toHaveLength(1)
    expect(h.submitted[0]).toContain(`Start shipboard job ${queued.job.attemptId}`)
  })

  it("finishes as no_changes when nothing was pushed", async () => {
    const queued = board.queue({ task: "Set the lede" })
    const h = await session()
    await h.command("claim --no-start")
    const dir = path.join(root, "session", "shipboard", queued.job.attemptId)
    await fs.writeFile(path.join(dir, "site/index.html"), "<p>half done</p>\n")
    const done = await h.command("done")
    expect(done).toContain("as no_changes")
    expect(done).toContain("1 uncommitted change(s)")
    expect(board.finished[0]?.outcome.reason).toBe("no_changes")
    expect(board.head(queued.job.attemptId)).toBe(queued.job.briefSha)
  })

  it("refuses a fork whose brief commit differs from the claim, and finishes it as brief_mismatch", async () => {
    const queued = board.queue({ task: "Set the lede", tamper: true })
    const h = await session()
    const text = await h.command("claim --no-start")
    expect(text).toContain(`Did not start ${queued.job.attemptId}: brief file at the brief commit differs from the claimed brief`)
    expect(board.finished[0]?.outcome).toMatchObject({ reason: "brief_mismatch" })
    expect(await h.prompt("go")).toEqual([])
    expect(await h.bash("git push")).toBeNull()
    expect(h.liveTimers()).toHaveLength(0)
    expectNoSecrets(h, [])
  })

  it("says so when no claude-code job is queued", async () => {
    board.queue({ task: "For a headless runner", agent: "claude" })
    const h = await session()
    expect(await h.command("claim")).toContain("No queued claude-code jobs")
    expect(h.submitted).toEqual([])
  })

  it("dispatches a brief to claude-code with the board token, then claims it", async () => {
    const h = await session({ withBoardToken: true })
    const text = await h.command(`dispatch "Set the lede" --path site/index.html --acceptance 'contains site/index.html "ready for sea"' --constraint "Keep it static." --no-start`)
    const dispatch = board.requests.find((r) => r.path === `/api/projects/${board.projectId}/tasks`)
    expect(dispatch?.auth).toBe(`Bearer ${board.boardToken}`)
    expect(dispatch?.body).toEqual({
      task: "Set the lede",
      paths: ["site/index.html"],
      constraints: ["Keep it static."],
      acceptance: 'contains site/index.html "ready for sea"',
      agent: "claude-code",
    })
    const id = board.jobs[0]?.job.attemptId ?? ""
    expect(text).toContain(`Dispatched ${id} to claude-code.`)
    expect(text).toContain(`Claimed ${id}`)
    expect(board.requests.find((r) => r.path === "/api/runner/claim")?.body).toMatchObject({ attemptId: id })
    expectNoSecrets(h, [])
  })

  it("says which token to set when the board refuses a dispatch", async () => {
    const h = await session()
    const text = await h.command('dispatch "Set the lede" --path site/index.html')
    expect(text).toContain("Could not dispatch: The board answered 401")
    expect(text).toContain("Set the board_token option (or SHIPBOARD_TOKEN) to the board's BOARD_TOKEN.")
    expect(board.jobs).toHaveLength(0)
  })

  it("tells the user and Claude when the board turns against the push", async () => {
    const queued = board.queue({ task: "Set the lede" })
    const h = await session()
    await h.command("claim --no-start")
    await h.prompt("go")
    const dir = path.join(root, "session", "shipboard", queued.job.attemptId)
    await fs.writeFile(path.join(dir, "site/index.html"), "<p>ready for sea</p>\n")
    await h.push("Set the lede")
    const job = board.find(queued.job.attemptId)
    if (job) job.conflict = true
    board.version += 1
    await h.tick(POLL_MS)
    expect(h.said.some((s) => s.includes("now conflicts with main; the board offers a re-run"))).toBe(true)
    const [reminder] = await h.prompt("status?")
    expect(reminder).toContain("conflicts with main in site/index.html")
    expect(reminder).toContain("Next: Re-run")
    expect(textOf(await h.render())).toContain("↻ Re-run")
  })

  it("releases the job locally when the board no longer holds it for this session", async () => {
    const queued = board.queue({ task: "Set the lede" })
    const h = await session()
    await h.command("claim --no-start")
    const job = board.find(queued.job.attemptId)
    if (job) job.runnerId = "someone-else"
    expect(await h.command("done")).toContain(`Released ${queued.job.attemptId} here`)
    expect(board.jobs.filter((j) => j.state === "queued")).toHaveLength(0)
    expect(await h.command("claim --no-start")).toContain("No queued claude-code jobs")
  })

  it("refuses to push changes to control or agent config paths", async () => {
    const queued = board.queue({ task: "Set the lede" })
    const h = await session()
    await h.command("claim --no-start")
    const dir = path.join(root, "session", "shipboard", queued.job.attemptId)
    await fs.writeFile(path.join(dir, "site/index.html"), "<p>ready for sea</p>\n")
    await fs.mkdir(path.join(dir, ".claude"))
    await fs.writeFile(path.join(dir, ".claude/settings.json"), "{}\n")
    await fs.appendFile(path.join(dir, queued.job.briefPath), " ")
    const text = await h.push("Set the lede")
    expect(text).toContain("Not pushed: a shipboard job may not change")
    expect(text).toContain(".claude/settings.json")
    expect(text).toContain(queued.job.briefPath)
    expect(board.head(queued.job.attemptId)).toBe(queued.job.briefSha)
    expect(board.minted.map((c) => c.scope)).toEqual(["read"])
    expect(await fs.readFile(path.join(dir, "site/index.html"), "utf8")).toContain("ready for sea")
  })

  it("ends the job instead of pushing when the working copy's git config could redirect the token", async () => {
    const queued = board.queue({ task: "Set the lede" })
    const h = await session()
    await h.command("claim --no-start")
    const dir = path.join(root, "session", "shipboard", queued.job.attemptId)
    await fs.writeFile(path.join(dir, "site/index.html"), "<p>ready for sea</p>\n")
    git(dir, "config", "url.http://evil.example/.insteadOf", board.url)
    const text = await h.push("Set the lede")
    expect(text).toContain("url.http://evil.example/.insteadof")
    expect(text).toContain("unsafe_repo_config")
    expect(board.finished[0]?.outcome.reason).toBe("unsafe_repo_config")
    expect(board.minted.map((c) => c.scope)).toEqual(["read"])
    expect(board.head(queued.job.attemptId)).toBe(queued.job.briefSha)
  })

  it("pushes again after a fix, on top of the first push", async () => {
    const queued = board.queue({ task: "Set the lede" })
    const id = queued.job.attemptId
    const h = await session()
    await h.command("claim --no-start")
    const dir = path.join(root, "session", "shipboard", id)
    await fs.writeFile(path.join(dir, "site/index.html"), "<p>almost</p>\n")
    const first = await h.push("First try")
    expect(first).toContain("FAIL: contains site/index.html")
    expect(first).toContain("Board action: Ship anyway.")
    const firstHead = board.head(id)
    await fs.writeFile(path.join(dir, "site/index.html"), "<p>ready for sea</p>\n")
    const second = await h.push("Fix the lede")
    expect(second).toContain("pass: contains site/index.html")
    expect(git(dir, "rev-parse", "HEAD^")).toBe(firstHead)
    expectNoSecrets(h, [await fs.readFile(path.join(dir, ".git/config"), "utf8")])
  })

  it("picks the job back up after the mod reloads", async () => {
    const queued = board.queue({ task: "Set the lede" })
    const store = new Map<string, unknown>()
    const first = await session({ store })
    await first.command("claim --no-start")
    expect(store.get("job:session-1")).toMatchObject({ job: { attemptId: queued.job.attemptId } })
    expect(JSON.stringify([...store.values()])).not.toMatch(/art_v1_|runner-token|board-token/)

    const reloaded = await session({ store })
    expect(await reloaded.command("status")).toContain(`Job: ${queued.job.attemptId}`)
    expect(board.requests.at(-1)?.path).toMatch(/heartbeat|projects/)
    expect(await reloaded.bash("git push")).toContain("mcp__shipboard__push")
  })

  it("lets go of the job when the lease is lost", async () => {
    const queued = board.queue({ task: "Set the lede" })
    const h = await session()
    await h.command("claim --no-start")
    const job = board.find(queued.job.attemptId)
    if (job) job.runnerId = "someone-else"
    await h.tick(HEARTBEAT_MS)
    expect(h.said.some((s) => s.includes(`lost the lease on ${queued.job.attemptId}`))).toBe(true)
    expect(await h.bash("git push")).toBeNull()
    expect(h.liveTimers()).toHaveLength(0)
  })

  it("reports a pushed job when the session ends, and leaves an unpushed one to its lease", async () => {
    const queued = board.queue({ task: "Set the lede" })
    const h = await session()
    await h.command("claim --no-start")
    const dir = path.join(root, "session", "shipboard", queued.job.attemptId)
    await fs.writeFile(path.join(dir, "site/index.html"), "<p>ready for sea</p>\n")
    await h.push("Set the lede")
    await h.end("clear")
    expect(board.finished).toEqual([])
    expect((await h.prompt("still there?"))[0]).toContain("You are working shipboard job")
    await h.end("prompt_input_exit")
    expect(board.finished[0]?.outcome.reason).toBe("pushed")
  })
})
