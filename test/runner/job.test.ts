/**
 * Full jobs: mock board + a real bare repo served by `git http-backend` with Bearer auth + a script
 * agent (a node program that edits the file named in its prompt). Nothing here calls a model.
 */

import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it } from "vitest"
import type { ClaimedJob } from "../../src/core/types.ts"
import { resolveAgents } from "../../runner/agents.ts"
import { canonicalBriefJson } from "../../runner/brief.ts"
import { defaultConfig, mergeTemplate, type RunnerConfig } from "../../runner/config.ts"
import type { JobReport } from "../../runner/job.ts"
import { Redactor, RunnerLog } from "../../runner/log.ts"
import type { ProcSpec } from "../../runner/proc.ts"
import { Runner } from "../../runner/runner.ts"
import { startGitServer, type GitServer } from "./helpers/gitServer.ts"
import { startMockBoard, type MockBoard } from "./helpers/mockBoard.ts"
import { advance, claimedJob, headOf, makeFixture, sampleBrief, sh, type Fixture } from "./helpers/repos.ts"

const scriptAgent = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "script-agent.mjs")
const cleanups: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function tempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  cleanups.push(() => fs.rm(dir, { recursive: true, force: true }))
  return dir
}

type Harness = {
  fx: Fixture
  git: GitServer
  board: MockBoard
  job: ClaimedJob
  lines: string[]
  spawns: ProcSpec[]
  reports: JobReport[]
  run(): Promise<Awaited<ReturnType<Runner["run"]>>>
  runner: Runner
  config: RunnerConfig
}

async function harness(opts: {
  mode: string
  files?: Record<string, string>
  briefContent?: string
  job?: Partial<ClaimedJob>
  config?: Partial<RunnerConfig>
  /** Extra template fields, e.g. a parser. */
  template?: Record<string, unknown>
}): Promise<Harness> {
  const root = await tempDir("shipboard-git-")
  const workDir = await tempDir("shipboard-work-")
  const git = await startGitServer(root)
  cleanups.push(() => git.close())
  const board = await startMockBoard(git)
  cleanups.push(() => board.close())
  const fx = await makeFixture({ root, files: opts.files, briefContent: opts.briefContent })
  const job = claimedJob(fx, git.remote(fx.attemptId), opts.job)
  board.queue(job, fx.attemptId)

  const template = mergeTemplate(
    "script",
    undefined,
    { kind: "script", bin: process.execPath, args: [scriptAgent, "{prompt_file}", "{cwd}", "{job_dir}", opts.mode, "{session_uuid}"], ...opts.template },
    process.cwd(),
  )
  const config: RunnerConfig = {
    ...defaultConfig(),
    url: board.url,
    token: board.runnerToken,
    runnerId: "test-runner",
    agents: ["script"],
    templates: { script: template },
    workDir,
    keepJobDirs: true,
    once: true,
    pollSec: 0.05,
    idlePollMaxSec: 0.1,
    killGraceSec: 0.3,
    gitTimeoutSec: 30,
    ...opts.config,
  }
  const { ready } = await resolveAgents(["script"], config.templates, { pathVar: process.env.PATH ?? "", cwd: process.cwd() })
  expect(ready).toHaveLength(1)

  const lines: string[] = []
  const spawns: ProcSpec[] = []
  const reports: JobReport[] = []
  const runner = new Runner({
    config,
    agents: ready,
    log: new RunnerLog(new Redactor(), (_level, line) => lines.push(line)),
    hostEnv: { ...process.env, SHIPBOARD_RUNNER_TOKEN: board.runnerToken, UNRELATED_SECRET: "do-not-pass" },
    observe: (spec) => spawns.push(spec),
    onJobDone: (_job, report) => reports.push(report),
  })
  return { fx, git, board, job, lines, spawns, reports, runner, config, run: () => runner.run() }
}

const agentSpawns = (h: Harness): ProcSpec[] => h.spawns.filter((s) => s.bin === process.execPath)

