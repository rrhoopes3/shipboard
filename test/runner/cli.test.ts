import { execFile } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { afterEach, describe, expect, it } from "vitest"
import type { AttemptView, BoardView, Lane, TaskView } from "../../src/core/types.ts"
import { runCli, shQuote } from "../../runner/cli.ts"
import { startGitServer } from "./helpers/gitServer.ts"
import { startMockBoard, type MockBoard } from "./helpers/mockBoard.ts"
import { headOf, makeFixture, sampleBrief } from "./helpers/repos.ts"

const execFileAsync = promisify(execFile)
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const P = "harbor-notes-3f2a"

function attempt(id: string, overrides: Partial<AttemptView> = {}): AttemptView {
  return {
    id,
    briefId: "tint-the-pier-name-9c01",
    number: 1,
    agent: "grok",
    agentLabel: "Grok",
    agentKind: "cli",
    status: "ready",
    repo: id,
    baseSha: "a".repeat(40),
    briefSha: "b".repeat(40),
    headSha: "c".repeat(40),
    createdAt: "2026-10-01T10:00:00.000Z",
    updatedAt: "2026-10-01T10:05:00.000Z",
    job: null,
    digest: null,
    merge: null,
    review: null,
    replacedBy: null,
    replaces: null,
    discardReason: null,
    shippedSha: null,
    previewUrl: `/preview/${P}/${id}/`,
    primary: "ship",
    secondary: ["park", "rerun"],
    ...overrides,
  }
}

function task(lane: Lane, current: AttemptView, history: AttemptView[] = [], taskText = "Tint the pier name"): TaskView {
  return { brief: sampleBrief({ task: taskText }), lane, current, history }
}

function boardView(): BoardView {
  const conflict = attempt(`${P}--tint-the-pier-n-0002`, {
    number: 2,
    replaces: `${P}--tint-the-pier-n-0001`,
    merge: { state: "conflict", paths: ["site/index.html"], mainSha: "d".repeat(40), headSha: "c".repeat(40), checkedAt: "2026-10-01T10:06:00.000Z" },
    primary: "rerun",
    secondary: ["park"],
  })
  const discarded = attempt(`${P}--tint-the-pier-n-0001`, {
    status: "discarded",
    replacedBy: conflict.id,
    discardReason: 'Conflicted with main in site/index.html after "Rename the pier mark" shipped.',
    primary: "none",
    secondary: [],
  })
  const ship = attempt(`${P}--set-the-lede-aaaa`, {
    agent: "claude",
    agentLabel: "Claude Code",
    digest: {
      summary: "Touched site/index.html. Acceptance check passed.",
      satisfies: "yes",
      reasons: [],
      files: [],
      checks: [],
      unexpectedPaths: [],
      missedPaths: [],
      controlPaths: [],
      headSha: "e".repeat(40),
      baseSha: "a".repeat(40),
    },
    merge: { state: "clean", paths: [], mainSha: "d".repeat(40), headSha: "e".repeat(40), checkedAt: "2026-10-01T10:06:00.000Z" },
  })
  const working = attempt(`${P}--add-a-tide-tab-bbbb`, {
    status: "waiting",
    agent: "codex",
    primary: "wait",
    secondary: ["park"],
    previewUrl: null,
    job: { attemptId: `${P}--add-a-tide-tab-bbbb`, agent: "codex", agentLabel: "Codex", state: "running", queuedAt: "2026-10-01T10:00:00.000Z", runnerId: "mac-1a2b" },
  })
  return {
    version: 12,
    project: {
      id: P,
      name: "Harbor notes",
      description: "",
      createdAt: "2026-10-01T09:00:00.000Z",
      mainSha: "d".repeat(40),
      counts: { rerun: 1, ship: 1, review: 0, working: 1, parked: 0, shipped: 0 },
      repo: P,
      seed: "harbor",
      previewUrl: `/preview/${P}/main/`,
    },
    lanes: [
      { lane: "rerun", tasks: [task("rerun", conflict, [discarded])] },
      { lane: "ship", tasks: [task("ship", ship, [], "Set the lede")] },
      { lane: "review", tasks: [] },
      { lane: "working", tasks: [task("working", working, [], "Add a tide tab")] },
      { lane: "parked", tasks: [] },
      { lane: "shipped", tasks: [] },
    ],
    activity: [{ at: "2026-10-01T10:06:00.000Z", kind: "conflict", text: '"Tint the pier name" now conflicts with main.' }],
    agents: [],
  }
}

