/**
 * Ports: what the core needs from a platform. Two implementations exist:
 * - src/local:      bare git repos on disk served by `git http-backend`, JSON files for state.
 * - src/cloudflare: the Artifacts Workers binding, Durable Object storage, Workers AI.
 *
 * All git object work (brief commits, digests, trial merges, ship merges) happens in core with
 * isomorphic-git over smart HTTP against `remote` URLs, so both platforms run the same code.
 */

import type {
  AgentInfo,
  Brief,
  ClaimedJob,
  CreateProjectInput,
  DispatchInput,
  FileStat,
  GitCredentials,
  JobOutcome,
  ProjectState,
  ProjectSummary,
  Review,
  BoardView,
} from "./types.ts"

export type RepoInfo = {
  name: string
  /** Smart-HTTP remote URL, no credentials in it. */
  remote: string
  defaultBranch: string
}

/** Subset of the Artifacts binding the core uses. Names are repo names inside one namespace. */
export interface ArtifactsPort {
  /** Create an empty repo. Throws `PortError("exists")` if the name is taken. */
  create(name: string, opts?: { description?: string }): Promise<RepoInfo>
  /** Import a public https git URL as a new repo (default branch only). */
  import(url: string, name: string): Promise<RepoInfo>
  /** Fork `source` (default branch only) into a new repo `target`. Resolves once the fork is usable. */
  fork(source: string, target: string, opts?: { description?: string }): Promise<RepoInfo>
  info(name: string): Promise<RepoInfo | null>
  /** Mint a repo-scoped token. `token` is the full string including `?expires=`. */
  token(name: string, scope: "read" | "write", ttlSeconds: number): Promise<GitCredentials>
  /** Sha of `refs/heads/<branch>` or null when the repo or branch does not exist. */
  head(name: string, branch?: string): Promise<string | null>
  /** File bytes at a commit-ish, or null when missing or a directory. */
  readFile(name: string, ref: string, path: string): Promise<Uint8Array | null>
  delete(name: string): Promise<boolean>
}

/** Persistence for one project's document. Implementations must make `save` atomic. */
export interface StatePort {
  load(): Promise<ProjectState | null>
  save(state: ProjectState): Promise<void>
}

/** Optional LLM reviewer. Returns null when it cannot give a verdict; never throws. */
export interface ReviewerPort {
  review(input: { brief: Brief; files: FileStat[]; diff: string; headSha: string }): Promise<Review | null>
}

export interface Clock {
  now(): Date
}

export interface Logger {
  info(message: string, data?: Record<string, unknown>): void
  warn(message: string, data?: Record<string, unknown>): void
  error(message: string, data?: Record<string, unknown>): void
}

export type CorePorts = {
  artifacts: ArtifactsPort
  state: StatePort
  reviewer?: ReviewerPort
  clock?: Clock
  log?: Logger
  /** isomorphic-git HttpClient. Defaults to `isomorphic-git/http/web` (fetch). */
  http?: unknown
}

/** Thrown by ports and core for expected failures. `status` is the HTTP status the API returns. */
export class PortError extends Error {
  constructor(
    message: string,
    readonly status: number = 400,
    readonly code: string = "bad_request",
  ) {
    super(message)
    this.name = "PortError"
  }
}

/**
 * One project's operations. In local mode this is the core ProjectService itself; on Cloudflare it
 * is a Durable Object stub exposing the same methods over RPC. Every method returns plain JSON.
 */
export interface ProjectHandle {
  init(input: CreateProjectInput & { id: string }): Promise<ProjectSummary>
  summary(): Promise<ProjectSummary>
  /** Reconciles remote heads first when the last reconcile is older than ~10 s. */
  board(opts?: { reconcile?: boolean }): Promise<BoardView>
  version(): Promise<number>
  dispatch(input: DispatchInput, opts?: { withCredentials?: boolean }): Promise<{
    board: BoardView
    attemptId: string
    /** Only for `manual` agents when the caller asked for credentials: a write token for the fork. */
    credentials?: GitCredentials
  }>
  /** Explicit "I pushed" signal from a runner or CLI. Idempotent. */
  pushed(attemptId: string, sha?: string): Promise<BoardView>
  /** Artifacts push event (Workflow trigger). Idempotent per (repo, after). */
  onPushEvent(event: { repo: string; ref: string; after: string }): Promise<void>
  ship(attemptId: string, expectedHead?: string): Promise<BoardView>
  park(attemptId: string): Promise<BoardView>
  unpark(attemptId: string): Promise<BoardView>
  rerun(attemptId: string, agent?: string): Promise<{ board: BoardView; attemptId: string }>
  diff(attemptId: string): Promise<{ diff: string; truncated: boolean; base: string; head: string }>
  preview(ref: string, path: string): Promise<{ body: Uint8Array; contentType: string } | null>
  /** With `attemptId`, claims that queued job only (null if it is not claimable by `agents`). */
  claim(runnerId: string, agents: string[], opts?: { attemptId?: string }): Promise<ClaimedJob | null>
  /** `queuedAt` of the oldest job `claim` would hand out for these agents, or null. Lets the claim fan-out pick the oldest job across projects. */
  nextJobAt(agents: string[]): Promise<string | null>
  heartbeat(attemptId: string, runnerId: string): Promise<{ leaseExpiresAt: string }>
  jobCredentials(attemptId: string, runnerId: string, scope: "read" | "write"): Promise<GitCredentials>
  finish(attemptId: string, runnerId: string, outcome: JobOutcome): Promise<BoardView>
  /** Runs queued `demo` jobs server-side. Returns how many ran. */
  runDemoJobs(): Promise<number>
  /** Expire leases, reconcile heads. Called by a DO alarm or a local timer. */
  tick(): Promise<void>
}

/**
 * The core implementation. `src/core/service.ts` exports:
 *
 *   export class ProjectService implements ProjectHandle {
 *     constructor(projectId: string, ports: CorePorts, options: ProjectServiceOptions)
 *   }
 *
 * Hosts construct one per project (local: cached in a Map; Cloudflare: one per ProjectDO instance).
 */
export type ProjectServiceOptions = {
  /** Agents a brief may be dispatched to. Unknown agent ids are rejected. */
  agents: AgentInfo[]
  /** Called after a mutation that queued `demo` jobs; the host runs `runDemoJobs()` off the request path. */
  schedule?: (work: () => Promise<unknown>) => void
}

/** The set of projects. Implemented by a registry DO on Cloudflare and a JSON index locally. */
export interface Host {
  mode: "local" | "cloudflare"
  /** Artifacts namespace the host works in ("local" for the local host). */
  namespace: string
  /** Known agents, with `lastSeenAt` filled from runner claims. */
  agents(): Promise<AgentInfo[]>
  /** Record that a runner offering these agents just polled. */
  noteRunner(runnerId: string, agents: string[]): Promise<void>
  listProjects(): Promise<ProjectSummary[]>
  createProject(input: CreateProjectInput): Promise<ProjectSummary>
  /** Throws PortError 404 for unknown ids. */
  project(projectId: string): Promise<ProjectHandle>
  /** Bearer secrets. Undefined means "no token configured" (see docs/ARCHITECTURE.md, Auth). */
  boardToken?: string
  runnerToken?: string
  publicRead: boolean
}