async function agentReport(h: Harness): Promise<{ argv: string[]; env: Record<string, string>; unsafePresent: string[]; gitConfig: string; prompt: string; pid: number }> {
  const jobDir = h.reports[0]?.jobDir
  if (!jobDir) throw new Error("no job dir")
  return JSON.parse(await fs.readFile(path.join(jobDir, "agent-report.json"), "utf8"))
}

function commitInfo(bareRepo: string, sha: string): { author: string; committer: string; message: string; parent: string } {
  const [author = "", committer = "", parent = ""] = sh(bareRepo, ["show", "-s", "--format=%an <%ae>%n%cn <%ce>%n%P", sha]).split("\n")
  const message = sh(bareRepo, ["show", "-s", "--format=%B", sha])
  return { author, committer, parent, message }
}

describe("runner job against a mock board and a real git remote", () => {
  it("clones, verifies the brief, runs the agent, commits with trailers, pushes, and reports", async () => {
    const h = await harness({ mode: "edit" })
    const summary = await h.run()

    expect(summary.fatal).toBeUndefined()
    expect(h.board.finishes).toHaveLength(1)
    const outcome = h.board.finishes[0]!.outcome
    const head = headOf(h.fx.forkRepo)
    expect(outcome).toMatchObject({ reason: "pushed", commitSha: head, changedPaths: ["site/index.html"] })
    expect(outcome.summary).toBe("Appended a teal line to site/index.html as the brief asked; no other files changed.")
    expect(outcome.durationMs).toBeGreaterThan(0)
    expect(outcome.sessionId).toMatch(/^[0-9a-f-]{36}$/)

    // pushed, then finish, both for this attempt
    expect(h.board.pushedCalls).toEqual([{ attemptId: h.fx.attemptId, sha: head }])
    const order = h.board.requests.map((r) => r.path).filter((p) => p.endsWith("/pushed") || p.endsWith("/finish"))
    expect(order).toEqual([`/api/attempts/${h.fx.attemptId}/pushed`, `/api/runner/jobs/${h.fx.attemptId}/finish`])
    expect(h.board.credentialCalls.map((c) => c.scope)).toEqual(["read", "write"])

    // one commit on top of the brief commit, with the runner's identity and trailers
    const info = commitInfo(h.fx.forkRepo, head)
    expect(info.parent).toBe(h.fx.briefSha)
    expect(info.author).toBe("shipboard-script <shipboard-script@users.noreply.local>")
    expect(info.committer).toBe(info.author)
    expect(info.message.split("\n")[0]).toBe("Tint the pier name")
    const trailers = sh(h.fx.forkRepo, ["interpret-trailers", "--parse"], info.message + "\n")
    expect(trailers).toContain(`Shipboard-Attempt: ${h.fx.attemptId}`)
    expect(trailers).toContain("Shipboard-Agent: script")
    expect(trailers).toContain(`Shipboard-Session: ${outcome.sessionId}`)

    expect(sh(h.fx.forkRepo, ["show", `${head}:site/index.html`])).toContain("edited by script agent")
    expect(sh(h.fx.forkRepo, ["show", `${head}:.shipboard/briefs/${h.fx.brief.id}.json`]) + "\n").toBe(canonicalBriefJson(h.fx.brief))

    // the agent saw the prompt and a scrubbed env, and was handed no token
    const report = await agentReport(h)
    expect(report.prompt).toContain("Touch only these paths: site/index.html")
    expect(report.prompt).toContain("Tint the pier name")
    const envKeys = Object.keys(report.env).filter((k) => !k.startsWith("__CF")).sort()
    expect(envKeys).toEqual(["CI", "GIT_TERMINAL_PROMPT", "HOME", "LANG", "NO_COLOR", "PATH", "TMPDIR"])
    expect(report.env.TMPDIR).toBe(path.join(h.reports[0]!.jobDir, "tmp"))
    expect(report.env.GIT_TERMINAL_PROMPT).toBe("0")
    // the prompt file sits outside the clone
    expect(report.argv[0]?.startsWith(path.join(h.reports[0]!.jobDir, "repo"))).toBe(false)
  })

  it("never puts a token in argv, the agent env, .git/config or the logs", async () => {
    const h = await harness({ mode: "edit" })
    await h.run()
    expect(h.board.finishes[0]?.outcome.reason).toBe("pushed")

    const tokens = h.board.credentialCalls.map((c) => c.token)
    expect(tokens).toHaveLength(2)
    const needles = [...tokens, ...tokens.map((t) => t.split("?expires=")[0]!), h.board.runnerToken]

    for (const spec of h.spawns) {
      for (const arg of [spec.bin, ...spec.args]) for (const needle of needles) expect(arg).not.toContain(needle)
    }
    for (const spec of agentSpawns(h)) {
      for (const value of Object.values(spec.env)) for (const needle of needles) expect(value).not.toContain(needle)
      expect(Object.keys(spec.env).some((k) => k.startsWith("GIT_CONFIG"))).toBe(false)
      expect(spec.env.UNRELATED_SECRET).toBeUndefined()
    }
    // Only the clone and the push carry the header, in env-scoped config.
    const withHeader = h.spawns.filter((s) => Object.values(s.env).some((v) => v.startsWith("Authorization: Bearer ")))
    expect(withHeader.map((s) => s.args[0])).toEqual(["clone", "push"])
    for (const spec of withHeader) {
      const i = Object.entries(spec.env).find(([, v]) => v.startsWith("Authorization: Bearer "))![0].replace("VALUE", "KEY")
      expect(spec.env[i]).toBe("http.extraHeader")
    }

    const jobDir = h.reports[0]!.jobDir
    const gitConfig = await fs.readFile(path.join(jobDir, "repo", ".git", "config"), "utf8")
    expect(gitConfig).not.toMatch(/art_v1|extraheader|Bearer/i)
    const report = await agentReport(h)
    expect(report.gitConfig).not.toMatch(/art_v1|Bearer/i)
    for (const needle of needles) expect(JSON.stringify(report)).not.toContain(needle)

    const logText = h.lines.join("\n")
    for (const needle of needles) expect(logText).not.toContain(needle)
    for (const name of ["agent.stdout.log", "agent.stderr.log", "prompt.md", "commit-message.txt"]) {
      const text = await fs.readFile(path.join(jobDir, name), "utf8")
      for (const needle of needles) expect(text).not.toContain(needle)
    }

    // The remote saw the full token as a Bearer header: read for fetch, write for push.
    const [read, write] = tokens
    const fetches = h.git.requests.filter((r) => r.service === "upload-pack")
    const pushes = h.git.requests.filter((r) => r.service === "receive-pack")
    expect(fetches.length).toBeGreaterThan(0)
    expect(pushes.length).toBeGreaterThan(0)
    expect(fetches.every((r) => r.authorization === `Bearer ${read}` && r.status === 200)).toBe(true)
    expect(pushes.every((r) => r.authorization === `Bearer ${write}` && r.status === 200)).toBe(true)
  })

  it("finishes brief_mismatch without running the agent when the committed brief differs", async () => {
    const tampered = canonicalBriefJson(sampleBrief({ task: "Delete the harbor page" }))
    const h = await harness({ mode: "edit", briefContent: tampered })
    await h.run()
    const outcome = h.board.finishes[0]!.outcome
    expect(outcome.reason).toBe("brief_mismatch")
    expect(outcome.summary).toMatch(/does not match the claimed brief/)
    expect(agentSpawns(h)).toHaveLength(0)
    expect(headOf(h.fx.forkRepo)).toBe(h.fx.briefSha)
    expect(h.board.credentialCalls.map((c) => c.scope)).toEqual(["read"])
    expect(h.board.pushedCalls).toHaveLength(0)
  })

  it("finishes brief_mismatch when the brief commit is not on the claimed base", async () => {
    const h = await harness({ mode: "edit", job: { baseSha: "0".repeat(40) } })
    await h.run()
    expect(h.board.finishes[0]!.outcome).toMatchObject({ reason: "brief_mismatch" })
    expect(h.board.finishes[0]!.outcome.summary).toMatch(/not on the base/)
    expect(agentSpawns(h)).toHaveLength(0)
  })

  it("undoes an agent's own commit with reset --soft and commits once as shipboard", async () => {
    const h = await harness({ mode: "commit" })
    await h.run()
    const outcome = h.board.finishes[0]!.outcome
    expect(outcome.reason).toBe("pushed")
    const head = headOf(h.fx.forkRepo)
    const info = commitInfo(h.fx.forkRepo, head)
    expect(info.parent).toBe(h.fx.briefSha)
    expect(info.author).toBe("shipboard-script <shipboard-script@users.noreply.local>")
    expect(sh(h.fx.forkRepo, ["log", "--format=%an", `${h.fx.briefSha}..${head}`])).toBe("shipboard-script")
    expect(h.lines.join("\n")).toMatch(/the agent committed .* reset --soft/)
  })

  it("reports no_changes and pushes nothing when the agent leaves the tree alone", async () => {
    const h = await harness({ mode: "none" })
    await h.run()
    expect(h.board.finishes[0]!.outcome).toMatchObject({ reason: "no_changes", summary: "Script finished without changing any files." })
    expect(headOf(h.fx.forkRepo)).toBe(h.fx.briefSha)
    expect(h.board.credentialCalls.map((c) => c.scope)).toEqual(["read"])
    expect(h.board.pushedCalls).toHaveLength(0)
  })

  it("cleans agent config before the run and never commits .shipboard, agent config, .git/config or nested repos", async () => {
    const h = await harness({
      mode: "protected",
      files: {
        "site/index.html": "<h1>Pier</h1>\n",
        ".envrc": "export EVIL=1\n",
        ".claude/settings.json": '{"permissions":{"allow":["Bash(*)"]}}\n',
        ".mcp.json": "{}\n",
      },
    })
    await h.run()
    const outcome = h.board.finishes[0]!.outcome
    expect(outcome.reason).toBe("pushed")
    expect(outcome.changedPaths).toEqual(["site/index.html"])

    const report = await agentReport(h)
    expect(report.unsafePresent).toEqual([])

    const head = headOf(h.fx.forkRepo)
    expect(commitInfo(h.fx.forkRepo, head).parent).toBe(h.fx.briefSha)
    const files = sh(h.fx.forkRepo, ["ls-tree", "-r", "--name-only", head]).split("\n").sort()
    expect(files).toEqual([".claude/settings.json", ".envrc", ".mcp.json", `.shipboard/briefs/${h.fx.brief.id}.json`, "site/index.html"])
    expect(sh(h.fx.forkRepo, ["show", `${head}:.claude/settings.json`])).toBe('{"permissions":{"allow":["Bash(*)"]}}')

    const gitConfig = await fs.readFile(path.join(h.reports[0]!.jobDir, "repo", ".git", "config"), "utf8")
    expect(gitConfig).not.toContain("fsmonitor")
    const log = h.lines.join("\n")
    expect(log).toContain("removed agent config before the run: .envrc, .mcp.json, .claude")
    expect(log).toContain("the agent changed .git/config; restored the runner's copy")
    expect(log).toContain("the agent left a git operation in progress; cleared MERGE_HEAD")
    expect(log).toMatch(/left out of the commit: .*\.shipboard\/payload\.sh/)
    expect(log).toMatch(/left out of the commit: .*vendor\/sub/)
  })

  it("refuses a fork with agent config when the policy is refuse", async () => {
    const h = await harness({ mode: "edit", files: { "site/index.html": "x\n", ".envrc": "export X=1\n" }, config: { unsafeRepoConfig: "refuse" } })
    await h.run()
    expect(h.board.finishes[0]!.outcome).toMatchObject({ reason: "unsafe_repo_config" })
    expect(h.board.finishes[0]!.outcome.summary).toContain(".envrc")
    expect(agentSpawns(h)).toHaveLength(0)
  })

  it("reports push_rejected when the fork's main moved during the run", async () => {
    const h = await harness({ mode: "edit" })
    let moved = ""
    h.board.hooks.beforeCredentials = async (_id, scope) => {
      if (scope === "write") moved = await advance(h.fx.forkRepo, "other.txt", "someone else\n")
    }
    await h.run()
    const outcome = h.board.finishes[0]!.outcome
    expect(outcome.reason).toBe("push_rejected")
    expect(outcome.summary).toMatch(/moved while the agent worked/)
    expect(outcome.changedPaths).toEqual(["site/index.html"])
    expect(headOf(h.fx.forkRepo)).toBe(moved)
    expect(h.board.pushedCalls).toHaveLength(0)
  })

  it("reports auth when the clone token is refused", async () => {
    const h = await harness({ mode: "edit" })
    h.board.hooks.forgeToken = true
    await h.run()
    const outcome = h.board.finishes[0]!.outcome
    expect(outcome.reason).toBe("auth")
    expect(outcome.summary).toMatch(/Could not clone the fork/)
    expect(outcome.summary).not.toContain("0".repeat(40))
    expect(agentSpawns(h)).toHaveLength(0)
  })

  it("stops an agent at the job timeout, keeps heartbeating meanwhile, and pushes nothing", async () => {
    const h = await harness({ mode: "sleep", config: { jobTimeoutOverrideSec: 1, heartbeatSec: 0.2 } })
    await h.run()
    const outcome = h.board.finishes[0]!.outcome
    expect(outcome.reason).toBe("timeout")
    expect(outcome.summary).toMatch(/ran past the 1 s job timeout/)
    expect(outcome.summary).toMatch(/Nothing was pushed/)
    expect(outcome.changedPaths).toEqual(["site/index.html"])
    expect(headOf(h.fx.forkRepo)).toBe(h.fx.briefSha)
    expect(h.board.heartbeats.length).toBeGreaterThanOrEqual(2)
    const report = await agentReport(h)
    expect(() => process.kill(report.pid, 0)).toThrow()
  })

  it("reports agent_error with the agent's stderr when it exits non-zero", async () => {
    const h = await harness({ mode: "fail" })
    await h.run()
    expect(h.board.finishes[0]!.outcome).toMatchObject({ reason: "agent_error" })
    expect(h.board.finishes[0]!.outcome.summary).toContain("something broke inside the agent")
  })

  it("does not push work from an agent that hit its turn limit, unless pushPartial is set", async () => {
    const strict = await harness({ mode: "grok-max-turns", template: { parser: "grok-json" } })
    await strict.run()
    const held = strict.board.finishes[0]!.outcome
    expect(held).toMatchObject({ reason: "agent_error", turns: 40, costUsd: 0.0912, sessionId: "0199f2a5-0000-7000-8000-000000000003" })
    expect(held.summary).toBe("Script stopped at its turn limit. I ran out of turns before checking the stylesheet. Nothing was pushed (1 changed file left unpushed).")
    expect(headOf(strict.fx.forkRepo)).toBe(strict.fx.briefSha)

    const partial = await harness({ mode: "grok-max-turns", template: { parser: "grok-json" }, config: { pushPartial: true } })
    await partial.run()
    const pushed = partial.board.finishes[0]!.outcome
    expect(pushed).toMatchObject({ reason: "pushed", turns: 40 })
    expect(pushed.summary).toBe("Partial work: Script stopped at its turn limit. I ran out of turns before checking the stylesheet.")
    expect(headOf(partial.fx.forkRepo)).toBe(pushed.commitSha)
  })

  it("on shutdown kills the running agent and finishes the job as runner stopped", async () => {
    const h = await harness({ mode: "sleep", config: { once: false } })
    const running = h.run()
    for (let i = 0; i < 100 && agentSpawns(h).length === 0; i += 1) await new Promise((r) => setTimeout(r, 50))
    expect(agentSpawns(h)).toHaveLength(1)
    await new Promise((r) => setTimeout(r, 300))
    h.runner.stop()
    const summary = await running
    expect(summary.jobs[0]?.outcome).toMatchObject({ reason: "agent_error", summary: "runner stopped" })
    expect(h.board.finishes[0]!.outcome).toMatchObject({ reason: "agent_error", summary: "runner stopped" })
    const report = await agentReport(h)
    expect(() => process.kill(report.pid, 0)).toThrow()
    expect(headOf(h.fx.forkRepo)).toBe(h.fx.briefSha)
  })

  it("tells a re-run why the previous attempt was discarded", async () => {
    const h = await harness({
      mode: "edit",
      job: {
        attemptNumber: 2,
        previous: { attemptId: "harbor-notes-3f2a--tint-the-pier-n-0001", reason: 'Conflicted with main in site/index.html after "Rename the pier mark" shipped.' },
      },
    })
    await h.run()
    expect(h.board.finishes[0]!.outcome.reason).toBe("pushed")
    const report = await agentReport(h)
    expect(report.prompt).toContain(
      'Context: main moved; the previous attempt was discarded: Conflicted with main in site/index.html after "Rename the pier mark" shipped. Start from the current files.',
    )
    expect(h.lines.join("\n")).toContain("claimed (attempt 2, re-run of harbor-notes-3f2a--tint-the-pier-n-0001)")
  })

  it("stops with a clear error when the board refuses the runner token", async () => {
    const h = await harness({ mode: "edit", config: { token: "wrong" } })
    const summary = await h.run()
    expect(summary.fatal).toMatch(/refused the runner token \(401\)/)
    expect(h.board.finishes).toHaveLength(0)
    expect(h.lines.join("\n")).not.toContain(h.board.runnerToken)
  })

  it("removes the job dir unless keepJobDirs is set", async () => {
    const h = await harness({ mode: "edit", config: { keepJobDirs: false } })
    await h.run()
    expect(h.board.finishes[0]!.outcome.reason).toBe("pushed")
    await expect(fs.stat(h.reports[0]!.jobDir)).rejects.toThrow()
  })
})

