/** Validation of the inputs that reach a project from outside: new projects and runner outcomes. */

import { PortError } from "./ports.ts"
import type { CreateProjectInput, JobOutcome, JobOutcomeReason } from "./types.ts"

export const OUTCOME_REASONS: readonly JobOutcomeReason[] = [
  "pushed",
  "no_changes",
  "agent_error",
  "timeout",
  "auth",
  "brief_mismatch",
  "unsafe_repo_config",
  "push_rejected",
  "lease_expired",
  "cancelled",
]

const SHA = /^[0-9a-f]{40}$/

export type ProjectFields = {
  name: string
  description: string
  seed: "starter" | "harbor"
  importUrl?: string
}

/** Validates CreateProjectInput. Hosts call this before choosing an id. */
export function validateCreateProject(input: CreateProjectInput): ProjectFields {
  if (!input || typeof input !== "object") throw new PortError("Send the project as a JSON object.", 400)
  const name = typeof input.name === "string" ? input.name.replace(/\s+/g, " ").trim() : ""
  if (!name) throw new PortError("Name the project.", 400)
  if (name.length > 60) throw new PortError("Keep the project name to 60 characters or fewer.", 400)
  if (input.description !== undefined && input.description !== null && typeof input.description !== "string") {
    throw new PortError("Write the description as text.", 400)
  }
  const description = (input.description ?? "").trim()
  if (description.length > 280) throw new PortError("Keep the description to 280 characters or fewer.", 400)
  if (input.seed !== undefined && input.seed !== "starter" && input.seed !== "harbor") {
    throw new PortError('Seed is "starter" or "harbor".', 400)
  }
  const seed = input.seed ?? "starter"
  if (input.importUrl === undefined || input.importUrl === null || input.importUrl === "") return { name, description, seed }
  if (typeof input.importUrl !== "string" || input.importUrl.length > 500) {
    throw new PortError("Give a public https git URL to import.", 400)
  }
  let url: URL
  try {
    url = new URL(input.importUrl.trim())
  } catch {
    throw new PortError("Give a public https git URL to import.", 400)
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new PortError("Give a public https git URL to import, with no credentials in it.", 400)
  }
  return { name, description, seed, importUrl: url.toString() }
}

/** Checks the shape of a runner's outcome and trims it to sane sizes. */
export function validateOutcome(input: unknown): JobOutcome {
  if (!input || typeof input !== "object") throw new PortError("Send the outcome as a JSON object.", 400)
  const v = input as Record<string, unknown>
  if (typeof v.reason !== "string" || !OUTCOME_REASONS.includes(v.reason as JobOutcomeReason)) {
    throw new PortError(`Outcome reason must be one of ${OUTCOME_REASONS.join(", ")}.`, 400)
  }
  const summary = typeof v.summary === "string" ? v.summary.trim().slice(0, 2000) : ""
  const outcome: JobOutcome = { reason: v.reason as JobOutcomeReason, summary }
  if (typeof v.commitSha === "string" && SHA.test(v.commitSha)) outcome.commitSha = v.commitSha
  if (Array.isArray(v.changedPaths)) {
    outcome.changedPaths = v.changedPaths
      .filter((p): p is string => typeof p === "string")
      .slice(0, 200)
      .map((p) => p.slice(0, 300))
  }
  for (const key of ["costUsd", "turns", "durationMs"] as const) {
    const n = v[key]
    if (typeof n === "number" && Number.isFinite(n) && n >= 0) outcome[key] = n
  }
  if (typeof v.sessionId === "string") outcome.sessionId = v.sessionId.slice(0, 200)
  return outcome
}
