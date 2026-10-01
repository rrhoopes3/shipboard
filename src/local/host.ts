/**
 * LocalHost: the Host for `npm start`. A JSON registry of project ids, one cached ProjectService
 * per project, demo work run in process, and a timer that ticks projects with live jobs.
 */

import path from "node:path"
import { defaultAgents } from "../core/agents.ts"
import { Mutex } from "../core/mutex.ts"
import { isProjectId, newProjectId, projectIdOf } from "../core/names.ts"
import { PortError } from "../core/ports.ts"
import type { Clock, Host, Logger, ProjectHandle } from "../core/ports.ts"
import { validateCreateProject } from "../core/inputs.ts"
import { ProjectService } from "../core/service.ts"
import type { AgentInfo, CreateProjectInput, ProjectSummary } from "../core/types.ts"
import { LocalArtifacts } from "./artifacts.ts"
import { JsonStateStore, Registry } from "./state.ts"

export type LocalHostOptions = {
  /** `$SHIPBOARD_DATA`: holds `git/`, `projects/` and `registry.json`. */
  dataDir: string
  /** Origin the server listens on. Can be set later with `setBaseUrl` once the port is known. */
  baseUrl?: string
  boardToken?: string
  runnerToken?: string
  /** Default true. With a board token set and this false, reads need the token too. */
  publicRead?: boolean
  agents?: AgentInfo[]
  clock?: Clock
  log?: Logger
  /** Tick interval for projects with live jobs. Default 5000 ms; 0 turns the timer off. */
  tickMs?: number
  /** Tests only: allow http:// imports from loopback. */
  allowInsecureImport?: boolean
  /** isomorphic-git HttpClient override. */
  http?: unknown
}

export const consoleLog: Logger = {
  info: (message, data) => console.log(message, data ?? ""),
  warn: (message, data) => console.warn(message, data ?? ""),
  error: (message, data) => console.error(message, data ?? ""),
}

export class LocalHost implements Host {
  readonly mode = "local" as const
  readonly namespace = "local"
  readonly boardToken?: string
  readonly runnerToken?: string
  readonly publicRead: boolean
  readonly artifacts: LocalArtifacts
  readonly dataDir: string

  private readonly registry: Registry
  private readonly services = new Map<string, ProjectService>()
  private readonly createLock = new Mutex()
  private readonly agentList: AgentInfo[]
  private readonly pending = new Set<Promise<unknown>>()
  private readonly clock: Clock
  private readonly log: Logger
  private readonly tickMs: number
  private readonly http: unknown
  private baseUrl: string
  private timer: ReturnType<typeof setInterval> | null = null
  private ticking = false

  private constructor(opts: LocalHostOptions) {
    this.dataDir = path.resolve(opts.dataDir)
    this.baseUrl = opts.baseUrl ?? "http://127.0.0.1:8787"
    this.boardToken = opts.boardToken || undefined
    this.runnerToken = opts.runnerToken || undefined
    this.publicRead = opts.publicRead ?? true
    this.clock = opts.clock ?? { now: () => new Date() }
    this.log = opts.log ?? consoleLog
    this.tickMs = opts.tickMs ?? 5000
    this.http = opts.http
    this.agentList = opts.agents ? opts.agents.map((agent) => ({ ...agent })) : defaultAgents()
    this.registry = new Registry(path.join(this.dataDir, "registry.json"))
    this.artifacts = new LocalArtifacts({
      root: path.join(this.dataDir, "git"),
      namespace: this.namespace,
      baseUrl: () => this.baseUrl,
      clock: this.clock,
      allowInsecureImport: opts.allowInsecureImport,
    })
  }

  static async open(opts: LocalHostOptions): Promise<LocalHost> {
    const host = new LocalHost(opts)
    await host.registry.load()
    return host
  }

  setBaseUrl(url: string): void {
    this.baseUrl = url.replace(/\/+$/, "")
  }

