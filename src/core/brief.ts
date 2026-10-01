/** The brief: validation, canonical bytes, and reading it back from a fork. */

import { assertSafeRel, briefPath } from "./names.ts"
import { PortError } from "./ports.ts"
import type { AgentInfo, Brief, DispatchInput } from "./types.ts"

export const LIMITS = {
  task: 240,
  constraints: 12,
  constraint: 240,
  paths: 20,
  acceptance: 2000,
} as const

export type BriefFields = Pick<Brief, "task" | "constraints" | "acceptance" | "paths">

function lines(value: unknown, split: RegExp, label: string): string[] {
  if (value === undefined || value === null) return []
  let source: unknown[]
  if (Array.isArray(value)) source = value
  else if (typeof value === "string") source = value.split(split)
  else throw new PortError(`Send ${label} as a list or as one per line.`, 400)
  const out: string[] = []
  for (const item of source) {
    if (typeof item !== "string") throw new PortError(`Each of the ${label} must be text.`, 400)
    const line = item.trim()
    if (line) out.push(line)
  }
  return out
}

/** Validates a dispatch against the limits in docs/ARCHITECTURE.md. Throws PortError 400. */
export function validateDispatch(input: DispatchInput, agents: AgentInfo[]): BriefFields & { agent: string } {
  if (!input || typeof input !== "object") throw new PortError("Send the brief as a JSON object.", 400)
  const task = typeof input.task === "string" ? input.task.replace(/\s+/g, " ").trim() : ""
  if (!task) throw new PortError("Write the task the agent should do.", 400)
  if (task.length > LIMITS.task) throw new PortError(`Keep the task to ${LIMITS.task} characters or fewer.`, 400)

  const constraints = lines(input.constraints, /\r?\n/, "constraints")
  if (constraints.length > LIMITS.constraints) {
    throw new PortError(`Use at most ${LIMITS.constraints} constraints.`, 400)
  }
  if (constraints.some((line) => line.length > LIMITS.constraint)) {
    throw new PortError(`Keep each constraint to ${LIMITS.constraint} characters or fewer.`, 400)
  }

  if (input.acceptance !== undefined && input.acceptance !== null && typeof input.acceptance !== "string") {
    throw new PortError("Write the acceptance check as text.", 400)
  }
  const acceptance = (input.acceptance ?? "").replace(/\r\n/g, "\n").trim()
  if (acceptance.length > LIMITS.acceptance) {
    throw new PortError(`Keep the acceptance check to ${LIMITS.acceptance} characters or fewer.`, 400)
  }

  const rawPaths = lines(input.paths, /[\r\n,]+/, "paths")
  if (rawPaths.length === 0) throw new PortError("Name at least one path the agent is expected to touch.", 400)
  if (rawPaths.length > LIMITS.paths) throw new PortError(`Name at most ${LIMITS.paths} paths.`, 400)
  const paths = [...new Set(rawPaths.map((path) => assertSafeRel(path, { allowDir: true })))]

  const agent = typeof input.agent === "string" ? input.agent.trim().toLowerCase() : ""
  if (!agent) throw new PortError("Pick an agent for this brief.", 400)
  if (!agents.some((known) => known.id === agent)) {
    throw new PortError(`There is no agent called "${agent.slice(0, 40)}". Pick one from the list.`, 400)
  }
  return { task, constraints, acceptance, paths, agent }
}

export function makeBrief(fields: BriefFields, meta: { id: string; createdAt: string; demo?: string }): Brief {
  const brief: Brief = {
    id: meta.id,
    task: fields.task,
    constraints: [...fields.constraints],
    acceptance: fields.acceptance,
    paths: [...fields.paths],
    createdAt: meta.createdAt,
  }
  if (meta.demo) brief.demo = meta.demo
  return brief
}

/** The exact text committed as the fork's first commit. Keys in a fixed order; `demo` only when set. */
export function canonicalBrief(brief: Brief): string {
  const ordered: Record<string, unknown> = {
    id: brief.id,
    task: brief.task,
    constraints: brief.constraints,
    acceptance: brief.acceptance,
    paths: brief.paths,
    createdAt: brief.createdAt,
  }
  if (brief.demo !== undefined) ordered.demo = brief.demo
  return `${JSON.stringify(ordered, null, 2)}\n`
}

export function briefBytes(brief: Brief): Uint8Array {
  return new TextEncoder().encode(canonicalBrief(brief))
}

export function briefFile(brief: Brief): { path: string; bytes: Uint8Array } {
  return { path: briefPath(brief.id), bytes: briefBytes(brief) }
}

export function bytesEqual(a: Uint8Array | null, b: Uint8Array | null): boolean {
  if (!a || !b || a.byteLength !== b.byteLength) return false
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false
  return true
}

/** Parses a committed brief. Returns null for anything that is not a well-formed brief. */
export function parseBrief(bytes: Uint8Array): Brief | null {
  let value: unknown
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
  } catch {
    return null
  }
  if (!value || typeof value !== "object") return null
  const v = value as Record<string, unknown>
  const strings = (x: unknown): x is string[] => Array.isArray(x) && x.every((s) => typeof s === "string")
  if (typeof v.id !== "string" || typeof v.task !== "string" || typeof v.acceptance !== "string") return null
  if (!strings(v.constraints) || !strings(v.paths) || typeof v.createdAt !== "string") return null
  if (v.demo !== undefined && typeof v.demo !== "string") return null
  return makeBrief(
    { task: v.task, constraints: v.constraints, acceptance: v.acceptance, paths: v.paths },
    { id: v.id, createdAt: v.createdAt, demo: v.demo },
  )
}
