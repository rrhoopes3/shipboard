export type ForkStatus = "open" | "shipped" | "parked" | "superseded"

export type Action =
  | "ship"
  | "ship-anyway"
  | "rerun"
  | "wait"
  | "parked"
  | "shipped"
  | "superseded"

export type Brief = {
  task: string
  constraints: string[]
  acceptance: string
  paths: string[]
}

export type FileStat = {
  path: string
  additions: number
  deletions: number
}

export type Digest = {
  summary: string
  satisfies: "yes" | "no" | "unchecked"
  reasons: string[]
  files: FileStat[]
  unexpectedPaths: string[]
  missedPaths: string[]
  waiting: boolean
}

export type MergeReport = {
  state: "clean" | "conflict"
  paths: string[]
  checkedAt: string
}

export type ProjectRecord = {
  id: string
  name: string
  description: string
  createdAt: string
  mainSha: string
  seed: "starter" | "northline"
}

export type ForkRecord = {
  id: string
  projectId: string
  agent: string
  brief: Brief
  replay: string | null
  status: ForkStatus
  createdAt: string
  updatedAt: string
  headSha: string
  baseSha: string
  digest: Digest
  merge: MergeReport
  supersededBy: string | null
  parentForkId: string | null
}

export type ForkInput = {
  task?: unknown
  constraints?: unknown
  acceptance?: unknown
  paths?: unknown
  agent?: unknown
  message?: unknown
  files?: unknown
}
