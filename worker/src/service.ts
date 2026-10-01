import crypto from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { trialMerge } from "../../sandbox/trialMerge.ts"
import { buildDigest, parseChecks } from "./digest.ts"
import { BoardError } from "./errors.ts"
import { assertSafeRel, isId, isInside, oneLine, slug } from "./paths.ts"
import { Repo } from "./repo.ts"
import { isReplay, PIER, runReplay, type ReplayId } from "./replays.ts"
import { northlineFiles, starterFiles } from "./seeds.ts"
import { Store } from "./store.ts"
import type { Action, Brief, ForkInput, ForkRecord, ProjectRecord } from "./types.ts"

const AGENTS: Record<string, string> = {
  claude: "Claude",
  codex: "Codex",
  grok: "Grok",
  cursor: "Cursor",
}

const locks = new Map<string, Promise<unknown>>()

function lock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve()
  const run = prev.then(fn, fn)
  locks.set(
    key,
    run.then(
      () => undefined,
      () => undefined,
    ),
  )
  return run
}

function makeId(base: string, taken: Set<string>): string {
  let id = ""
  do {
    id = `${slug(base, "item").slice(0, 24)}-${crypto.randomBytes(2).toString("hex")}`
  } while (taken.has(id))
  return id
}

function asLines(value: unknown, max: number, label: string): string[] {
  const source = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/\n/)
      : []
  const lines = source.map((item) => String(item).trim()).filter(Boolean)
  if (lines.length > max) throw new BoardError(`Use at most ${max} ${label}.`, 400)
  for (const line of lines) {
    if (line.length > 240) throw new BoardError(`Each ${label} must be 240 characters or fewer.`, 400)
  }
  return lines
}

function agentLabel(agent: string): string {
  return AGENTS[agent] ?? agent
}

function actionFor(fork: ForkRecord): Action {
  if (fork.status === "shipped") return "shipped"
  if (fork.status === "parked") return "parked"
  if (fork.status === "superseded") return "superseded"
  if (fork.merge.state === "conflict") return "rerun"
  if (fork.digest.waiting) return "wait"
  if (fork.digest.satisfies === "no") return "ship-anyway"
  return "ship"
}

const ACTION_RANK: Record<Action, number> = {
  rerun: 0,
  ship: 1,
  "ship-anyway": 2,
  wait: 3,
  parked: 4,
  shipped: 5,
  superseded: 6,
}

export type ForkView = {
  id: string
  projectId: string
  agent: string
  agentLabel: string
  task: string
  constraints: string[]
  acceptance: string
  paths: string[]
  status: ForkRecord["status"]
  action: Action
  hasAgent: boolean
  head: string
  digest: ForkRecord["digest"]
  merge: ForkRecord["merge"]
  previewUrl: string
  createdAt: string
  supersededBy: string | null
  parentForkId: string | null
}

export type ProjectView = {
  id: string
  name: string
  description: string
  createdAt: string
  mainSha: string
  mainShort: string
  previewUrl: string
  open: number
  conflict: number
  shipped: number
}

export type BoardView = {
  project: ProjectView
  counts: { open: number; conflict: number; shipped: number; parked: number }
  forks: ForkView[]
}

function contentType(file: string): string {
  const ext = path.extname(file).toLowerCase()
  const types: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".svg": "image/svg+xml",
    ".json": "application/json; charset=utf-8",
    ".txt": "text/plain; charset=utf-8",
    ".md": "text/plain; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
  }
  return types[ext] ?? "application/octet-stream"
}

export class BoardService {
  private constructor(
    private dataDir: string,
    private store: Store,
  ) {}

  static async open(dataDir: string): Promise<BoardService> {
    await fs.mkdir(path.join(dataDir, "repos"), { recursive: true })
    const store = new Store(path.join(dataDir, "store.json"))
    await store.load()
    return new BoardService(dataDir, store)
  }

  private repoDir(id: string): string {
    return path.join(this.dataDir, "repos", id)
  }

  private repo(project: ProjectRecord): Repo {
    return new Repo(this.repoDir(project.id))
  }