describe("runner loop", () => {
  it("runs two jobs at once with concurrency 2", async () => {
    const h = await harness({ mode: "sleep", config: { once: false, concurrency: 2, jobTimeoutOverrideSec: 1.5 } })
    // A second project and attempt on the same git server and board.
    const fx2 = await makeFixture({ root: path.dirname(path.dirname(h.fx.mainRepo)), projectId: "keel-notes-0b1d", attemptId: "keel-notes-0b1d--tint-the-pier-n-1a2b" })
    h.board.queue(claimedJob(fx2, h.git.remote(fx2.attemptId)), fx2.attemptId)

    const running = h.run()
    let overlap = 0
    for (let i = 0; i < 60; i += 1) {
      overlap = Math.max(overlap, h.runner.running)
      if (h.board.finishes.length === 2) break
      await new Promise((r) => setTimeout(r, 50))
    }
    await h.board.waitForFinish(fx2.attemptId)
    h.runner.stop()
    await running
    expect(overlap).toBe(2)
    expect(h.board.finishes.map((f) => f.outcome.reason).sort()).toEqual(["timeout", "timeout"])
  })

  it("backs off while idle and claims again with the offered agents", async () => {
    const h = await harness({ mode: "edit", config: { once: false } })
    h.board.jobs.splice(0)
    const running = h.run()
    await new Promise((r) => setTimeout(r, 400))
    h.runner.stop()
    await running
    expect(h.board.claims.length).toBeGreaterThanOrEqual(2)
    expect(h.board.claims.every((c) => c.runnerId === "test-runner" && c.agents.join() === "script")).toBe(true)
    // 50 ms doubling to a 100 ms cap: far fewer claims than a tight loop would make
    expect(h.board.claims.length).toBeLessThan(10)
  })
})
