/**
 * CloudflareHost: the Host the shared API runs on in the Worker. Projects are ProjectDO instances
 * named by project id; the RegistryDO singleton knows which ids exist and when runners last polled.
 * Built per request from `env`; it holds no state of its own.
 */

import { defaultAgents } from "../core/agents.ts"
import { validateCreateProject } from "../core/inputs.ts"
import { isProjectId, newProjectId } from "../core/names.ts"
import { PortError } from "../core/ports.ts"
import type { Clock, Host, Logger, ProjectHandle } from "../core/ports.ts"
import type { AgentInfo, CreateProjectInput, ProjectSummary } from "../core/types.ts"
import type { Env } from "./env.ts"
import { REGISTRY_NAME, namespaceOf, workerLog } from "./env.ts"
import type { RegistryEntry, RegistryRpc } from "./registry-do.ts"
import { ProjectClient } from "./rpc.ts"
import type { ProjectRpc } from "./rpc.ts"

/** Most projects the board lists (and the runner claim fans out over). Newest first. */
export const LIST_LIMIT = 100
const CREATE_TRIES = 5

type Namespace = Pick<DurableObjectNamespace, "idFromName" | "get">

/** The stub for one project, typed as what ProjectDO actually exposes over RPC. */
export function projectStub(ns: Namespace, projectId: string): ProjectRpc {
  return ns.get(ns.idFromName(projectId)) as unknown as ProjectRpc
}

export function registryStub(ns: Namespace): RegistryRpc {
  return ns.get(ns.idFromName(REGISTRY_NAME)) as unknown as RegistryRpc
}

export type CloudflareHostEnv = Pick<
  Env,
  "PROJECT" | "REGISTRY" | "BOARD_TOKEN" | "RUNNER_TOKEN" | "PUBLIC_READ" | "ARTIFACTS_NAMESPACE"
>

export class CloudflareHost implements Host {
  readonly mode = "cloudflare" as const
  readonly namespace: string
  readonly boardToken?: string
  readonly runnerToken?: string
  readonly publicRead: boolean
  private readonly registry: RegistryRpc
  private readonly clock: Clock
  private readonly log: Logger

  constructor(
    private readonly env: CloudflareHostEnv,
    opts: { clock?: Clock; log?: Logger } = {},
  ) {
    this.namespace = namespaceOf(env)
    this.boardToken = env.BOARD_TOKEN?.trim() || undefined
    this.runnerToken = env.RUNNER_TOKEN?.trim() || undefined
    this.publicRead = (env.PUBLIC_READ ?? "").trim().toLowerCase() !== "false"
    this.registry = registryStub(env.REGISTRY)
    this.clock = opts.clock ?? { now: () => new Date() }
    this.log = opts.log ?? workerLog
  }

  async agents(): Promise<AgentInfo[]> {
    const agents = defaultAgents()
    let seen: Awaited<ReturnType<RegistryRpc["runners"]>> = []
    try {
      seen = await this.registry.runners()
    } catch (err) {
      this.log.warn("runner last-seen unavailable", { error: String(err) })
    }
    for (const agent of agents) {
      if (agent.kind !== "cli") continue
      const latest = seen.filter((row) => row.agent === agent.id).map((row) => row.at).sort().pop()
      if (latest) agent.lastSeenAt = latest
    }
    return agents
  }

  async noteRunner(runnerId: string, agents: string[]): Promise<void> {
    await this.registry.noteRunner(runnerId, agents, this.clock.now().toISOString())
  }

  async listProjects(): Promise<ProjectSummary[]> {
    const entries = (await this.registry.list()).slice(0, LIST_LIMIT)
    const summaries = await Promise.all(entries.map((entry) => this.summaryOf(entry)))
    return summaries
      .filter((summary): summary is ProjectSummary => summary !== null)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
  }

  async createProject(input: CreateProjectInput): Promise<ProjectSummary> {
    const fields = validateCreateProject(input)
    for (let tries = 1; tries <= CREATE_TRIES; tries++) {
      const id = newProjectId(fields.name)
      if (await this.registry.has(id)) continue
      // Listed before init so a crash mid-create leaves a visible id, not an orphaned repo; a failed init unlists it.
      await this.registry.add({ id, name: fields.name, createdAt: this.clock.now().toISOString() })
      try {
        const summary = await this.client(id).init({ ...input, id })
        await this.registry.add({ id, name: summary.name, createdAt: summary.createdAt })
        return summary
      } catch (err) {
        await this.registry.remove(id).catch(() => false)
        // "exists": the random suffix collided with a repo or project. Pick another id.
        if (err instanceof PortError && err.code === "exists" && tries < CREATE_TRIES) continue
        throw err
      }
    }
    throw new PortError("Could not find a free project id. Try another name.", 409, "exists")
  }

  async project(projectId: string): Promise<ProjectHandle> {
    if (!isProjectId(projectId)) throw new PortError("No project with that id.", 404, "not_found")
    // No registry round trip: a ProjectDO with no stored state answers 404 itself.
    return this.client(projectId)
  }

  private client(projectId: string): ProjectClient {
    return new ProjectClient(projectStub(this.env.PROJECT, projectId))
  }

  private async summaryOf(entry: RegistryEntry): Promise<ProjectSummary | null> {
    try {
      return await this.client(entry.id).summary()
    } catch (err) {
      if (!(err instanceof PortError && err.status === 404)) {
        this.log.warn("project unreadable", { project: entry.id, error: err instanceof Error ? err.message : String(err) })
      }
      return null
    }
  }
}
