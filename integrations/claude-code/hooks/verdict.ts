// The board's verdict on one attempt, read out of a BoardView. Used by the push tool's result, the
// reminder Claude reads on later prompts, and the pane.

import type { Action, AttemptView, BoardView, Lane } from "./contract"

export type Verdict = {
  attempt: AttemptView
  task: string
  lane: Lane
  /** False once a re-run replaced this attempt. */
  isCurrent: boolean
  /** Absolute, or null before the agent pushed. */
  previewUrl: string | null
  version: number
}

export function verdictOf(board: BoardView, attemptId: string, baseUrl: string): Verdict | null {
  for (const { lane, tasks } of board.lanes) {
    for (const task of tasks) {
      const attempt = task.current.id === attemptId ? task.current : task.history.find((a) => a.id === attemptId)
      if (!attempt) continue
      return {
        attempt,
        task: task.brief.task,
        lane,
        isCurrent: attempt === task.current,
        previewUrl: absolute(attempt.previewUrl, baseUrl),
        version: board.version,
      }
    }
  }
  return null
}

export function actionLabel(action: Action): string {
  switch (action) {
    case "ship":
      return "Ship"
    case "ship-anyway":
      return "Ship anyway"
    case "rerun":
      return "Re-run"
    case "park":
      return "Park"
    case "unpark":
      return "Unpark"
    case "wait":
      return "Working"
    case "none":
      return "None"
  }
}

export function short(sha: string | null | undefined): string {
  return sha ? sha.slice(0, 7) : "-"
}

/** One line for the prompt reminder and the status bar. */
export function oneLine(v: Verdict): string {
  const a = v.attempt
  if (!v.isCurrent || a.status === "discarded") {
    return `this attempt was discarded${a.replacedBy ? ` and replaced by ${a.replacedBy}` : ""}${a.discardReason ? `: ${a.discardReason}` : "."} Stop working on it.`
  }
  if (a.status === "shipped") return `shipped as ${short(a.shippedSha)}. Nothing more to do.`
  if (a.status === "waiting") return "waiting for your first push."
  if (a.status === "parked") return "parked by a person."
  if (a.status === "failed") return "failed. A person can re-run it."
  const merge = a.merge?.state === "conflict" ? `conflicts with main in ${a.merge.paths.join(", ")}` : a.merge ? "merges cleanly" : "merge not checked yet"
  const digest = a.digest ? `; ${a.digest.summary}` : ""
  return `head ${short(a.headSha)} ${merge}${digest} Next: ${actionLabel(a.primary)} (a person decides).`
}

/** The full verdict, as the push tool returns it to Claude. */
export function verdictLines(v: Verdict): string[] {
  const a = v.attempt
  const lines = [`Board verdict for ${a.id} (attempt ${a.number}, head ${short(a.headSha)}, status ${a.status}):`]
  if (!v.isCurrent || a.status === "discarded") {
    lines.push(`- Discarded${a.replacedBy ? `, replaced by ${a.replacedBy}` : ""}. ${a.discardReason ?? ""}`.trimEnd())
    lines.push("- Stop: this attempt's diff will never be merged.")
    return lines
  }
  if (a.merge) {
    lines.push(
      a.merge.state === "clean"
        ? `- Merge: clean against main ${short(a.merge.mainSha)}.`
        : `- Merge: CONFLICT against main ${short(a.merge.mainSha)} in ${a.merge.paths.join(", ")}.`,
    )
  } else {
    lines.push("- Merge: not checked yet.")
  }
  if (a.digest) {
    lines.push(`- Digest: ${a.digest.summary} (satisfies: ${a.digest.satisfies})`)
    for (const check of a.digest.checks) lines.push(`  ${check.ok ? "pass" : "FAIL"}: contains ${check.path} "${check.text}"`)
    if (a.digest.unexpectedPaths.length > 0) lines.push(`  Not in the brief: ${a.digest.unexpectedPaths.join(", ")}`)
    if (a.digest.missedPaths.length > 0) lines.push(`  Brief paths not touched: ${a.digest.missedPaths.join(", ")}`)
    if (a.digest.controlPaths.length > 0) lines.push(`  Control paths changed: ${a.digest.controlPaths.join(", ")}`)
  }
  if (a.review) lines.push(`- Review (${a.review.model}): ${a.review.verdict}. ${a.review.note}`)
  if (v.previewUrl) lines.push(`- Preview: ${v.previewUrl}`)
  lines.push(`- Board action: ${actionLabel(a.primary)}. ${advice(a)}`)
  return lines
}

function advice(a: AttemptView): string {
  if (a.status === "shipped") return "It shipped."
  if (a.primary === "rerun") return "Do not resolve the conflict. Stop here: shipboard discards this diff and re-runs the brief on the new main."
  if (a.digest?.satisfies === "no") return "The digest says the brief is not met yet. Fix what failed and push again, or stop if you disagree."
  if (a.primary === "ship" || a.primary === "ship-anyway") return "A person decides whether it ships. You can stop, or push again if you see something to fix."
  return "The board has not assessed this head yet; it will."
}

function absolute(path: string | null, baseUrl: string): string | null {
  if (!path) return null
  try {
    return new URL(path, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`).href
  } catch {
    return null
  }
}
