/**
 * Shipboard data model. Platform-neutral: no node:* or cloudflare:* imports anywhere in src/core.
 *
 * Vocabulary
 * - Project: one Artifacts repo (`<projectId>`) whose `main` is what ships.
 * - Brief: the task. Committed byte-for-byte as the first commit of every fork made for it, at
 *   `.shipboard/briefs/<briefId>.json`. Stable across re-runs.
 * - Attempt: one fork of main made for a brief (`<attemptId>` is also the fork's repo name).
 *   A re-run discards the attempt's diff and makes a new attempt from current main with the same brief.
 * - Job: the dispatch of one attempt to one agent. Keyed by attemptId (one job per attempt).
 */

export type AgentKind = "cli" | "demo" | "manual"

/** Who does the work for an attempt. `demo` runs scripted edits server-side; `manual` means an agent self-serves with the CLI. */
export type AgentInfo = {
  id: string
  label: string
  kind: AgentKind
  /** For `cli` agents: when a runner offering this agent last called claim. Absent = never seen. */
  lastSeenAt?: string
}

export type Brief = {
  id: string
  task: string
  constraints: string[]
  /** Free text. Lines of the form `contains <path> "<text>"` are machine-checked. */
  acceptance: string
  /** Paths the agent is expected to touch. Repo-relative, forward slashes. */
  paths: string[]
  createdAt: string
  /** Scripted edit id for the built-in demo agent. Only set on seeded demo briefs. */
  demo?: string
}

export type FileStat = {
  path: string
  status: "added" | "modified" | "deleted"
  additions: number
  deletions: number
}

export type CheckResult = {
  path: string
  text: string
  ok: boolean
}

export type Digest = {
  /** One sentence for the card. */
  summary: string
  /** Machine verdict against the brief. `unchecked` when there is nothing machine-readable to check. */
  satisfies: "yes" | "no" | "unchecked"
  reasons: string[]
  files: FileStat[]
  checks: CheckResult[]
  /** Product files touched that the brief did not list. */
  unexpectedPaths: string[]
  /** Brief paths that were not touched. */
  missedPaths: string[]
  /** Changes under .shipboard/ other than this brief's own file. Always a red flag. */
  controlPaths: string[]
  /** The sha this digest describes. */
  headSha: string
  baseSha: string
}

export type MergeReport = {
  state: "clean" | "conflict"
  /** Conflicting paths (empty when clean). */
  paths: string[]
  /** Main sha the trial merge was run against. */
  mainSha: string
  headSha: string
  checkedAt: string
}

/** Optional LLM read of the diff against the brief. */
export type Review = {
  verdict: "satisfies" | "partial" | "off-brief"
  note: string
  model: string
  headSha: string
  at: string
}

export type AttemptStatus =
  /** Fork exists with only the brief commit. A job may be queued or running. */
  | "waiting"
  /** The agent pushed; digest and trial-merge describe the head. */
  | "ready"
  | "shipped"
  | "parked"
  /** Replaced by a re-run. Its diff is never merged. */
  | "discarded"
  /** The agent finished without pushing anything usable. */
  | "failed"

export type JobState = "queued" | "running" | "done" | "failed"

export type JobOutcomeReason =
  | "pushed"
  | "no_changes"
  | "agent_error"
  | "timeout"
  | "auth"
  | "brief_mismatch"
  | "unsafe_repo_config"
  | "push_rejected"
  | "lease_expired"

export type JobOutcome = {
  reason: JobOutcomeReason
  summary: string
  commitSha?: string
  changedPaths?: string[]
  costUsd?: number
  turns?: number
  sessionId?: string
  durationMs?: number
}

export type Job = {
  attemptId: string
  agent: string
  state: JobState
  queuedAt: string
  runnerId?: string
  claimedAt?: string
  leaseExpiresAt?: string
  finishedAt?: string
  outcome?: JobOutcome
  /** How many times an expired lease put this job back in the queue (capped, see core/state.ts). */
  requeues?: number
}

