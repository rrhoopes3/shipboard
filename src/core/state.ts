/** Lanes, the one button, activity and version rules. Pure functions over the stored model. */

import type { Action, Activity, Attempt, Lane, ProjectState } from "./types.ts"

export const LANES: readonly Lane[] = ["rerun", "ship", "review", "working", "parked", "shipped"]
export const ACTIVITY_CAP = 200
export const LEASE_MS = 3 * 60_000
export const MAX_REQUEUES = 3
export const RECONCILE_MS = 10_000
export const READ_TOKEN_TTL = 15 * 60
export const WRITE_TOKEN_TTL = 10 * 60
export const MANUAL_TOKEN_TTL = 60 * 60

export type Placement = { lane: Lane | null; primary: Action; secondary: Action[] }

function needsReview(attempt: Attempt): boolean {
  return (
    attempt.digest?.satisfies === "no" ||
    attempt.review?.verdict === "off-brief" ||
    (attempt.digest?.controlPaths.length ?? 0) > 0
  )
}

/** The lane table in docs/ARCHITECTURE.md, row for row. `discarded` has no lane. */
export function placement(attempt: Attempt): Placement {
  switch (attempt.status) {
    case "ready":
      if (!attempt.merge) return { lane: "working", primary: "wait", secondary: ["park"] }
      if (attempt.merge.state === "conflict") return { lane: "rerun", primary: "rerun", secondary: ["park"] }
      if (needsReview(attempt)) return { lane: "review", primary: "ship-anyway", secondary: ["park", "rerun"] }
      return { lane: "ship", primary: "ship", secondary: ["park", "rerun"] }
    case "failed":
      return { lane: "rerun", primary: "rerun", secondary: ["park"] }
    case "waiting":
      return { lane: "working", primary: "wait", secondary: ["park"] }
    case "parked":
      return { lane: "parked", primary: "unpark", secondary: ["rerun"] }
    case "shipped":
      return { lane: "shipped", primary: "none", secondary: [] }
    case "discarded":
      return { lane: null, primary: "none", secondary: [] }
  }
}

export function laneRank(lane: Lane): number {
  return LANES.indexOf(lane)
}

export function emptyCounts(): Record<Lane, number> {
  return { rerun: 0, ship: 0, review: 0, working: 0, parked: 0, shipped: 0 }
}

/** The live attempt of a brief: the newest one that was not discarded. */
export function currentAttempt(state: ProjectState, briefId: string): Attempt | undefined {
  let best: Attempt | undefined
  for (const attempt of state.attempts) {
    if (attempt.briefId !== briefId || attempt.status === "discarded") continue
    if (!best || attempt.number > best.number) best = attempt
  }
  if (best) return best
  // Every attempt discarded should not happen (a re-run makes the new one first); show the newest anyway.
  for (const attempt of state.attempts) {
    if (attempt.briefId === briefId && (!best || attempt.number > best.number)) best = attempt
  }
  return best
}

export function nextAttemptNumber(state: ProjectState, briefId: string): number {
  let max = 0
  for (const attempt of state.attempts) if (attempt.briefId === briefId) max = Math.max(max, attempt.number)
  return max + 1
}

export function pushActivity(state: ProjectState, entry: Omit<Activity, "at">, at: string): void {
  const activity: Activity = { at, kind: entry.kind, text: entry.text }
  if (entry.briefId) activity.briefId = entry.briefId
  if (entry.attemptId) activity.attemptId = entry.attemptId
  if (entry.agent) activity.agent = entry.agent
  state.activity.push(activity)
  if (state.activity.length > ACTIVITY_CAP) state.activity.splice(0, state.activity.length - ACTIVITY_CAP)
}

export function bumpVersion(state: ProjectState): number {
  state.version += 1
  return state.version
}

/** The part of the state that counts as a change. `reconciledAt` alone is bookkeeping. */
export function fingerprint(state: ProjectState): string {
  return JSON.stringify({ ...state, version: 0, reconciledAt: 0 })
}