  private mustProject(id: string): ProjectRecord {
    if (!isId(id)) throw new BoardError("No project with that id.", 404)
    const project = this.store.projects.find((item) => item.id === id)
    if (!project) throw new BoardError("No project with that id.", 404)
    return project
  }

  private mustFork(id: string): ForkRecord {
    if (!isId(id)) throw new BoardError("No fork with that id.", 404)
    const fork = this.store.forks.find((item) => item.id === id)
    if (!fork) throw new BoardError("No fork with that id.", 404)
    return fork
  }

  private viewFork(fork: ForkRecord): ForkView {
    return {
      id: fork.id,
      projectId: fork.projectId,
      agent: fork.agent,
      agentLabel: agentLabel(fork.agent),
      task: fork.brief.task,
      constraints: fork.brief.constraints,
      acceptance: fork.brief.acceptance,
      paths: fork.brief.paths,
      status: fork.status,
      action: actionFor(fork),
      hasAgent: Boolean(fork.replay),
      head: fork.headSha.slice(0, 7),
      digest: fork.digest,
      merge: fork.merge,
      previewUrl: `/preview/${fork.projectId}/${fork.id}/site/index.html`,
      createdAt: fork.createdAt,
      supersededBy: fork.supersededBy,
      parentForkId: fork.parentForkId,
    }
  }

  private viewProject(project: ProjectRecord): ProjectView {
    const forks = this.store.forks.filter((fork) => fork.projectId === project.id)
    return {
      id: project.id,
      name: project.name,
      description: project.description,
      createdAt: project.createdAt,
      mainSha: project.mainSha,
      mainShort: project.mainSha.slice(0, 7),
      previewUrl: `/preview/${project.id}/main/site/index.html`,
      open: forks.filter((fork) => fork.status === "open").length,
      conflict: forks.filter((fork) => fork.status === "open" && fork.merge.state === "conflict").length,
      shipped: forks.filter((fork) => fork.status === "shipped").length,
    }
  }

  listProjects(): ProjectView[] {
    return [...this.store.projects]
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .map((project) => this.viewProject(project))
  }

  async getBoard(projectId: string): Promise<BoardView> {
    return lock(`project:${projectId}`, async () => {
      const project = this.mustProject(projectId)
      const repo = this.repo(project)
      project.mainSha = await repo.head(null)
      await this.reassessOpen(project, repo)
      await this.store.save()
      return this.board(project)
    })
  }

  private board(project: ProjectRecord): BoardView {
    const forks = this.store.forks
      .filter((fork) => fork.projectId === project.id)
      .map((fork) => this.viewFork(fork))
      .sort((a, b) => {
        const rank = ACTION_RANK[a.action] - ACTION_RANK[b.action]
        if (rank !== 0) return rank
        return a.createdAt < b.createdAt ? 1 : -1
      })
    const view = this.viewProject(project)
    return {
      project: view,
      counts: {
        open: view.open,
        conflict: view.conflict,
        shipped: view.shipped,
        parked: forks.filter((fork) => fork.action === "parked").length,
      },
      forks,
    }
  }

  async createProject(input: { name?: unknown; description?: unknown; seed?: "starter" | "northline" }): Promise<ProjectView> {
    return lock("projects", async () => {
      const name = typeof input.name === "string" ? input.name.trim() : ""
      if (!name || name.length > 60) throw new BoardError("Name the project in 60 characters or fewer.", 400)
      const description = typeof input.description === "string" ? input.description.trim() : ""
      if (description.length > 280) throw new BoardError("Keep the description under 280 characters.", 400)
      const id = makeId(name, new Set(this.store.projects.map((project) => project.id)))
      const seed = input.seed === "northline" ? "northline" : "starter"
      const files = seed === "northline" ? northlineFiles() : starterFiles(name, description)
      const dir = this.repoDir(id)
      try {
        const repo = await Repo.init(dir, files)
        const project: ProjectRecord = {
          id,
          name,
          description,
          createdAt: new Date().toISOString(),
          mainSha: await repo.head(null),
          seed,
        }
        this.store.projects.push(project)
        await this.store.save()
        return this.viewProject(project)
      } catch (error) {
        await fs.rm(dir, { recursive: true, force: true })
        throw error
      }
    })
  }

