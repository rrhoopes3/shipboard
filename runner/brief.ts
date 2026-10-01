import type { Brief } from "../src/core/types.ts"

/**
 * The brief file bytes, exactly as docs/ARCHITECTURE.md "Names" defines them. The runner compares the
 * file committed at the brief commit against this, so a claim cannot smuggle in a different task.
 */
export function canonicalBriefJson(brief: Brief): string {
  const ordered: Record<string, unknown> = {
    id: brief.id,
    task: brief.task,
    constraints: brief.constraints,
    acceptance: brief.acceptance,
    paths: brief.paths,
    createdAt: brief.createdAt,
  }
  if (brief.demo !== undefined) ordered.demo = brief.demo
  return JSON.stringify(ordered, null, 2) + "\n"
}

export function briefPathFor(briefId: string): string {
  return `.shipboard/briefs/${briefId}.json`
}

/** The project id is the part of an attempt id before `--`. */
export function projectIdOf(attemptId: string): string {
  const index = attemptId.indexOf("--")
  return index === -1 ? attemptId : attemptId.slice(0, index)
}