export type Attempt = {
  id: string
  briefId: string
  /** 1 for the first fork of a brief, 2 for its first re-run, and so on. */
  number: number
  agent: string
  status: AttemptStatus
  /** Fork repo name in the Artifacts namespace. Equal to `id`. */
  repo: string
  /** Main sha the fork was cut from. */
  baseSha: string
  /** Sha of the brief commit (first commit on the fork after baseSha). */
  briefSha: string
  /** Latest known head of the fork's main branch. */
  headSha: string
  createdAt: string
  updatedAt: string
  digest: Digest | null
  merge: MergeReport | null
  review: Review | null
  /** Attempt that replaced this one (set when discarded). */
  replacedBy: string | null
  /** Attempt this one replaced (set on re-runs). */
  replaces: string | null
  /** Why it was discarded, in one sentence. */
  discardReason: string | null
  /** Main sha after this attempt shipped. */
  shippedSha: string | null
}

export type ActivityKind =
  | "project"
  | "dispatched"
  | "claimed"
  | "pushed"
  | "assessed"
  | "conflict"
  | "shipped"
  | "rerun"
  | "parked"
  | "unparked"
  | "failed"

export type Activity = {
  at: string
  kind: ActivityKind
  text: string
  briefId?: string
  attemptId?: string
  agent?: string
}

export type Project = {
  id: string
  name: string
  description: string
  createdAt: string
  /** Repo name of main in the Artifacts namespace. Equal to `id`. */
  repo: string
  mainSha: string
  seed: "starter" | "harbor" | "import"
}

/** Everything one project owns. Persisted as one document per project. */
export type ProjectState = {
  schema: 1
  /** Bumped on every mutation. Lets the board poll cheaply. */
  version: number
  project: Project
  briefs: Brief[]
  attempts: Attempt[]
  jobs: Job[]
  /** Newest last. Capped (see core/state.ts). */
  activity: Activity[]
  /** Epoch ms of the last remote head reconciliation. */
  reconciledAt: number
}

// ---------------------------------------------------------------- view models (HTTP responses)

export type Action = "ship" | "ship-anyway" | "rerun" | "park" | "unpark" | "wait" | "none"

export type Lane = "rerun" | "ship" | "review" | "working" | "parked" | "shipped"

export type JobView = Job & { agentLabel: string }

export type AttemptView = {
  id: string
  briefId: string
  number: number
  agent: string
  agentLabel: string
  agentKind: AgentKind
  status: AttemptStatus
  repo: string
  baseSha: string
  briefSha: string
  headSha: string
  createdAt: string
  updatedAt: string
  job: JobView | null
  digest: Digest | null
  merge: MergeReport | null
  review: Review | null
  replacedBy: string | null
  replaces: string | null
  discardReason: string | null
  shippedSha: string | null
  /** `/preview/<projectId>/<attemptId>/` or null before the agent pushed. */
  previewUrl: string | null
  /** The one button. */
  primary: Action
  /** Smaller actions offered next to it. */
  secondary: Action[]
}

export type TaskView = {
  brief: Brief
  lane: Lane
  /** The live attempt (newest non-discarded). */
  current: AttemptView
  /** Earlier attempts for this brief, newest first. Discarded or failed. */
  history: AttemptView[]
}

export type ProjectSummary = {
  id: string
  name: string
  description: string
  createdAt: string
  mainSha: string
  counts: Record<Lane, number>
}

export type BoardView = {
  version: number
  project: ProjectSummary & { repo: string; seed: Project["seed"]; previewUrl: string }
  /** Lane order is fixed: rerun, ship, review, working, parked, shipped. */
  lanes: { lane: Lane; tasks: TaskView[] }[]
  activity: Activity[]
  agents: AgentInfo[]
}

/** What a runner gets when it claims a job. Tokens are never part of a claim. */
export type ClaimedJob = {
  attemptId: string
  projectId: string
  agent: string
  brief: Brief
  /** Path of the brief file inside the repo. */
  briefPath: string
  baseSha: string
  briefSha: string
  remote: string
  leaseExpiresAt: string
  /** 1 for first runs; >1 means this is a re-run on a newer main. */
  attemptNumber: number
  /** For re-runs: why the previous attempt was discarded. Context only; the brief is unchanged. */
  previous?: { attemptId: string; reason: string | null }
}

export type GitCredentials = {
  remote: string
  /** Full Artifacts token string: `art_v1_<hex>?expires=<unix>` */
  token: string
  expiresAt: string
  scope: "read" | "write"
}

export type DispatchInput = {
  task: string
  constraints?: string[] | string
  acceptance?: string
  paths: string[] | string
  agent: string
}

export type CreateProjectInput = {
  name: string
  description?: string
  seed?: "starter" | "harbor"
  /** Public https git URL to import as main instead of a seed. */
  importUrl?: string
}
