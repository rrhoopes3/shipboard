/**
 * Builds the git side of a dispatch on disk, the way the local host does: a bare main repo, a bare
 * fork cut from it, and the brief committed as the fork's first commit after base.
 */

import { execFileSync } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { Brief, ClaimedJob } from "../../../src/core/types.ts"
import { briefPathFor, canonicalBriefJson } from "../../../runner/brief.ts"

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
}

export function sh(cwd: string, args: string[], input?: string): string {
  return execFileSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8", input, stdio: ["pipe", "pipe", "pipe"] }).trim()
}

async function writeFiles(dir: string, files: Record<string, string>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel)
    await fs.mkdir(path.dirname(full), { recursive: true })
    await fs.writeFile(full, content)
  }
}

export type Fixture = {
  root: string
  projectId: string
  attemptId: string
  baseSha: string
  briefSha: string
  brief: Brief
  /** Bare repo paths. */
  mainRepo: string
  forkRepo: string
}

export function sampleBrief(overrides: Partial<Brief> = {}): Brief {
  return {
    id: "tint-the-pier-name-9c01",
    task: "Tint the pier name",
    constraints: ["Keep the page static"],
    acceptance: 'contains site/index.html "teal"',
    paths: ["site/index.html"],
    createdAt: "2026-10-01T10:00:00.000Z",
    ...overrides,
  }
}

export async function makeFixture(opts: {
  root: string
  projectId?: string
  attemptId?: string
  brief?: Brief
  files?: Record<string, string>
  /** Committed instead of the canonical brief bytes (for mismatch tests). */
  briefContent?: string
}): Promise<Fixture> {
  const projectId = opts.projectId ?? "harbor-notes-3f2a"
  const attemptId = opts.attemptId ?? `${projectId}--tint-the-pier-n-77de`
  const brief = opts.brief ?? sampleBrief()
  const ns = path.join(opts.root, "local")
  await fs.mkdir(ns, { recursive: true })

  const work = await fs.mkdtemp(path.join(os.tmpdir(), "shipboard-seed-"))
  try {
    sh(work, ["init", "--quiet", "-b", "main"])
    await writeFiles(work, opts.files ?? { "site/index.html": "<h1>Pier</h1>\n", "README.md": "# Harbor notes\n" })
    sh(work, ["add", "-A"])
    sh(work, ["commit", "--quiet", "-m", "seed"])
    const baseSha = sh(work, ["rev-parse", "HEAD"])
    const mainRepo = path.join(ns, `${projectId}.git`)
    sh(opts.root, ["clone", "--quiet", "--bare", work, mainRepo])

    const forkRepo = path.join(ns, `${attemptId}.git`)
    sh(opts.root, ["clone", "--quiet", "--bare", "--single-branch", mainRepo, forkRepo])

    await writeFiles(work, { [briefPathFor(brief.id)]: opts.briefContent ?? canonicalBriefJson(brief) })
    sh(work, ["add", "-A"])
    sh(work, ["commit", "--quiet", "-m", `brief: ${brief.task}`])
    const briefSha = sh(work, ["rev-parse", "HEAD"])
    sh(work, ["push", "--quiet", forkRepo, "HEAD:refs/heads/main"])

    return { root: opts.root, projectId, attemptId, baseSha, briefSha, brief, mainRepo, forkRepo }
  } finally {
    await fs.rm(work, { recursive: true, force: true })
  }
}

export function claimedJob(fx: Fixture, remote: string, overrides: Partial<ClaimedJob> = {}): ClaimedJob {
  return {
    attemptId: fx.attemptId,
    projectId: fx.projectId,
    agent: "script",
    brief: fx.brief,
    briefPath: briefPathFor(fx.brief.id),
    baseSha: fx.baseSha,
    briefSha: fx.briefSha,
    remote,
    leaseExpiresAt: new Date(Date.now() + 180_000).toISOString(),
    attemptNumber: 1,
    ...overrides,
  }
}

/** Head of a bare repo's main. */
export function headOf(bareRepo: string): string {
  return sh(bareRepo, ["rev-parse", "refs/heads/main"])
}

/** Push one more commit to a bare repo's main, as if someone else got there first. */
export async function advance(bareRepo: string, file: string, content: string): Promise<string> {
  const work = await fs.mkdtemp(path.join(os.tmpdir(), "shipboard-advance-"))
  try {
    sh(work, ["clone", "--quiet", bareRepo, "w"])
    const w = path.join(work, "w")
    await writeFiles(w, { [file]: content })
    sh(w, ["add", "-A"])
    sh(w, ["commit", "--quiet", "-m", "someone else"])
    sh(w, ["push", "--quiet", "origin", "HEAD:main"])
    return sh(w, ["rev-parse", "HEAD"])
  } finally {
    await fs.rm(work, { recursive: true, force: true })
  }
}