  async createFork(projectId: string, input: ForkInput, replay: ReplayId | null = null): Promise<BoardView> {
    return lock(`project:${projectId}`, async () => {
      await this.createForkUnlocked(projectId, input, replay)
      return this.board(this.mustProject(projectId))
    })
  }

  private async createForkUnlocked(projectId: string, input: ForkInput, replay: ReplayId | null): Promise<ForkRecord> {
    const project = this.mustProject(projectId)
    const task = typeof input.task === "string" ? input.task.trim() : ""
    if (!task || task.length > 240) throw new BoardError("Write the task in 240 characters or fewer.", 400)
    const acceptance = typeof input.acceptance === "string" ? input.acceptance.trim() : ""
    if (acceptance.length > 2000) throw new BoardError("Keep the acceptance check under 2000 characters.", 400)
    const constraints = asLines(input.constraints, 12, "constraints")
    const paths = asLines(input.paths, 20, "paths").map((item) => assertSafeRel(item))
    if (paths.length === 0) throw new BoardError("Name at least one path the agent may touch.", 400)
    const agent = normalizeAgent(input.agent)
    const brief: Brief = { task, constraints, acceptance, paths }
    const id = makeId(task, new Set(this.store.forks.map((fork) => fork.id)))
    const repo = this.repo(project)
    const baseSha = await repo.head(null)
    await repo.addFork(id)
    const now = new Date().toISOString()
    const fork: ForkRecord = {
      id,
      projectId: project.id,
      agent,
      brief,
      replay,
      status: "open",
      createdAt: now,
      updatedAt: now,
      headSha: baseSha,
      baseSha,
      digest: emptyDigest(),
      merge: { state: "clean", paths: [], checkedAt: now },
      supersededBy: null,
      parentForkId: null,
    }
    await repo.commitFiles(
      id,
      { [`.shipboard/briefs/${id}.json`]: `${JSON.stringify({ ...brief, agent }, null, 2)}\n` },
      `brief: ${oneLine(task, "task")}`,
    )
    await this.assess(repo, fork)
    this.store.forks.push(fork)
    await this.store.save()
    return fork
  }

  async pushFiles(forkId: string, input: ForkInput): Promise<BoardView> {
    return lock(`project:${this.mustFork(forkId).projectId}`, async () => {
      const fork = this.mustFork(forkId)
      if (fork.status !== "open") throw new BoardError("This fork is not open.", 409)
      if (!Array.isArray(input.files) || input.files.length === 0) {
        throw new BoardError("Add at least one file.", 400)
      }
      if (input.files.length > 20) throw new BoardError("Push 20 files or fewer at a time.", 400)
      const files: Record<string, string> = {}
      for (const file of input.files) {
        if (!file || typeof file !== "object") throw new BoardError("Each file needs a path and content.", 400)
        const record = file as { path?: unknown; content?: unknown }
        if (typeof record.content !== "string") throw new BoardError("Each file needs text content.", 400)
        if (record.content.length > 200_000) throw new BoardError("Each file must be 200 KB or smaller.", 400)
        files[assertSafeRel(record.path)] = record.content
      }
      const message = oneLine(typeof input.message === "string" ? input.message : fork.brief.task)
      const project = this.mustProject(fork.projectId)
      const repo = this.repo(project)
      await repo.commitFiles(fork.id, files, `agent: ${message}`)
      await this.assess(repo, fork)
      await this.store.save()
      return this.board(project)
    })
  }

  async runAgent(forkId: string): Promise<{ changed: boolean; board: BoardView }> {
    const fork = this.mustFork(forkId)
    return lock(`project:${fork.projectId}`, () => this.runAgentUnlocked(forkId))
  }

