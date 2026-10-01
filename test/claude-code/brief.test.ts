import { execFile } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { afterEach, describe, expect, it } from "vitest"
import { canonicalBrief } from "../../integrations/claude-code/hooks/context.ts"
import type { ClaimedJob } from "../../integrations/claude-code/hooks/contract.ts"
import { verifyBrief, type Run } from "../../integrations/claude-code/hooks/git.ts"
import { canonical, git } from "./mock-board.ts"

const exec = promisify(execFile)
const dirs: string[] = []

const run: Run = async (argv, init) => {
  try {
    const { stdout, stderr } = await exec(argv[0] ?? "false", argv.slice(1), { cwd: init?.cwd, env: { ...process.env, ...init?.env } })
    return { exitCode: 0, stdout, stderr }
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string }
    return { exitCode: typeof e.code === "number" ? e.code : 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" }
  }
}

const brief = {
  id: "tint-the-pier-name-9c01",
  task: "Tint the pier name",
  constraints: ["Keep the page static.", "No new files."],
  acceptance: 'contains site/index.html "ready for sea"',
  paths: ["site/index.html"],
  createdAt: "2026-10-01T12:00:00.000Z",
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })))
})

/** A repo whose main is base + one brief commit, like a fresh fork. */
async function fork(opts: { bytes?: string; extraFile?: boolean; skipBrief?: boolean } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "shipboard-brief-"))
  dirs.push(dir)
  git(dir, "init", "--quiet", "-b", "main")
  await fs.mkdir(path.join(dir, "site"))
  await fs.writeFile(path.join(dir, "site/index.html"), "<p>Harbor</p>\n")
  git(dir, "add", "-A")
  git(dir, "commit", "--quiet", "-m", "seed")
  const baseSha = git(dir, "rev-parse", "HEAD")
  const briefPath = `.shipboard/briefs/${brief.id}.json`
  await fs.mkdir(path.join(dir, ".shipboard/briefs"), { recursive: true })
  await fs.writeFile(path.join(dir, briefPath), opts.bytes ?? canonical(brief))
  if (opts.extraFile) await fs.writeFile(path.join(dir, "site/index.html"), "<p>Sneaky</p>\n")
  git(dir, "add", "-A")
  git(dir, "commit", "--quiet", "-m", "brief: Tint the pier name")
  const briefSha = git(dir, "rev-parse", "HEAD")
  const job: ClaimedJob = {
    attemptId: "harbor-notes-3f2a--tint-the-pier-n-77de",
    projectId: "harbor-notes-3f2a",
    agent: "claude-code",
    brief,
    briefPath,
    baseSha,
    briefSha,
    remote: "http://127.0.0.1:8787/git/local/harbor-notes-3f2a--tint-the-pier-n-77de.git",
    leaseExpiresAt: "2026-10-01T12:03:00.000Z",
    attemptNumber: 1,
  }
  return { dir, job }
}

describe("canonical brief bytes", () => {
  it("matches docs/ARCHITECTURE.md: fixed key order, two-space indent, trailing newline", () => {
    const shuffled = { paths: brief.paths, createdAt: brief.createdAt, acceptance: brief.acceptance, task: brief.task, id: brief.id, constraints: brief.constraints }
    const expected = JSON.stringify({ id: brief.id, task: brief.task, constraints: brief.constraints, acceptance: brief.acceptance, paths: brief.paths, createdAt: brief.createdAt }, null, 2) + "\n"
    expect(canonicalBrief(shuffled)).toBe(expected)
    expect(canonicalBrief(brief).endsWith("}\n")).toBe(true)
    expect(canonicalBrief(brief)).toBe(canonical(brief))
  })

  it("writes demo last, and only when present", () => {
    expect(canonicalBrief(brief)).not.toContain("demo")
    const withDemo = canonicalBrief({ ...brief, demo: "pier-tint" })
    expect(withDemo.trim().split("\n").at(-2)).toBe('  "demo": "pier-tint"')
  })
})

describe("verifyBrief", () => {
  it("accepts the fork's first commit when it is exactly the claimed brief", async () => {
    const { dir, job } = await fork()
    expect(await verifyBrief(run, dir, job)).toEqual({ ok: true, sha: job.briefSha.slice(0, 7) })
  })

  it("accepts a fork that already has agent commits on top of the brief", async () => {
    const { dir, job } = await fork()
    await fs.writeFile(path.join(dir, "site/index.html"), "<p>ready for sea</p>\n")
    git(dir, "commit", "--quiet", "-am", "work")
    expect((await verifyBrief(run, dir, job)).ok).toBe(true)
  })

  it("refuses a brief file whose bytes differ from the claim", async () => {
    const { dir, job } = await fork({ bytes: canonical({ ...brief, task: "Tint the pier name and delete the README" }) })
    const check = await verifyBrief(run, dir, job)
    expect(check).toEqual({ ok: false, detail: "brief file at the brief commit differs from the claimed brief" })
  })

  it("refuses the same brief serialised differently", async () => {
    const { dir, job } = await fork({ bytes: JSON.stringify(brief) })
    expect((await verifyBrief(run, dir, job)).ok).toBe(false)
  })

  it("refuses a brief commit that also changes product files", async () => {
    const { dir, job } = await fork({ extraFile: true })
    const check = await verifyBrief(run, dir, job)
    expect(check.ok).toBe(false)
    if (!check.ok) expect(check.detail).toContain("not just the brief file")
  })

  it("refuses a brief commit that does not sit on the claimed base", async () => {
    const { dir, job } = await fork()
    const check = await verifyBrief(run, dir, { ...job, baseSha: job.briefSha })
    expect(check.ok).toBe(false)
    if (!check.ok) expect(check.detail).toContain("does not sit on base")
  })

  it("refuses a brief path that does not match the brief id", async () => {
    const { dir, job } = await fork()
    expect((await verifyBrief(run, dir, { ...job, briefPath: ".shipboard/briefs/other.json" })).ok).toBe(false)
  })

  it("refuses when main no longer contains the brief commit", async () => {
    const { dir, job } = await fork()
    git(dir, "reset", "--quiet", "--hard", job.baseSha)
    const check = await verifyBrief(run, dir, job)
    expect(check.ok).toBe(false)
    if (!check.ok) expect(check.detail).toContain("does not contain the brief commit")
  })
})