  getBaseUrl(): string {
    return this.baseUrl
  }

  // ---------------------------------------------------------------- Host

  async agents(): Promise<AgentInfo[]> {
    return this.agentList.map((agent) => ({ ...agent }))
  }

  async noteRunner(_runnerId: string, agents: string[]): Promise<void> {
    const now = this.clock.now().toISOString()
    for (const agent of this.agentList) {
      if (agent.kind === "cli" && agents.includes(agent.id)) agent.lastSeenAt = now
    }
  }

  async listProjects(): Promise<ProjectSummary[]> {
    const summaries = await Promise.all(
      this.registry.ids().map(async (id) => {
        try {
          return await this.service(id).summary()
        } catch (err) {
          this.log.warn("project unreadable", { project: id, error: String(err) })
          return null
        }
      }),
    )
    return summaries
      .filter((summary): summary is ProjectSummary => summary !== null)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
  }

  async createProject(input: CreateProjectInput): Promise<ProjectSummary> {
    const fields = validateCreateProject(input)
    return this.createLock.run(async () => {
      let id = newProjectId(fields.name)
      while (this.registry.has(id) || (await this.artifacts.info(id))) id = newProjectId(fields.name)
      const service = this.makeService(id)
      const summary = await service.init({ ...input, id })
      await this.registry.add({ id, createdAt: summary.createdAt })
      this.services.set(id, service)
      return summary
    })
  }

  async project(projectId: string): Promise<ProjectHandle> {
    if (!isProjectId(projectId) || !this.registry.has(projectId)) {
      throw new PortError("No project with that id.", 404, "not_found")
    }
    return this.service(projectId)
  }

  // ---------------------------------------------------------------- local extras

  /** Runs work off the request path and keeps track of it so `idle()` can wait for it. */
  schedule(work: () => Promise<unknown>): void {
    const run = Promise.resolve()
      .then(work)
      .catch((err: unknown) => this.log.error("background work failed", { error: err instanceof Error ? err.stack ?? err.message : String(err) }))
    this.pending.add(run)
    void run.finally(() => this.pending.delete(run))
  }

  /** Resolves once scheduled work (demo jobs, push events) has settled. */
  async idle(): Promise<void> {
    while (this.pending.size > 0) await Promise.allSettled([...this.pending])
  }

  /** Called by the git route after a push moved a repo's main. */
  onRepoPush(repo: string, after: string): void {
    const projectId = projectIdOf(repo)
    if (!isProjectId(projectId) || !this.registry.has(projectId)) return
    this.schedule(() => this.service(projectId).onPushEvent({ repo, ref: "refs/heads/main", after }))
  }

  /** One pass of the timer: tick every project that has queued or running jobs. */
  async tickAll(): Promise<void> {
    if (this.ticking) return
    this.ticking = true
    try {
      for (const id of this.registry.ids()) {
        try {
          const service = this.service(id)
          const jobs = await service.activeJobs()
          if (jobs.running > 0 || jobs.queued > 0) await service.tick()
        } catch (err) {
          this.log.warn("tick failed", { project: id, error: String(err) })
        }
      }
    } finally {
      this.ticking = false
    }
  }

  start(): void {
    if (this.timer || this.tickMs <= 0) return
    this.timer = setInterval(() => this.schedule(() => this.tickAll()), this.tickMs)
    this.timer.unref?.()
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    await this.idle()
  }

  private service(id: string): ProjectService {
    let service = this.services.get(id)
    if (!service) {
      service = this.makeService(id)
      this.services.set(id, service)
    }
    return service
  }

  private makeService(id: string): ProjectService {
    return new ProjectService(
      id,
      {
        artifacts: this.artifacts,
        state: new JsonStateStore(path.join(this.dataDir, "projects", `${id}.json`)),
        clock: this.clock,
        log: this.log,
        http: this.http,
      },
      { agents: this.agentList, schedule: (work) => this.schedule(work) },
    )
  }
}
