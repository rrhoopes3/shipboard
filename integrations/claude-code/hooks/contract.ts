// The parts of src/core/types.ts this mod reads, copied rather than imported: an installed plugin
// is copied into Claude Code's plugin cache, and a hooks module may only import files inside its
// own plugin directory (https://code.claude.com/docs/en/plugins/mods/create.md, "Import only from
// files inside the plugin directory"). test/claude-code/contract.test.ts fails to type-check if
// these drift from core.

export type AgentKind = "cli" | "demo" | "manual"

export type AgentInfo = {
  id: string
  label: string
  kind: AgentKind
  lastSeenAt?: string
}

export type Brief = {
  id: string
  task: string
  constraints: string[]
  acceptance: string
  paths: string[]
  createdAt: string
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
  summary: string
  satisfies: "yes" | "no" | "unchecked"
  reasons: string[]
  files: FileStat[]
  checks: CheckResult[]
  unexpectedPaths: string[]
  missedPaths: string[]
  controlPaths: string[]
  headSha: string
  baseSha: string
}

export type MergeReport = {
  state: "clean" | "conflict"
  paths: string[]
  mainSha: string
  headSha: string
  checkedAt: string
}

export type Review = {
  verdict: "satisfies" | "partial" | "off-brief"
  note: string
  model: string
  headSha: string
  at: string
}

export type AttemptStatus = "waiting" | "ready" | "shipped" | "parked" | "discarded" | "failed"

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
  /** A human parked or re-ran the attempt while a runner held it. */
  | "cancelled"

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
  previewUrl: string | null
  primary: Action
  secondary: Action[]
}

export type TaskView = {
  brief: Brief
  lane: Lane
  current: AttemptView
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
  project: ProjectSummary & { repo: string; seed: "starter" | "harbor" | "import"; previewUrl: string }
  lanes: { lane: Lane; tasks: TaskView[] }[]
  activity: Activity[]
  agents: AgentInfo[]
}

export type ClaimedJob = {
  attemptId: string
  projectId: string
  agent: string
  brief: Brief
  briefPath: string
  baseSha: string
  briefSha: string
  remote: string
  leaseExpiresAt: string
  attemptNumber: number
  previous?: { attemptId: string; reason: string | null }
}

export type GitCredentials = {
  remote: string
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

/** This mod's agent id. Headless runners offer `claude`; only this mod claims `claude-code`. */
export const AGENT_ID = "claude-code"
export const AGENT_LABEL = "Claude Code (interactive)"