  private async runAgentUnlocked(forkId: string): Promise<{ changed: boolean; board: BoardView }> {
    const fork = this.mustFork(forkId)
    if (fork.status !== "open") throw new BoardError("This fork is not open.", 409)
    if (!fork.replay || !isReplay(fork.replay)) {
      throw new BoardError("No local agent is attached to this fork.", 400)
    }
    const project = this.mustProject(fork.projectId)
    const repo = this.repo(project)
    await runReplay(fork.replay, repo.worktree(fork.id))
    const changed = await repo.commitAll(fork.id, `agent: ${oneLine(fork.brief.task)}`)
    await this.assess(repo, fork)
    await this.store.save()
    return { changed, board: this.board(project) }
  }

  async ship(forkId: string): Promise<BoardView> {
    const fork = this.mustFork(forkId)
    return lock(`project:${fork.projectId}`, async () => {
      const current = this.mustFork(forkId)
      if (current.status !== "open") throw new BoardError("This fork is not open.", 409)
      const project = this.mustProject(current.projectId)
      const repo = this.repo(project)
      await this.assess(repo, current)
      if (current.digest.waiting) throw new BoardError("Nothing has been pushed yet.", 409)
      if (current.merge.state !== "clean") {
        throw new BoardError("This fork conflicts with main. Re-run the agent instead of merging.", 409)
      }
      await repo.ship(current.id, `ship: ${oneLine(current.brief.task)}`)
      current.status = "shipped"
      current.updatedAt = new Date().toISOString()
      project.mainSha = await repo.head(null)
      await this.reassessOpen(project, repo)
      await this.store.save()
      return this.board(project)
    })
  }

  async park(forkId: string): Promise<BoardView> {
    const fork = this.mustFork(forkId)
    return lock(`project:${fork.projectId}`, async () => {
      const current = this.mustFork(forkId)
      if (current.status !== "open") throw new BoardError("Only an open fork can be parked.", 409)
      current.status = "parked"
      current.updatedAt = new Date().toISOString()
      const project = this.mustProject(current.projectId)
      await this.store.save()
      return this.board(project)
    })
  }

  async returnToBoard(forkId: string): Promise<BoardView> {
    const fork = this.mustFork(forkId)
    return lock(`project:${fork.projectId}`, async () => {
      const current = this.mustFork(forkId)
      if (current.status !== "parked") throw new BoardError("This fork is not parked.", 409)
      current.status = "open"
      const project = this.mustProject(current.projectId)
      const repo = this.repo(project)
      await this.assess(repo, current)
      await this.store.save()
      return this.board(project)
    })
  }

  async rerun(forkId: string): Promise<{ notice: string; board: BoardView }> {
    const fork = this.mustFork(forkId)
    return lock(`project:${fork.projectId}`, async () => {
      const current = this.mustFork(forkId)
      if (current.status !== "open") throw new BoardError("Only an open fork can be re-run.", 409)
      const project = this.mustProject(current.projectId)
      const replay = current.replay && isReplay(current.replay) ? current.replay : null
      const fresh = await this.createForkUnlocked(
        project.id,
        {
          task: current.brief.task,
          constraints: current.brief.constraints,
          acceptance: current.brief.acceptance,
          paths: current.brief.paths,
          agent: current.agent,
        },
        replay,
      )
      fresh.parentForkId = current.id
      let notice = "Copied the brief onto current main. Waiting for the agent to push."
      if (replay) {
        const run = await this.runAgentUnlocked(fresh.id)
        notice = run.changed
          ? "Re-ran on current main. The agent pushed."
          : "Re-ran on current main. The agent had nothing new to push."
      }
      current.status = "superseded"
      current.supersededBy = fresh.id
      current.updatedAt = new Date().toISOString()
      await this.store.save()
      return { notice, board: this.board(project) }
    })
  }

  async diff(forkId: string): Promise<{ diff: string; truncated: boolean }> {
    const fork = this.mustFork(forkId)
    const project = this.mustProject(fork.projectId)
    const text = await this.repo(project).diff(fork.id)
    const limit = 80_000
    if (text.length <= limit) return { diff: text, truncated: false }
    return { diff: text.slice(0, limit), truncated: true }
  }