async function setup(): Promise<{ board: MockBoard; cli: (argv: string[], env?: NodeJS.ProcessEnv) => Promise<{ code: number; out: string; err: string }> }> {
  const board = await startMockBoard()
  cleanups.push(() => board.close())
  board.projects = [boardView().project]
  board.boards.set(P, boardView())
  const cli = async (argv: string[], env: NodeJS.ProcessEnv = {}) => {
    const out: string[] = []
    const err: string[] = []
    const code = await runCli(argv, { env: { SHIPBOARD_URL: board.url, ...env }, out: (l) => out.push(l), err: (l) => err.push(l) })
    return { code, out: out.join("\n"), err: err.join("\n") }
  }
  return { board, cli }
}

describe("agent CLI", () => {
  it("lists projects with their lane counts", async () => {
    const { cli } = await setup()
    const res = await cli(["list"])
    expect(res.code).toBe(0)
    expect(res.out).toBe(`${P}  Harbor notes  main ddddddd  (rerun 1, ship 1, working 1)`)
  })

  it("prints the board as compact lanes in the fixed order", async () => {
    const { cli, board } = await setup()
    const res = await cli(["board", P])
    expect(res.code).toBe(0)
    expect(res.out).toContain(`preview ${board.url}/preview/${P}/main/`)
    const order = ["RE-RUN  1", "SHIP  1", "WORKING  1", "RECENT"].map((h) => res.out.indexOf(h))
    expect(order.every((i, n) => i >= 0 && (n === 0 || i > order[n - 1]!))).toBe(true)
    expect(res.out).toContain(`${P}--tint-the-pier-n-0002  conflicts with main in site/index.html`)
    expect(res.out).toContain("Touched site/index.html. Acceptance check passed.")
    expect(res.out).toContain("running on mac-1a2b")
    expect(res.out).not.toContain("REVIEW")
  })

  it("dispatches with every repeated --path, --constraint and --acceptance, and prints the returned attempt id", async () => {
    const { cli, board } = await setup()
    const res = await cli(
      [
        "dispatch",
        "--project", P,
        "--task", "Tint the pier name",
        "--path", "site/index.html",
        "--path", "site/styles.css",
        "--constraint", "Keep it static",
        "--constraint", "No new files",
        "--acceptance", 'contains site/index.html "teal"',
        "--acceptance", "Looks calm on a phone.",
        "--agent", "grok",
      ],
      { SHIPBOARD_TOKEN: board.boardToken },
    )
    expect(res.code).toBe(0)
    expect(board.dispatches).toEqual([
      {
        projectId: P,
        body: {
          task: "Tint the pier name",
          paths: ["site/index.html", "site/styles.css"],
          constraints: ["Keep it static", "No new files"],
          acceptance: 'contains site/index.html "teal"\nLooks calm on a phone.',
          agent: "grok",
        },
      },
    ])
    expect(res.out.split("\n")[0]).toBe(`${P}--tint-the-pier-na-ab12`)
    expect(res.out).toContain(`${board.url}/preview/${P}/${P}--tint-the-pier-na-ab12/`)
    const req = board.requests.find((r) => r.path.endsWith("/tasks"))
    expect(req?.authorization).toBe(`Bearer ${board.boardToken}`)
  })

  it("asks for --agent and lists the board's agents instead of defaulting to one", async () => {
    const { cli, board } = await setup()
    const res = await cli(["dispatch", "--project", P, "--task", "x", "--path", "a"], { SHIPBOARD_TOKEN: board.boardToken })
    expect(res.code).toBe(2)
    expect(res.err).toContain("dispatch needs --agent <id> (this board knows: grok (cli), manual (manual))")
    expect(board.dispatches).toHaveLength(0)

    const noPath = await cli(["dispatch", "--project", P, "--task", "x", "--agent", "grok"])
    expect(noPath.code).toBe(2)
    expect(noPath.err).toContain("at least one --path")
  })

  it("explains a missing board token", async () => {
    const { cli } = await setup()
    const res = await cli(["dispatch", "--project", P, "--task", "x", "--path", "a", "--agent", "grok"])
    expect(res.code).toBe(1)
    expect(res.err).toBe("This needs the board token. Set SHIPBOARD_TOKEN or pass --token.")
  })

  it("shows one attempt in detail, including discarded ones", async () => {
    const { cli, board } = await setup()
    const res = await cli(["status", `${P}--tint-the-pier-n-0001`])
    expect(res.code).toBe(0)
    expect(res.out).toContain("status    discarded (an earlier attempt)")
    expect(res.out).toContain(`replaced  by ${P}--tint-the-pier-n-0002: Conflicted with main in site/index.html after "Rename the pier mark" shipped.`)
    expect(res.out).toContain(`preview   ${board.url}/preview/${P}/${P}--tint-the-pier-n-0001/`)

    const current = await cli(["status", `${P}--tint-the-pier-n-0002`])
    expect(current.out).toContain("status    ready, lane rerun, next: rerun")
    expect(current.out).toContain("merge     conflict in site/index.html against main ddddddd")

    const missing = await cli(["status", `${P}--nope-0000`])
    expect(missing.code).toBe(1)
  })

  it("sends pushed with an optional sha", async () => {
    const { cli, board } = await setup()
    const res = await cli(["pushed", `${P}--set-the-lede-aaaa`, "--sha", "f".repeat(40)], { SHIPBOARD_TOKEN: board.boardToken })
    expect(res.code).toBe(0)
    expect(board.pushedCalls).toEqual([{ attemptId: `${P}--set-the-lede-aaaa`, sha: "f".repeat(40) }])
  })

  it("prints a clone/push recipe with --credentials that works as printed and keeps the token out of argv", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "shipboard-cli-git-"))
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }))
    const git = await startGitServer(root)
    cleanups.push(() => git.close())
    const fx = await makeFixture({ root, attemptId: `${P}--tint-the-pier-na-ab12` })
    const { cli, board } = await setup()
    board.dispatchCredentials = () => {
      const minted = git.mint(fx.attemptId, "write", 3600)
      return { remote: git.remote(fx.attemptId), token: minted.token, expiresAt: minted.expiresAt, scope: "write" }
    }

    const res = await cli(["dispatch", "--project", P, "--task", "Tint the pier name", "--path", "site/index.html", "--agent", "manual", "--credentials"], {
      SHIPBOARD_TOKEN: board.boardToken,
    })
    expect(res.code).toBe(0)
    expect(board.dispatches[0]?.body.credentials).toBe(true)
    const recipe = res.out.split("\n").filter((l) => l.startsWith("  ")).map((l) => l.trim())
    expect(recipe[0]).toMatch(/^export SHIPBOARD_GIT_AUTH='Authorization: Bearer art_v1_[0-9a-f]{40}\?expires=\d+'$/)
    expect(recipe.some((l) => l.includes("git -c"))).toBe(false)
    expect(recipe).toContain(`npm run agent -- pushed ${fx.attemptId}`)

    // Run the recipe as printed, with an edit where the comment says to make the change.
    const work = await fs.mkdtemp(path.join(os.tmpdir(), "shipboard-cli-work-"))
    cleanups.push(() => fs.rm(work, { recursive: true, force: true }))
    const script = recipe
      .filter((l) => !l.startsWith("npm run"))
      .map((l) => (l.startsWith("#") ? "printf '<p>teal</p>\\n' >> site/index.html" : l))
      .join("\n")
    // Async: the git server runs in this process, so a sync exec would deadlock it.
    await execFileAsync("/bin/sh", ["-ec", script], {
      cwd: work,
      timeout: 30_000,
      env: {
        PATH: process.env.PATH,
        HOME: work,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0",
        GIT_AUTHOR_NAME: "Manual",
        GIT_AUTHOR_EMAIL: "manual@example.invalid",
        GIT_COMMITTER_NAME: "Manual",
        GIT_COMMITTER_EMAIL: "manual@example.invalid",
      },
    })
    const head = headOf(fx.forkRepo)
    expect(head).not.toBe(fx.briefSha)
    const clonedConfig = await fs.readFile(path.join(work, fx.attemptId, ".git", "config"), "utf8")
    expect(clonedConfig).not.toMatch(/art_v1|extraheader/i)
    expect(git.requests.filter((r) => r.service === "receive-pack").every((r) => r.status === 200)).toBe(true)
  })

  it("says so when the board returns no credentials", async () => {
    const { cli, board } = await setup()
    const res = await cli(["dispatch", "--project", P, "--task", "x", "--path", "a", "--agent", "grok", "--credentials"], { SHIPBOARD_TOKEN: board.boardToken })
    expect(res.code).toBe(0)
    expect(res.out).toContain('only manual agents get a token, and "grok" is not one')
  })

  it("rejects unknown commands and flags with usage", async () => {
    const { cli } = await setup()
    expect((await cli(["frob"])).code).toBe(2)
    const res = await cli(["list", "--bogus"])
    expect(res.code).toBe(2)
    expect(res.err).toContain("Unknown flag --bogus")
  })
})

describe("shQuote", () => {
  it("quotes for sh", () => {
    expect(shQuote("plain/path.git")).toBe("plain/path.git")
    expect(shQuote("it's here")).toBe("'it'\\''s here'")
    expect(shQuote("$(rm -rf /)")).toBe("'$(rm -rf /)'")
  })
})