  async readPreview(projectId: string, ref: string, relPath: string): Promise<{ body: Buffer; type: string }> {
    const project = this.mustProject(projectId)
    const repo = this.repo(project)
    let forkId: string | null = null
    if (ref !== "main") {
      const fork = this.mustFork(ref)
      if (fork.projectId !== project.id) throw new BoardError("No preview for that fork.", 404)
      forkId = fork.id
    }
    const requested = relPath === "" ? "site/index.html" : assertSafeRel(relPath)
    return this.readInside(repo.worktree(forkId), requested)
  }

  private async readInside(root: string, rel: string): Promise<{ body: Buffer; type: string }> {
    const realRoot = await fs.realpath(root)
    const full = path.resolve(realRoot, rel)
    if (!isInside(realRoot, full)) throw new BoardError("Not found.", 404)
    let real: string
    try {
      real = await fs.realpath(full)
    } catch {
      throw new BoardError("Not found.", 404)
    }
    if (!isInside(realRoot, real)) throw new BoardError("Not found.", 404)
    const stat = await fs.stat(real)
    if (stat.isDirectory()) {
      return this.readInside(root, path.posix.join(rel, "index.html"))
    }
    const body = await fs.readFile(real)
    return { body, type: contentType(real) }
  }

  async runPierDemo(): Promise<BoardView> {
    const project = await this.createProject({
      name: "Harbor notes",
      description: "Three agents, one notice. Ship what merges. When one conflicts, re-run it on current main.",
      seed: "northline",
    })
    for (const spec of PIER) {
      await this.createFork(
        project.id,
        {
          task: spec.task,
          constraints: spec.constraints,
          acceptance: spec.acceptance,
          paths: spec.paths,
          agent: spec.agent,
        },
        spec.replay,
      )
      const fork = [...this.store.forks].reverse().find((item) => item.projectId === project.id && item.replay === spec.replay)
      if (!fork) throw new BoardError("The demo fork was not created.", 500)
      await this.runAgent(fork.id)
    }
    return this.getBoard(project.id)
  }

  private async reassessOpen(project: ProjectRecord, repo: Repo): Promise<void> {
    for (const fork of this.store.forks) {
      if (fork.projectId !== project.id) continue
      if (fork.status !== "open" && fork.status !== "parked") continue
      await this.assess(repo, fork)
    }
  }

  private async assess(repo: Repo, fork: ForkRecord): Promise<void> {
    const files = await repo.numstat(fork.id)
    const defined = parseChecks(fork.brief.acceptance)
    const checks = []
    for (const check of defined) {
      let body: string | null = null
      try {
        body = await repo.readFile(fork.id, check.path)
      } catch (error) {
        if (!(error instanceof BoardError)) throw error
        body = null
      }
      checks.push({ ...check, ok: body !== null && body.includes(check.text) })
    }
    fork.digest = buildDigest({ brief: fork.brief, files, checks })
    let merged: { state: "clean" | "conflict"; paths: string[] }
    try {
      merged = await trialMerge(repo.dir, "main", `fork/${fork.id}`)
    } catch (error) {
      const message = error instanceof Error ? error.message : "Trial-merge failed."
      throw new BoardError(message, 500)
    }
    fork.merge = { ...merged, checkedAt: new Date().toISOString() }
    fork.headSha = await repo.head(fork.id)
    fork.updatedAt = new Date().toISOString()
  }
}

function normalizeAgent(value: unknown): string {
  const raw = typeof value === "string" ? value.trim() : ""
  const agent = (raw || "cursor").slice(0, 40)
  if (!/^[a-zA-Z0-9][a-zA-Z0-9 ._-]*$/.test(agent)) {
    throw new BoardError("Agent names use letters, numbers, spaces, dots, or dashes.", 400)
  }
  const key = agent.toLowerCase()
  return AGENTS[key] ? key : agent
}

function emptyDigest(): ForkRecord["digest"] {
  return {
    summary: "",
    satisfies: "unchecked",
    reasons: [],
    files: [],
    unexpectedPaths: [],
    missedPaths: [],
    waiting: true,
  }
}
